import type {
  AIResearchPacket,
  AIResearchReportCandidate,
  InvestmentHorizonMonths,
  StructuredResearchFinding,
  ValuationCandidate,
} from "../../shared/aiResearch";
import { buildAIResearchFindingCatalog } from "./aiResearchFindingCatalog";
import { deriveServerInvestmentVerdict } from "./aiResearchVerdictPolicy";

type UnknownRecord = Record<string, unknown>;
type SelectionValuation = Omit<ValuationCandidate, "horizonMonths">;
type ParsedSelection = {
  selectedFindingIds: string[];
  horizonMonths: InvestmentHorizonMonths;
  confidence: number;
  aiConfidence: number | null;
  investmentCertainty: number | null;
  valuation: SelectionValuation;
};

export class AIResearchSelectionContractError extends Error {}

const record = (value: unknown): UnknownRecord | null => value !== null && typeof value === "object"
  && !Array.isArray(value) ? value as UnknownRecord : null;
const stringArray = (value: unknown): value is string[] => Array.isArray(value)
  && value.every((item) => typeof item === "string");
const exactKeys = (item: UnknownRecord, allowed: readonly string[], path: string): void => {
  const unknown = Object.keys(item).find((key) => !allowed.includes(key));
  if (unknown) throw new AIResearchSelectionContractError(`selection_unknown_field:${path}${unknown}`);
};
const finiteRatio = (value: unknown): value is number => typeof value === "number"
  && Number.isFinite(value) && value >= 0 && value <= 1;

function valuation(value: unknown): SelectionValuation {
  const item = record(value);
  if (!item) throw new AIResearchSelectionContractError("selection_invalid_valuation");
  exactKeys(item, ["method", "currentPriceEvidenceId", "metricEvidenceId", "scenarios"], "valuation.");
  const scenarios = record(item.scenarios);
  if (!["PE", "PB"].includes(String(item.method)) || typeof item.currentPriceEvidenceId !== "string"
    || typeof item.metricEvidenceId !== "string" || !scenarios) {
    throw new AIResearchSelectionContractError("selection_invalid_valuation");
  }
  exactKeys(scenarios, ["conservative", "base", "optimistic"], "valuation.scenarios.");
  for (const name of ["conservative", "base", "optimistic"]) {
    const scenario = record(scenarios[name]);
    if (!scenario) throw new AIResearchSelectionContractError(`selection_invalid_valuation:${name}`);
    exactKeys(scenario, ["multiple"], `valuation.scenarios.${name}.`);
    if (typeof scenario.multiple !== "number" || !Number.isFinite(scenario.multiple)) {
      throw new AIResearchSelectionContractError(`selection_invalid_valuation:${name}`);
    }
  }
  return item as unknown as SelectionValuation;
}

function parseSelection(value: unknown): ParsedSelection {
  const item = record(value);
  if (!item) throw new AIResearchSelectionContractError("selection_invalid_root");
  exactKeys(item, ["schemaVersion", "selectedFindingIds", "horizonMonths", "confidence",
    "aiConfidence", "investmentCertainty", "valuation"], "");
  const horizon = item.horizonMonths as InvestmentHorizonMonths;
  if (item.schemaVersion !== 2 || !stringArray(item.selectedFindingIds) || ![3, 6, 12].includes(horizon)
    || !finiteRatio(item.confidence) || !(item.aiConfidence === null || finiteRatio(item.aiConfidence))
    || !(item.investmentCertainty === null || finiteRatio(item.investmentCertainty))) {
    throw new AIResearchSelectionContractError("selection_invalid_root");
  }
  if (new Set(item.selectedFindingIds).size !== item.selectedFindingIds.length) {
    throw new AIResearchSelectionContractError("selection_duplicate_finding");
  }
  return { selectedFindingIds: item.selectedFindingIds, horizonMonths: horizon,
    confidence: item.confidence, aiConfidence: item.aiConfidence, investmentCertainty: item.investmentCertainty,
    valuation: valuation(item.valuation) };
}

function resolveFindings(ids: string[], packet: AIResearchPacket): StructuredResearchFinding[] {
  const catalog = new Map(buildAIResearchFindingCatalog(packet).map((finding) => [finding.id, finding]));
  return ids.map((id) => {
    const finding = catalog.get(id);
    if (!finding) throw new AIResearchSelectionContractError(`selection_finding_not_found:${id}`);
    return finding;
  });
}

function deriveBaseReturn(value: SelectionValuation, packet: AIResearchPacket): number {
  const registry = new Map(packet.evidence.map((item) => [item.id, item]));
  const price = registry.get(value.currentPriceEvidenceId);
  const metric = registry.get(value.metricEvidenceId);
  const expectedField = value.method === "PE" ? "fundamentals.metrics.eps" : "fundamentals.metrics.bvps";
  if (price?.field !== "market.price" || !price.available || typeof price.value !== "number" || price.value <= 0
    || metric?.field !== expectedField || !metric.available || typeof metric.value !== "number" || metric.value <= 0) {
    throw new AIResearchSelectionContractError("selection_valuation_evidence_invalid");
  }
  const baseReturn = (metric.value * value.scenarios.base.multiple - price.value) / price.value;
  if (!Number.isFinite(baseReturn)) throw new AIResearchSelectionContractError("selection_valuation_result_invalid");
  return baseReturn;
}

function partitions(findings: StructuredResearchFinding[]) {
  const risks = findings.filter((item) => item.kind === "limitation" || item.stance === "insufficient"
    || (item.kind === "trade_risk" && item.stance === "negative")).map((item) => item.id);
  const riskSet = new Set(risks);
  return { positive: findings.filter((item) => item.stance === "positive" && !riskSet.has(item.id))
    .map((item) => item.id),
  negative: findings.filter((item) => item.stance === "negative" && !riskSet.has(item.id))
    .map((item) => item.id),
  limitations: findings.filter((item) => item.kind === "limitation").map((item) => item.id), risks };
}

export function hydrateAIResearchSelection(value: unknown, packet: AIResearchPacket): AIResearchReportCandidate {
  const selected = parseSelection(value);
  const findings = resolveFindings(selected.selectedFindingIds, packet);
  const registry = new Map(packet.evidence.map((item) => [item.id, item]));
  const stances = new Map(findings.map((finding) => [finding.id, finding.stance]));
  const verdict = deriveServerInvestmentVerdict(deriveBaseReturn(selected.valuation, packet),
    findings, stances, registry);
  const groups = partitions(findings);
  const conclusionVerdict = { BUY: "positive", HOLD: "neutral", SELL: "negative" } as const;
  const supporting = verdict === "SELL" ? groups.negative : groups.positive;
  const opposing = verdict === "SELL" ? groups.positive : groups.negative;
  const citations = [...new Set(findings.flatMap((finding) => finding.fragments
    .map((fragment) => fragment.evidenceId)))].sort();
  return { schemaVersion: 1, stockId: packet.stockId, asOf: packet.asOf,
    contextFingerprint: packet.contextFingerprint, dataQuality: structuredClone(packet.dataQuality), findings,
    conclusion: { verdict: conclusionVerdict[verdict], supportingFindingIds: supporting,
      opposingFindingIds: opposing, limitationFindingIds: groups.limitations,
      aiConfidence: selected.aiConfidence, investmentCertainty: selected.investmentCertainty },
    citations, recommendation: { verdict, horizonMonths: selected.horizonMonths,
      confidence: selected.confidence, supportingFindingIds: supporting,
      opposingFindingIds: opposing, riskFindingIds: groups.risks },
    valuation: { ...selected.valuation, horizonMonths: selected.horizonMonths } };
}

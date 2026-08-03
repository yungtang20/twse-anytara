import type {
  AIResearchPacket,
  InvestmentConclusionEvaluation,
  InvestmentHorizonMonths,
  InvestmentRecommendationCandidate,
  InvestmentVerdict,
  ServerCalculatedValuation,
  ServerCalculatedValuationScenario,
  ServerInvestmentRecommendation,
  StructuredResearchConclusion,
  ValuationCandidate,
  ValuationMethod,
} from "../../shared/aiResearch";
import type { ValidatedResearchFindingRuntime } from "./aiResearchFindingPolicy";
import { resolveResearchEvidenceRegistry } from "./aiResearchFindingPolicy";
import { deriveServerInvestmentVerdict } from "./aiResearchVerdictPolicy";
import { normalizeCanonicalResearchNumber, validateResearchNumber } from "./aiResearchNumericPolicy";

type UnknownRecord = Record<string, unknown>;
const RECOMMENDATION_KEYS = new Set(["verdict", "horizonMonths", "confidence", "supportingFindingIds", "opposingFindingIds", "riskFindingIds"]);
const VALUATION_KEYS = new Set(["method", "horizonMonths", "currentPriceEvidenceId", "metricEvidenceId", "scenarios"]);
const SCENARIO_KEYS = new Set(["conservative", "base", "optimistic"]);
const LABELS = { BUY: "買進", HOLD: "持有", SELL: "賣出", INSUFFICIENT_DATA: "資料不足" } as const;
const MULTIPLE_LIMITS: Record<ValuationMethod, number> = { PE: 100, PB: 20 };

const record = (value: unknown): UnknownRecord | null => value !== null && typeof value === "object"
  && !Array.isArray(value) ? value as UnknownRecord : null;
const stringArray = (value: unknown): value is string[] => Array.isArray(value)
  && value.every((item) => typeof item === "string");
const uniqueSorted = (values: string[]) => [...new Set(values)].sort();
const horizon = (value: unknown): value is InvestmentHorizonMonths => value === 3 || value === 6 || value === 12;

function canonical(value: string): string {
  return value.normalize("NFKC").replace(/[\p{Cc}\p{Cf}\p{Z}\p{P}\p{S}\s]/gu, "").toUpperCase();
}

function detectSmuggling(value: unknown, path = "candidate", errors: string[] = []): string[] {
  if (Array.isArray(value)) value.forEach((item, index) => detectSmuggling(item, `${path}.${index}`, errors));
  else {
    const itemRecord = record(value);
    if (itemRecord) for (const [key, item] of Object.entries(itemRecord)) {
    if (/^(?:targetPrice|expectedReturn|expectedReturnRatio|expectedReturnPercent|currentPrice)$/i.test(key)) {
      errors.push(`investment_candidate_calculated_field_forbidden:${path}.${key}`);
    }
    detectSmuggling(item, `${path}.${key}`, errors);
    } else if (typeof value === "string" && /(?:目標價|預期報酬)/.test(canonical(value))) {
      errors.push(`investment_candidate_calculated_value_smuggling:${path}`);
    }
  }
  return errors;
}

function parseRecommendation(value: unknown, errors: string[]): InvestmentRecommendationCandidate | null {
  const item = record(value);
  if (!item) { errors.push("invalid_investment_recommendation"); return null; }
  for (const key of Object.keys(item)) if (!RECOMMENDATION_KEYS.has(key)) errors.push(`recommendation_unknown_field:${key}`);
  if (!["BUY", "HOLD", "SELL", "INSUFFICIENT_DATA"].includes(String(item.verdict)) || !horizon(item.horizonMonths)
    || !stringArray(item.supportingFindingIds) || !stringArray(item.opposingFindingIds) || !stringArray(item.riskFindingIds)) {
    errors.push("invalid_investment_recommendation"); return null;
  }
  if (typeof item.confidence !== "number") { errors.push("recommendation_invalid_confidence"); return null; }
  let confidence = item.confidence;
  try { confidence = validateResearchNumber({ path: "report.recommendation.confidence", field: "report.recommendation.confidence",
    unit: "ratio", value: item.confidence }).value; } catch { errors.push("recommendation_invalid_confidence"); }
  return { ...item, confidence } as unknown as InvestmentRecommendationCandidate;
}

function findingDomain(item: ValidatedResearchFindingRuntime): string {
  const kind = item.finding.kind;
  if (kind === "company_fact" || kind === "market_snapshot") return "market";
  if (kind === "financial_metric") return "financials";
  if (kind === "institutional_flow") return "institutional";
  if (kind === "tdcc_concentration") return "tdcc";
  if (kind === "trade_risk") return "risk";
  if (kind === "strategy_result") return "strategy";
  return kind;
}

function validateRecommendation(candidate: InvestmentRecommendationCandidate,
  findings: readonly ValidatedResearchFindingRuntime[], richness: AIResearchPacket["dataQuality"]["informationRichness"],
  errors: string[]): ServerInvestmentRecommendation {
  const known = new Map(findings.map((item) => [item.finding.id, item]));
  const lists = [candidate.supportingFindingIds, candidate.opposingFindingIds, candidate.riskFindingIds];
  const all = lists.flat();
  for (const id of all.filter((item, index) => all.indexOf(item) !== index)) errors.push(`recommendation_duplicate_finding:${id}`);
  for (const id of all) if (!known.has(id)) errors.push(`recommendation_finding_not_found:${id}`);
  const supportStance = candidate.verdict === "SELL" ? "negative" : "positive";
  for (const id of candidate.supportingFindingIds) {
    const finding = known.get(id)?.finding;
    if (!finding || finding.stance !== supportStance || finding.kind === "limitation") errors.push(`recommendation_invalid_supporting_stance:${id}`);
  }
  for (const id of candidate.opposingFindingIds) {
    const finding = known.get(id)?.finding;
    const expected = candidate.verdict === "SELL" ? "positive" : "negative";
    if (!finding || finding.stance !== expected || finding.kind === "limitation") errors.push(`recommendation_invalid_opposing_stance:${id}`);
  }
  for (const id of candidate.riskFindingIds) {
    const finding = known.get(id)?.finding;
    if (!finding || !(["negative", "insufficient"].includes(finding.stance)
      || finding.kind === "limitation" || finding.kind === "trade_risk")) errors.push(`recommendation_invalid_risk_stance:${id}`);
  }
  if (richness === "C" && candidate.verdict !== "INSUFFICIENT_DATA") errors.push("recommendation_richness_c_requires_insufficient_data");
  if (candidate.verdict === "INSUFFICIENT_DATA") {
    if (!candidate.riskFindingIds.some((id) => known.get(id)?.finding.kind === "limitation")) errors.push("recommendation_insufficient_data_requires_limitation");
  } else if (candidate.verdict === "HOLD") {
    if (all.length === 0) errors.push("recommendation_hold_evidence_required");
  } else {
    if (candidate.supportingFindingIds.length === 0) errors.push(`recommendation_supporting_findings_required:${candidate.verdict}`);
    if (candidate.supportingFindingIds.length < 2) errors.push(`recommendation_directional_support_minimum:${candidate.verdict}`);
    const domains = new Set(candidate.supportingFindingIds.map((id) => known.get(id)).filter(Boolean)
      .map((item) => findingDomain(item!)));
    if (domains.size < 2) errors.push(`recommendation_domain_coverage_insufficient:${candidate.verdict}`);
  }
  return { ...candidate, label: LABELS[candidate.verdict] };
}

function parseValuation(value: unknown, errors: string[]): ValuationCandidate | null {
  if (value === null || value === undefined) return null;
  const item = record(value);
  if (!item) { errors.push("invalid_valuation_candidate"); return null; }
  for (const key of Object.keys(item)) if (!VALUATION_KEYS.has(key)) errors.push(`valuation_unknown_field:${key}`);
  const scenarios = record(item.scenarios);
  if (!(["PE", "PB"].includes(String(item.method))) || !horizon(item.horizonMonths)
    || typeof item.currentPriceEvidenceId !== "string" || typeof item.metricEvidenceId !== "string"
    || !scenarios || Object.keys(scenarios).some((key) => !SCENARIO_KEYS.has(key))) {
    errors.push("invalid_valuation_candidate"); return null;
  }
  let valid = true;
  for (const name of SCENARIO_KEYS) {
    const scenario = record(scenarios[name]);
    if (!scenario || Object.keys(scenario).length !== 1 || typeof scenario.multiple !== "number") {
      errors.push(`valuation_invalid_scenario:${name}`);
      valid = false;
    }
  }
  return valid ? item as unknown as ValuationCandidate : null;
}

function annualEpsPeriod(period: string): boolean {
  return period === "TTM" || /^\d{4}(?:-FY)?$/.test(period)
    || /^FY\d{4}$/.test(period) || /^\d{4}-12-31$/.test(period);
}

function validateMultiples(candidate: ValuationCandidate, errors: string[]): number[] {
  const names = ["conservative", "base", "optimistic"] as const;
  const multiples = names.map((name) => candidate.scenarios[name].multiple);
  multiples.forEach((multiple, index) => {
    const name = names[index];
    try { validateResearchNumber({ path: `report.valuation.scenarios.${name}.multiple`,
      field: `report.valuation.scenarios.${name}.multiple`, unit: "ratio", value: multiple }); }
    catch { errors.push(`valuation_multiple_non_finite:${name}`); return; }
    if (multiple <= 0 || multiple > MULTIPLE_LIMITS[candidate.method]) errors.push(`valuation_multiple_out_of_range:${name}`);
  });
  if (multiples.every(Number.isFinite) && !(multiples[0] <= multiples[1] && multiples[1] <= multiples[2])) {
    errors.push("valuation_multiple_order_invalid");
  }
  return multiples;
}

function calculateValuation(candidate: ValuationCandidate, packet: AIResearchPacket,
  errors: string[]): ServerCalculatedValuation | null {
  let registry: Map<string, AIResearchPacket["evidence"][number]>;
  try { registry = resolveResearchEvidenceRegistry(packet); }
  catch (error) { errors.push(error instanceof Error ? error.message : "valuation_evidence_registry_invalid"); return null; }
  const priceEvidence = registry.get(candidate.currentPriceEvidenceId);
  if (!priceEvidence) errors.push(`valuation_current_price_evidence_not_found:${candidate.currentPriceEvidenceId}`);
  else if (priceEvidence.field !== "market.price" || priceEvidence.dataset !== "stock_price") errors.push("valuation_current_price_evidence_mismatch");
  else if (!priceEvidence.available || typeof priceEvidence.value !== "number") errors.push("valuation_current_price_unavailable");
  else if (priceEvidence.value <= 0) errors.push("valuation_current_price_must_be_positive");
  else if (priceEvidence.estimated) errors.push("valuation_current_price_estimated");
  const metricEvidence = registry.get(candidate.metricEvidenceId);
  if (!metricEvidence) errors.push(`valuation_metric_evidence_not_found:${candidate.metricEvidenceId}`);
  const expectedKey = candidate.method === "PE" ? "eps" : "bvps";
  if (metricEvidence && metricEvidence.field !== `fundamentals.metrics.${expectedKey}`) errors.push(`valuation_metric_mismatch:${candidate.method}`);
  const metric = packet.fundamentals.metrics.find((item) => item.key.toLowerCase() === expectedKey
    && item.sourceId === metricEvidence?.sourceId && item.period === metricEvidence.date);
  if (!metricEvidence?.available || typeof metricEvidence?.value !== "number" || !metric?.available || metric.value === null) {
    errors.push("valuation_metric_unavailable");
  } else if (metricEvidence.value <= 0) errors.push("valuation_metric_must_be_positive");
  if (packet.dataQuality.staleDatasets.includes(metricEvidence?.dataset ?? "financials")) errors.push("valuation_metric_stale");
  if (!metric?.period || !metric.sourceId) errors.push("valuation_metric_period_or_source_required");
  else if (candidate.method === "PE" && !annualEpsPeriod(metric.period)) errors.push("valuation_metric_annual_period_required:EPS");
  if (!packet.asOf) errors.push("valuation_as_of_required");
  const sources = new Map(packet.sources.map((source) => [source.id, source]));
  const priceSource = priceEvidence ? sources.get(priceEvidence.sourceId) : undefined;
  const staleDatasets = new Set(packet.dataQuality.staleDatasets);
  if (priceEvidence && (staleDatasets.has(priceEvidence.dataset) || staleDatasets.has(priceEvidence.sourceId)
    || Boolean(priceSource && (staleDatasets.has(priceSource.dataset) || staleDatasets.has(priceSource.id))))) {
    errors.push("valuation_current_price_stale");
  }
  if (priceEvidence && sources.get(priceEvidence.sourceId)?.status !== "available") errors.push("valuation_current_price_source_unavailable");
  if (metricEvidence && sources.get(metricEvidence.sourceId)?.status !== "available") errors.push("valuation_metric_source_unavailable");
  const names = ["conservative", "base", "optimistic"] as const;
  const multiples = validateMultiples(candidate, errors);
  if (errors.some((error) => error.startsWith("valuation_")) || !priceEvidence || !metricEvidence || !metric || !packet.asOf) return null;
  const currentPrice = priceEvidence.value as number;
  const metricValue = metricEvidence.value as number;
  const scenarios: ServerCalculatedValuationScenario[] = names.map((name, index) => {
    const multiple = multiples[index];
    const targetPrice = normalizeCanonicalResearchNumber(`report.valuation.scenarios.${name}.targetPrice`, metricValue * multiple);
    const expectedReturnRatio = normalizeCanonicalResearchNumber(`report.valuation.scenarios.${name}.expectedReturnRatio`,
      (targetPrice - currentPrice) / currentPrice);
    return { name, multiple, targetPrice, expectedReturnRatio,
      expectedReturnPercent: normalizeCanonicalResearchNumber(`report.valuation.scenarios.${name}.expectedReturnPercent`, expectedReturnRatio * 100) };
  });
  if (!(scenarios[0].targetPrice <= scenarios[1].targetPrice && scenarios[1].targetPrice <= scenarios[2].targetPrice)) {
    errors.push("valuation_target_price_order_invalid"); return null;
  }
  return { method: candidate.method, asOf: packet.asOf, currentPrice,
    metric: { name: candidate.method === "PE" ? "EPS" : "BVPS", value: metricValue,
      period: metric.period!, sourceId: metric.sourceId!, estimated: metricEvidence.estimated }, scenarios };
}

export function evaluateInvestmentConclusion(candidate: unknown, packet: AIResearchPacket,
  findings: readonly ValidatedResearchFindingRuntime[],
  conclusionVerdict?: StructuredResearchConclusion["verdict"]): InvestmentConclusionEvaluation {
  const errors = detectSmuggling(candidate);
  const root = record(candidate);
  if (!root) return { recommendation: null, valuation: null, errors: ["invalid_investment_candidate"] };
  for (const key of Object.keys(root)) if (!new Set(["recommendation", "valuation"]).has(key)) {
    errors.push(`investment_candidate_unknown_field:${key}`);
  }
  const parsedRecommendation = parseRecommendation(root.recommendation, errors);
  if (parsedRecommendation && conclusionVerdict) {
    const expected: Record<StructuredResearchConclusion["verdict"], InvestmentVerdict> = {
      positive: "BUY", neutral: "HOLD", negative: "SELL", "insufficient-data": "INSUFFICIENT_DATA",
    };
    if (parsedRecommendation.verdict !== expected[conclusionVerdict]) {
      errors.push(`recommendation_conclusion_verdict_mismatch:${parsedRecommendation.verdict}:${conclusionVerdict}`);
    }
  }
  const recommendation = parsedRecommendation
    ? validateRecommendation(parsedRecommendation, findings, packet.dataQuality.informationRichness, errors) : null;
  const parsedValuation = parseValuation(root.valuation, errors);
  if (recommendation?.verdict === "INSUFFICIENT_DATA" && parsedValuation) errors.push("valuation_forbidden_for_insufficient_data");
  const valuation = parsedValuation ? calculateValuation(parsedValuation, packet, errors) : null;
  if (recommendation && parsedValuation && recommendation.horizonMonths !== parsedValuation.horizonMonths) {
    errors.push("valuation_horizon_mismatch");
  }
  const baseReturn = valuation?.scenarios.find((scenario) => scenario.name === "base")?.expectedReturnRatio;
  if (recommendation?.verdict === "BUY" && baseReturn !== undefined && baseReturn <= 0) errors.push("recommendation_base_return_direction_mismatch:BUY");
  if (recommendation?.verdict === "SELL" && baseReturn !== undefined && baseReturn >= 0) errors.push("recommendation_base_return_direction_mismatch:SELL");
  if (recommendation?.verdict === "HOLD") {
    const byId = new Map(findings.map((item) => [item.finding.id, item.finding]));
    const hasPositive = recommendation.supportingFindingIds.some((id) => byId.get(id)?.stance === "positive");
    const hasNegative = [...recommendation.opposingFindingIds, ...recommendation.riskFindingIds]
      .some((id) => byId.get(id)?.stance === "negative");
    const nearNeutral = baseReturn !== undefined && Math.abs(baseReturn) <= 0.05;
    let serverPolicyHold = false;
    if (baseReturn !== undefined) {
      try {
        const registry = resolveResearchEvidenceRegistry(packet);
        const stances = new Map(findings.map((item) => [item.finding.id, item.finding.stance]));
        serverPolicyHold = deriveServerInvestmentVerdict(baseReturn,
          findings.map((item) => item.finding), stances, registry) === "HOLD";
      } catch { serverPolicyHold = false; }
    }
    if (!(hasPositive && hasNegative) && !nearNeutral && !serverPolicyHold) {
      errors.push("recommendation_hold_balance_required");
    }
  }
  return { recommendation: errors.length === 0 ? recommendation : null,
    valuation: errors.length === 0 ? valuation : null, errors: uniqueSorted(errors) };
}

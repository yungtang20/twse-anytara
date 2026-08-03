import type {
  AIResearchPacket,
  ResearchEvidence,
  ResearchFindingStance,
  StructuredResearchFinding,
} from "../../shared/aiResearch";
import { validateResearchFindingRuntime } from "./aiResearchFindingPolicy";

function idPart(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24) || "value";
}

function availableEvidence(packet: AIResearchPacket): ResearchEvidence[] {
  const availableSources = new Set(packet.sources.filter((source) => source.status === "available")
    .map((source) => source.id));
  return packet.evidence.filter((item) => item.available && item.value !== null
    && availableSources.has(item.sourceId));
}

function stanceFor(kind: StructuredResearchFinding["kind"], value: unknown): ResearchFindingStance {
  if (kind === "institutional_flow") {
    return typeof value === "number" && value > 0 ? "positive"
      : typeof value === "number" && value < 0 ? "negative" : "neutral";
  }
  if (kind === "strategy_result") {
    return value === "BUY" ? "positive" : value === "SELL" ? "negative"
      : value === "UNKNOWN" ? "insufficient" : "neutral";
  }
  if (kind === "trade_risk") return value === "none" ? "neutral" : "negative";
  return "neutral";
}

function single(id: string, kind: StructuredResearchFinding["kind"], evidence: ResearchEvidence,
  role: "subject" | "value" | "risk", format: "label" | "value_with_unit"): StructuredResearchFinding {
  return { id, kind, stance: stanceFor(kind, evidence.value),
    fragments: [{ evidenceId: evidence.id, role, format }] };
}

function dated(id: string, kind: StructuredResearchFinding["kind"], value: ResearchEvidence,
  date: ResearchEvidence, strategyId?: StructuredResearchFinding["strategyId"]): StructuredResearchFinding {
  return { id, kind, stance: stanceFor(kind, value.value), ...(strategyId ? { strategyId } : {}), fragments: [
    { evidenceId: value.id, role: kind === "strategy_result" ? "subject" : "value",
      format: kind === "strategy_result" ? "label" : "value_with_unit" },
    { evidenceId: date.id, role: "date", format: "date" },
  ] };
}

function fixedCandidates(evidence: ResearchEvidence[]): StructuredResearchFinding[] {
  const byField = new Map(evidence.map((item) => [item.field, item]));
  const findings: StructuredResearchFinding[] = [];
  const price = byField.get("market.price");
  const marketDate = byField.get("market.latestDate");
  if (price && marketDate) findings.push(dated("f:market:price", "market_snapshot", price, marketDate));
  for (const item of evidence.filter((entry) => /^fundamentals\.metrics\.(?:eps|bvps)$/.test(entry.field))) {
    findings.push(single(`f:financial:${idPart(item.field.split(".").at(-1) ?? item.id)}`,
      "financial_metric", item, "value", "value_with_unit"));
  }
  const risk = byField.get("tradeRisks.highestLevel");
  if (risk) findings.push(single("f:risk:highest", "trade_risk", risk, "risk", "label"));
  return findings;
}

function institutionalCandidates(evidence: ResearchEvidence[]): StructuredResearchFinding[] {
  const byField = new Map(evidence.map((item) => [item.field, item]));
  const latestDate = evidence.filter((item) => /^institutional\.\d{4}-\d{2}-\d{2}\.date$/.test(item.field))
    .map((item) => String(item.value)).sort().at(-1);
  if (!latestDate) return [];
  return evidence.filter((item) => item.field.startsWith(`institutional.${latestDate}.`)
    && /\.institutionalNet$/.test(item.field))
    .flatMap((item) => {
      const date = byField.get(item.field.replace(/\.[^.]+$/, ".date"));
      const identity = item.field.split(".").at(-1) ?? item.id;
      return date ? [dated(`f:institutional:${String(item.date)}:${idPart(identity)}`,
        "institutional_flow", item, date)] : [];
    });
}

function tdccCandidates(evidence: ResearchEvidence[]): StructuredResearchFinding[] {
  const date = evidence.find((item) => item.field === "tdcc.date");
  if (!date) return [];
  return evidence.filter((item) => item.field === "tdcc.whaleRatio")
    .map((item) => dated(`f:tdcc:${idPart(item.field)}`, "tdcc_concentration", item, date));
}

function strategyCandidates(evidence: ResearchEvidence[]): StructuredResearchFinding[] {
  const byField = new Map(evidence.map((item) => [item.field, item]));
  return (["sr", "ma", "chips", "pattern"] as const).flatMap((strategyId) => {
    const value = byField.get(`strategies.${strategyId}.signal`);
    const date = byField.get(`strategies.${strategyId}.date`);
    return value && date ? [dated(`f:strategy:${strategyId}`, "strategy_result", value, date, strategyId)] : [];
  });
}

export function buildAIResearchFindingCatalog(packet: AIResearchPacket): StructuredResearchFinding[] {
  const evidence = availableEvidence(packet);
  const candidates = [...fixedCandidates(evidence), ...institutionalCandidates(evidence),
    ...tdccCandidates(evidence), ...strategyCandidates(evidence)];
  const valid: StructuredResearchFinding[] = [];
  for (const candidate of candidates) {
    try { valid.push(validateResearchFindingRuntime(candidate, packet).finding); } catch { /* fail closed */ }
  }
  return valid.sort((left, right) => left.id.localeCompare(right.id));
}

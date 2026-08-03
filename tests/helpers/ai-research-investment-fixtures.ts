import type {
  AIResearchPacket,
  StructuredResearchFinding,
} from "../../shared/aiResearch.js";
import type { ValidatedResearchFindingRuntime } from "../../server/lib/aiResearchFindingPolicy.js";
import { buildResearchPacket } from "../../server/lib/aiResearchPacket.js";
import { ResearchContextAggregator } from "../../server/lib/researchContext.js";
import { createResearchContextAdapter } from "./research-context-fixtures.js";

export async function investmentPacket(): Promise<AIResearchPacket> {
  const context = await new ResearchContextAggregator(createResearchContextAdapter(), {
    clock: () => new Date("2026-08-02T03:04:05.000Z"), asOfDate: "2026-07-31",
  }).aggregate("2330");
  const packet = structuredClone(buildResearchPacket(context));
  packet.market.price = 100;
  packet.dataQuality.informationRichness = "B";
  packet.dataQuality.missingDatasets = [];
  packet.dataQuality.staleDatasets = [];
  packet.fundamentals = { status: "complete", missing: [], metrics: [
    { key: "eps", value: 10, available: true, unit: "TWD", period: "2025-12-31", sourceId: "finmind:financials" },
    { key: "bvps", value: 50, available: true, unit: "TWD", period: "2026-06-30", sourceId: "finmind:financials" },
  ] };
  const price = packet.evidence.find((item) => item.field === "market.price");
  const eps = packet.evidence.find((item) => item.field === "fundamentals.metrics.eps");
  if (!price || !eps) throw new Error("investment_fixture_evidence_missing");
  Object.assign(price, { value: 100, available: true, estimated: false });
  Object.assign(eps, { value: 10, available: true, estimated: false, date: "2025-12-31",
    sourceId: "finmind:financials" });
  packet.evidence.push({ id: "ev:bvps", dataset: "financials", field: "fundamentals.metrics.bvps",
    value: 50, unit: "TWD", date: "2026-06-30", sourceId: "finmind:financials",
    estimated: false, available: true });
  return packet;
}

function runtime(id: string, kind: StructuredResearchFinding["kind"],
  stance: StructuredResearchFinding["stance"]): ValidatedResearchFindingRuntime {
  return { finding: { id, kind, stance, fragments: [] }, renderedClaim: {
    id, kind, stance, text: id, evidenceIds: [], limitations: kind === "limitation" ? [id] : [], estimated: false,
  } };
}

export function investmentFindings(): ValidatedResearchFindingRuntime[] {
  return [
    runtime("financial-positive", "financial_metric", "positive"),
    runtime("institutional-positive", "institutional_flow", "positive"),
    runtime("financial-negative", "financial_metric", "negative"),
    runtime("institutional-negative", "institutional_flow", "negative"),
    runtime("risk-negative", "trade_risk", "negative"),
    runtime("strategy-positive", "strategy_result", "positive"),
    runtime("limitation", "limitation", "insufficient"),
  ];
}

export const recommendation = (verdict: "BUY" | "HOLD" | "SELL" | "INSUFFICIENT_DATA") => ({
  verdict, horizonMonths: 12 as const, confidence: 0.8,
  supportingFindingIds: verdict === "SELL" ? ["financial-negative", "institutional-negative"]
    : verdict === "INSUFFICIENT_DATA" ? [] : ["financial-positive", "institutional-positive"],
  opposingFindingIds: verdict === "SELL" ? ["financial-positive"]
    : verdict === "INSUFFICIENT_DATA" ? [] : ["financial-negative"],
  riskFindingIds: verdict === "INSUFFICIENT_DATA" ? ["limitation"] : ["risk-negative"],
});

export function peValuation(packet: AIResearchPacket, multiples = [8, 12, 16]) {
  return { method: "PE" as const, horizonMonths: 12 as const,
    currentPriceEvidenceId: packet.evidence.find((item) => item.field === "market.price")!.id,
    metricEvidenceId: packet.evidence.find((item) => item.field === "fundamentals.metrics.eps")!.id,
    scenarios: { conservative: { multiple: multiples[0] }, base: { multiple: multiples[1] },
      optimistic: { multiple: multiples[2] } } };
}


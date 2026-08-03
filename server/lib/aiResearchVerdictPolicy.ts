import type {
  AIResearchPacket,
  InvestmentVerdict,
  ResearchFindingStance,
  StructuredResearchFinding,
} from "../../shared/aiResearch";

function domain(finding: StructuredResearchFinding,
  registry: Map<string, AIResearchPacket["evidence"][number]>): string {
  if (["company_fact", "market_snapshot"].includes(finding.kind)) return "market";
  if (finding.kind === "financial_metric") return "financials";
  if (finding.kind === "institutional_flow") return "institutional";
  if (finding.kind === "tdcc_concentration") return "tdcc";
  if (finding.kind === "trade_risk") return "risk";
  if (finding.kind === "strategy_result") return "strategy";
  if (finding.kind === "evidence_comparison") {
    const dataset = registry.get(finding.fragments[0]?.evidenceId ?? "")?.dataset;
    return dataset === "stock_institutional" ? "institutional"
      : dataset === "tdcc_shareholding" ? "tdcc" : "unverifiable";
  }
  return "limitation";
}

export function deriveServerInvestmentVerdict(baseReturn: number,
  findings: readonly StructuredResearchFinding[],
  stances: ReadonlyMap<string, ResearchFindingStance>,
  registry: Map<string, AIResearchPacket["evidence"][number]>): Exclude<InvestmentVerdict, "INSUFFICIENT_DATA"> {
  const directional = baseReturn > 0.05 ? "BUY" : baseReturn < -0.05 ? "SELL" : "HOLD";
  if (directional === "HOLD") return "HOLD";
  const requiredStance = directional === "BUY" ? "positive" : "negative";
  const opposingStance = directional === "BUY" ? "negative" : "positive";
  const domains = new Set(findings.filter((finding) => finding.kind !== "trade_risk"
    && finding.kind !== "limitation" && stances.get(finding.id) === requiredStance)
    .map((finding) => domain(finding, registry)));
  const hasOpposition = findings.some((finding) => finding.kind !== "limitation"
    && stances.get(finding.id) === opposingStance);
  const hasRisk = findings.some((finding) => finding.kind === "trade_risk"
    && stances.get(finding.id) === "negative");
  return domains.size >= 2 && (hasOpposition || hasRisk) ? directional : "HOLD";
}

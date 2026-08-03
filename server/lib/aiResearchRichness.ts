import type { AIResearchPacket, InformationRichnessResult } from "../../shared/aiResearch";

const DOMAINS = ["fundamentals", "institutional", "tdcc", "tradeRisks", "strategies"] as const;

function sourceAvailable(packet: AIResearchPacket, dataset: string): boolean {
  return packet.sources.some((source) => source.dataset === dataset && source.status === "available");
}

function domainAvailability(packet: AIResearchPacket) {
  const strategyCount = Object.values(packet.strategies).filter((result) => result.status === "ok").length;
  return {
    market: sourceAvailable(packet, "stock_price") && packet.market.latestDate !== null
      && packet.market.price !== null && !packet.dataQuality.missingDatasets.includes("stock_price")
      && !packet.dataQuality.staleDatasets.includes("stock_price"),
    fundamentals: packet.fundamentals.status !== "unavailable",
    institutional: sourceAvailable(packet, "stock_institutional") && packet.institutional.dailyFlows.length > 0,
    tdcc: sourceAvailable(packet, "tdcc_shareholding")
      && packet.tdcc.totalShares !== null && packet.tdcc.whaleRatio !== null,
    tradeRisks: sourceAvailable(packet, "stock_trade_risk"),
    strategies: strategyCount >= 2,
    strategyCount,
  };
}

function reasons(packet: AIResearchPacket): string[] {
  const detailed = new Set<string>();
  if (packet.fundamentals.status === "partial") detailed.add("financials:partial");
  for (const [id, result] of Object.entries(packet.strategies)) {
    if (result.status !== "ok") detailed.add(`strategy:${id}:${result.status}`);
  }
  const suppressed = new Set([
    ...(packet.fundamentals.status === "partial" ? packet.fundamentals.missing : []),
    ...Object.entries(packet.strategies)
      .filter(([, result]) => result.status !== "ok").map(([id]) => `strategy:${id}`),
  ]);
  for (const dataset of packet.dataQuality.missingDatasets) {
    if (!suppressed.has(dataset)) detailed.add(`missing:${dataset}`);
  }
  for (const dataset of packet.dataQuality.staleDatasets) detailed.add(`stale:${dataset}`);
  return [...detailed].sort();
}

export function evaluateInformationRichness(packet: AIResearchPacket): InformationRichnessResult {
  const availability = domainAvailability(packet);
  const availableDomains = DOMAINS.filter((domain) => availability[domain]);
  const unavailableDomains = DOMAINS.filter((domain) => !availability[domain]);
  const allStrategies = availability.strategyCount === 4;
  const noQualityGaps = packet.dataQuality.missingDatasets.length === 0
    && packet.dataQuality.staleDatasets.length === 0;
  const grade = availability.market && packet.fundamentals.status === "complete"
    && availableDomains.length === DOMAINS.length && allStrategies && noQualityGaps
    ? "A"
    : !availability.market || availableDomains.length < 3 || availability.strategyCount < 2 ? "C" : "B";
  return { grade, availableDomains: [...availableDomains], unavailableDomains: [...unavailableDomains], reasons: reasons(packet) };
}

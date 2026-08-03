import assert from "node:assert/strict";
import test from "node:test";
import type {
  ResearchContext,
  ResearchSource,
  StrategyId,
  StrategyResearchResult,
} from "../shared/researchContext.js";
import type { AIResearchPacket, InformationRichnessResult } from "../shared/aiResearch.js";

type RichnessModule = {
  evaluateInformationRichness(packet: AIResearchPacket): InformationRichnessResult;
};

type PacketModule = {
  buildResearchPacket(context: ResearchContext): AIResearchPacket;
};

const loadPipeline = async (): Promise<RichnessModule & PacketModule> => {
  const [richness, packet] = await Promise.all([
    import("../server/lib/aiResearchRichness.js") as unknown as Promise<RichnessModule>,
    import("../server/lib/aiResearchPacket.js") as unknown as Promise<PacketModule>,
  ]);
  return { ...richness, ...packet };
};

function source(dataset: string, provider: ResearchSource["provider"] = "supabase"): ResearchSource {
  return {
    id: `${provider}:${dataset}`,
    dataset,
    provider,
    asOf: "2026-07-31",
    retrievedAt: "2026-08-02T04:00:00.000Z",
    rowCount: 1,
    estimated: false,
    status: "available",
    error: null,
  };
}

function strategy(strategy: StrategyId): StrategyResearchResult {
  return {
    strategy,
    status: "ok",
    date: "2026-07-31",
    score: 0,
    signal: "HOLD",
    confidence: 0,
    summary: null,
    details: {},
  };
}

function completeContext(): ResearchContext {
  return {
    schemaVersion: 1,
    stockId: "2330",
    asOf: "2026-07-31",
    company: { name: "台積電", market: "TSE", industry: "半導體業" },
    market: {
      latestDate: "2026-07-31",
      price: 0,
      history: [{ date: "2026-07-31", close: 0, volume: 0 }],
    },
    fundamentals: {
      status: "complete",
      metrics: [{
        key: "eps", value: 0, available: true, unit: "TWD",
        period: "2026-Q1", sourceId: "finmind:financials",
      }],
      missing: [],
    },
    institutional: {
      dailyFlows: [{
        date: "2026-07-31", foreignNet: 0, trustNet: 0,
        dealerNet: 0, institutionalNet: 0,
      }],
    },
    tdcc: {
      date: "2026-07-31", source: "tdcc", totalShares: 0,
      whaleRatio: 0, retailRatio: null, totalPeople: null,
      whaleShares: null, whalePeople: null,
    },
    tradeRisks: { highestLevel: "none", flags: [], dataAsOf: null },
    strategies: {
      sr: strategy("sr"),
      ma: strategy("ma"),
      chips: strategy("chips"),
      pattern: strategy("pattern"),
    },
    quality: { status: "complete", missingDatasets: [], staleDatasets: [], warnings: [] },
    sources: [
      source("stock_meta"),
      source("stock_price"),
      source("financials", "finmind"),
      source("stock_institutional"),
      source("tdcc_shareholding"),
      { ...source("stock_trade_risk"), asOf: null, rowCount: 0 },
      source("trading_calendar"),
      source("strategy_sr"),
      source("strategy_ma"),
      source("strategy_chips"),
      source("strategy_pattern"),
    ],
  };
}

test("complete deterministic context is grade A and stable across evaluations", async () => {
  const { buildResearchPacket, evaluateInformationRichness } = await loadPipeline();
  const context = completeContext();
  const packet = buildResearchPacket(context);
  assert.ok(Object.isFrozen(packet), "ResearchPacket must be immutable");
  assert.ok(Object.isFrozen(packet.dataQuality), "packet dataQuality must be immutable");
  assert.deepEqual(Object.keys(packet.strategies).sort(), ["chips", "ma", "pattern", "sr"]);
  assert.equal("context" in packet, false, "ResearchPacket fields must be top-level, not wrapped in context");
  const first = evaluateInformationRichness(packet);
  const second = evaluateInformationRichness(buildResearchPacket(structuredClone(context)));

  assert.deepEqual(first, {
    grade: "A",
    availableDomains: ["fundamentals", "institutional", "tdcc", "tradeRisks", "strategies"],
    unavailableDomains: [],
    reasons: [],
  });
  assert.deepEqual(second, first, "same context must always produce the same grade and reason order");
});

test("empty trade-risk rows are valid negative evidence and remain grade A", async () => {
  const { buildResearchPacket, evaluateInformationRichness } = await loadPipeline();
  const context = completeContext();
  const riskSource = context.sources.find((item) => item.dataset === "stock_trade_risk");
  assert.ok(riskSource);
  assert.equal(riskSource.rowCount, 0);
  assert.equal(riskSource.asOf, null);

  const result = evaluateInformationRichness(buildResearchPacket(context));
  assert.equal(result.grade, "A");
  assert.equal(result.reasons.some((reason) => reason.includes("stock_trade_risk")), false);
});

test("FinMind partial financials produce grade B with an explicit reason", async () => {
  const { buildResearchPacket, evaluateInformationRichness } = await loadPipeline();
  const context = completeContext();
  context.fundamentals.status = "partial";
  context.fundamentals.missing = ["TaiwanStockCashFlowsStatement"];
  context.quality.status = "partial";
  context.quality.missingDatasets = ["TaiwanStockCashFlowsStatement"];
  const packet = buildResearchPacket(context);

  assert.deepEqual(evaluateInformationRichness(packet), {
    grade: "B",
    availableDomains: ["fundamentals", "institutional", "tdcc", "tradeRisks", "strategies"],
    unavailableDomains: [],
    reasons: ["financials:partial"],
  });
});

test("one failed strategy produces grade B without inventing a replacement result", async () => {
  const { buildResearchPacket, evaluateInformationRichness } = await loadPipeline();
  const context = completeContext();
  context.strategies.chips = {
    strategy: "chips", status: "error", date: null, score: null,
    signal: "UNKNOWN", confidence: null, summary: null, details: {},
  };
  const chipsSource = context.sources.find((item) => item.dataset === "strategy_chips");
  assert.ok(chipsSource);
  Object.assign(chipsSource, { asOf: null, rowCount: 0, status: "error", error: "chips unavailable" });
  context.quality.status = "partial";
  context.quality.missingDatasets = ["strategy:chips"];
  const packet = buildResearchPacket(context);

  assert.deepEqual(evaluateInformationRichness(packet), {
    grade: "B",
    availableDomains: ["fundamentals", "institutional", "tdcc", "tradeRisks", "strategies"],
    unavailableDomains: [],
    reasons: ["strategy:chips:error"],
  });
  assert.equal(context.strategies.chips.signal, "UNKNOWN");
  assert.equal(context.strategies.chips.score, null);
});

test("unavailable market produces grade C and preserves sorted missing/stale reasons", async () => {
  const { buildResearchPacket, evaluateInformationRichness } = await loadPipeline();
  const context = completeContext();
  context.quality.status = "partial";
  context.quality.staleDatasets = ["stock_price"];
  context.quality.missingDatasets = ["tdcc_shareholding", "stock_institutional"];
  const packet = buildResearchPacket(context);

  assert.deepEqual(evaluateInformationRichness(packet), {
    grade: "C",
    availableDomains: ["fundamentals", "institutional", "tdcc", "tradeRisks", "strategies"],
    unavailableDomains: [],
    reasons: [
      "missing:stock_institutional",
      "missing:tdcc_shareholding",
      "stale:stock_price",
    ],
  });
});

test("fewer than two successful strategies produces grade C even with available market", async () => {
  const { buildResearchPacket, evaluateInformationRichness } = await loadPipeline();
  const context = completeContext();
  for (const id of ["ma", "chips", "pattern"] as const) {
    context.strategies[id] = {
      strategy: id, status: "unavailable", date: null, score: null,
      signal: "UNKNOWN", confidence: null, summary: null, details: {},
    };
  }
  context.quality.status = "partial";
  context.quality.missingDatasets = ["strategy:ma", "strategy:chips", "strategy:pattern"];
  const packet = buildResearchPacket(context);

  assert.deepEqual(evaluateInformationRichness(packet), {
    grade: "C",
    availableDomains: ["fundamentals", "institutional", "tdcc", "tradeRisks"],
    unavailableDomains: ["strategies"],
    reasons: [
      "strategy:chips:unavailable",
      "strategy:ma:unavailable",
      "strategy:pattern:unavailable",
    ],
  });
});

test("fewer than three non-market research domains produces grade C", async () => {
  const { buildResearchPacket, evaluateInformationRichness } = await loadPipeline();
  const context = completeContext();
  context.fundamentals = { status: "unavailable", metrics: [], missing: ["financials"] };
  context.institutional = { dailyFlows: [] };
  context.tdcc = {
    date: null, source: null, totalShares: null, whaleRatio: null,
    retailRatio: null, totalPeople: null, whaleShares: null, whalePeople: null,
  };
  context.quality.status = "partial";
  context.quality.missingDatasets = ["financials", "stock_institutional", "tdcc_shareholding"];
  const packet = buildResearchPacket(context);

  assert.deepEqual(evaluateInformationRichness(packet), {
    grade: "C",
    availableDomains: ["tradeRisks", "strategies"],
    unavailableDomains: ["fundamentals", "institutional", "tdcc"],
    reasons: [
      "missing:financials",
      "missing:stock_institutional",
      "missing:tdcc_shareholding",
    ],
  });
});

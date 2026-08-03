import assert from "node:assert/strict";
import test from "node:test";
import type { ResearchContextAdapter } from "../server/lib/researchContext.js";
import type { ResearchDataset, StrategyId } from "../shared/researchContext.js";

type CloudReaders = {
  readStockMeta(stockId: string): Promise<Record<string, unknown> | null>;
  readPrices(stockId: string): Promise<Array<Record<string, unknown>>>;
  readInstitutional(stockId: string): Promise<Array<Record<string, unknown>>>;
  readTdcc(stockId: string): Promise<Array<Record<string, unknown>>>;
  readFinancials(stockId: string): Promise<Array<Record<string, unknown>>>;
  readTradeRisks(stockId: string): Promise<Array<Record<string, unknown>>>;
  readTradingCalendar(asOfDate: string): Promise<string[]>;
  runStrategy(stockId: string, strategy: StrategyId, prices: Array<Record<string, unknown>>): Promise<Record<string, unknown>>;
};

type AuditableCloudAdapter = ResearchContextAdapter & {
  readTradingCalendar(asOfDate: string): Promise<ResearchDataset<{ dates: string[] }>>;
};

test("production adapter maps controlled cloud readers without real network or DB access", async () => {
  const module = await import("../server/lib/researchContextCloudAdapter.js") as unknown as {
    createCloudResearchContextAdapter(options: { readers: CloudReaders; clock: () => Date }): AuditableCloudAdapter;
  };
  const calls: string[] = [];
  const strategyDates: Array<string | null> = [];
  const readers: CloudReaders = {
    async readStockMeta(stockId) {
      calls.push(`meta:${stockId}`);
      return {
        stock_id: stockId, stock_name: "台積電", industry_category: "半導體業",
        status: "active", type: "COMMON", market: "TSE",
      };
    },
    async readPrices(stockId) {
      calls.push(`prices:${stockId}`);
      return [{ date: "2026-07-31", close: 0, volume: 0 }];
    },
    async readInstitutional() {
      return [{ date: "2026-07-31", foreign_net: 0, trust_net: 2, dealer_net: 0, institutional_net: 2 }];
    },
    async readTdcc() {
      return [{
        date: "2026-07-31", source: "tdcc", total_shares: 100,
        whale_ratio: 20, retail_ratio: null, total_people: null,
        whale_shares: null, whale_people: null,
      }];
    },
    async readFinancials() { return []; },
    async readTradeRisks() { return []; },
    async readTradingCalendar() { return ["2026-07-31"]; },
    async runStrategy(_stockId, strategy, prices) {
      const date = typeof prices.at(-1)?.date === "string" ? prices.at(-1)?.date as string : null;
      strategyDates.push(date);
      return {
        strategy, status: "ok", date, score: 0, signal: "HOLD",
        confidence: 0, summary: null, details: {},
      };
    },
  };

  const adapter = module.createCloudResearchContextAdapter({
    readers,
    clock: () => new Date("2026-08-02T00:00:00.000Z"),
  });
  const company = await adapter.readCompany("2330");
  const market = await adapter.readMarket("2330");
  const institutional = await adapter.readInstitutional("2330");
  const tdcc = await adapter.readTdcc("2330");
  for (const strategy of ["sr", "ma", "chips", "pattern"] as const) {
    const result = await adapter.runStrategy("2330", strategy);
    assert.equal(result.date, "2026-07-31");
  }

  assert.deepEqual(company.data, {
    name: "台積電", market: "TSE", industry: "半導體業",
    stockId: "2330", status: "active", type: "COMMON",
  });
  assert.equal(market.data.price, 0);
  assert.equal(institutional.data.dailyFlows[0]?.foreignNet, 0);
  assert.equal(institutional.data.dailyFlows[0]?.dealerNet, 0);
  assert.equal(tdcc.data.retailRatio, null);
  assert.deepEqual(strategyDates, ["2026-07-31", "2026-07-31", "2026-07-31", "2026-07-31"]);
  assert.ok(calls.includes("meta:2330"));
  assert.ok(calls.includes("prices:2330"));

  readers.readPrices = async () => [{ close: 1 }];
  const noDateAdapter = module.createCloudResearchContextAdapter({
    readers,
    clock: () => new Date("2026-08-02T00:00:00.000Z"),
  });
  assert.equal((await noDateAdapter.runStrategy("2330", "sr")).date, null);
});

test("FinMind child datasets retain independent provenance through the context", async () => {
  const module = await import("../server/lib/researchContextCloudAdapter.js") as unknown as {
    createCloudResearchContextAdapter(options: { readers: CloudReaders; clock: () => Date }): ResearchContextAdapter;
  };
  const { ResearchContextAggregator } = await import("../server/lib/researchContext.js");
  const inputs = [
    { dataset: "TaiwanStockFinancialStatements", rows: [{ date: "2026-03-31", type: "Revenue", value: 100 }] },
    { dataset: "TaiwanStockBalanceSheet", rows: [], error: "balance unavailable" },
    { dataset: "TaiwanStockCashFlowsStatement", rows: [{ date: "2026-03-31", type: "OperatingCashFlow", value: 10 }] },
    { dataset: "TaiwanStockMonthRevenue", rows: [] },
    { dataset: "TaiwanStockPER", rows: [{ date: "2026-03-31", PER: 20 }] },
    { dataset: "TaiwanStockDividend", rows: [], error: "dividend unavailable" },
  ];
  const readers: CloudReaders = {
    async readStockMeta(stockId) {
      return { stock_id: stockId, stock_name: "台積電", industry_category: "半導體業", status: "active", type: "COMMON", market: "TSE" };
    },
    async readPrices() { return [{ date: "2026-07-31", close: 100, volume: 1 }]; },
    async readInstitutional() { return []; },
    async readTdcc() { return []; },
    async readFinancials() { return inputs; },
    async readTradeRisks() { return []; },
    async readTradingCalendar() { return ["2026-07-31"]; },
    async runStrategy(_stockId, strategy) {
      return { strategy, status: "ok", date: "2026-07-31", score: null, signal: "UNKNOWN", confidence: null, summary: null, details: {} };
    },
  };
  const adapter = module.createCloudResearchContextAdapter({
    readers, clock: () => new Date("2026-08-02T00:00:00.000Z"),
  });
  const fundamentals = await adapter.readFundamentals("2330") as ResearchDataset<Record<string, unknown>> & {
    sources?: Array<Record<string, unknown>>;
  };
  assert.equal(fundamentals.data.status, "partial");
  assert.ok(
    Array.isArray(fundamentals.data.metrics)
      && fundamentals.data.metrics.some((metric) =>
        typeof metric === "object" && metric !== null
        && (metric as Record<string, unknown>).key === "revenue"
        && (metric as Record<string, unknown>).available === true),
    "successful FinMind rows must remain available when sibling datasets fail",
  );
  assert.equal(fundamentals.sources?.length, 6);
  const byDataset = new Map(fundamentals.sources?.map((source) => [source.dataset, source]));
  assert.deepEqual(byDataset.get("TaiwanStockFinancialStatements"), {
    id: "finmind:TaiwanStockFinancialStatements", dataset: "TaiwanStockFinancialStatements",
    provider: "finmind", asOf: "2026-03-31", retrievedAt: "2026-08-02T00:00:00.000Z",
    rowCount: 1, estimated: false, status: "available", error: null,
  });
  assert.equal(byDataset.get("TaiwanStockBalanceSheet")?.status, "error");
  assert.equal(byDataset.get("TaiwanStockBalanceSheet")?.error, "balance unavailable");
  assert.equal(byDataset.get("TaiwanStockMonthRevenue")?.status, "unavailable");
  assert.equal(byDataset.get("TaiwanStockMonthRevenue")?.rowCount, 0);

  const context = await new ResearchContextAggregator(adapter, {
    asOfDate: "2026-08-02", clock: () => new Date("2026-08-02T00:00:00.000Z"),
  }).aggregate("2330");
  assert.equal(context.quality.status, "partial");
  assert.ok(context.quality.missingDatasets.includes("TaiwanStockBalanceSheet"));
  assert.ok(context.quality.missingDatasets.includes("TaiwanStockMonthRevenue"));
  assert.ok(context.quality.missingDatasets.includes("TaiwanStockDividend"));
  assert.ok(context.quality.warnings.some((warning) => warning.includes("balance unavailable")));
  assert.ok(context.quality.warnings.some((warning) => warning.includes("dividend unavailable")));
  assert.ok(context.sources.some((source) => source.id === "finmind:TaiwanStockFinancialStatements"));

  readers.readFinancials = async () => inputs.map((input) => ({
    dataset: input.dataset, rows: [], error: `${input.dataset} failed`,
  }));
  const unavailable = await module.createCloudResearchContextAdapter({
    readers, clock: () => new Date("2026-08-02T00:00:00.000Z"),
  }).readFundamentals("2330") as ResearchDataset<Record<string, unknown>> & {
    sources?: Array<Record<string, unknown>>;
  };
  assert.equal(unavailable.data.status, "unavailable");
  assert.equal(unavailable.sources?.length, 6);
  assert.ok(unavailable.sources?.every((source) => source.status === "error"));
});

test("formal fundamentals expose consecutive-four-quarter TTM EPS and preserve quarterly EPS", async () => {
  const module = await import("../server/lib/researchContextCloudAdapter.js") as unknown as {
    createCloudResearchContextAdapter(options: { readers: CloudReaders; clock: () => Date }): ResearchContextAdapter;
  };
  const incomeRows = [
    { date: "2025-03-31", type: "EPS", origin_name: "基本每股盈餘", value: 1 },
    { date: "2025-06-30", type: "EPS", origin_name: "基本每股盈餘", value: 2 },
    { date: "2025-09-30", type: "EPS", origin_name: "基本每股盈餘", value: 3 },
    { date: "2025-12-31", type: "EPS", origin_name: "基本每股盈餘", value: 4 },
  ];
  const financials = (rows = incomeRows) => [
    { dataset: "TaiwanStockFinancialStatements", rows },
    { dataset: "TaiwanStockBalanceSheet", rows: [] },
    { dataset: "TaiwanStockCashFlowsStatement", rows: [] },
    { dataset: "TaiwanStockMonthRevenue", rows: [] },
    { dataset: "TaiwanStockPER", rows: [] },
    { dataset: "TaiwanStockDividend", rows: [] },
  ];
  const readers = {
    async readStockMeta(stockId: string) { return { stock_id: stockId, status: "active", type: "COMMON", market: "TSE" }; },
    async readPrices() { return [{ date: "2026-03-31", close: 100, volume: 1 }]; },
    async readInstitutional() {
      return [{ date: "2026-03-31", foreign_net: 0, trust_net: 2, dealer_net: 0, institutional_net: 2 }];
    },
    async readTdcc() { return []; },
    async readFinancials() { return financials(); }, async readTradeRisks() { return []; },
    async readTradingCalendar() { return ["2026-03-31"]; },
    async runStrategy(_stockId: string, strategy: StrategyId) {
      const signal = strategy === "sr" ? "BUY" : strategy === "ma" ? "SELL" : "HOLD";
      return { strategy, status: "ok", date: "2026-03-31", score: 0, signal, confidence: null, summary: "fixture", details: {} };
    },
  } satisfies CloudReaders;
  const adapter = module.createCloudResearchContextAdapter({ readers,
    clock: () => new Date("2026-03-31T00:00:00.000Z") });
  const result = await adapter.readFundamentals("2330");
  assert.deepEqual(result.data.metrics.find((metric) => metric.key === "eps"), {
    key: "eps", value: 10, available: true, unit: "TWD", period: "TTM", sourceId: "finmind:financials",
  });
  assert.deepEqual(result.data.metrics.find((metric) => metric.key === "epsQuarterly"), {
    key: "epsQuarterly", value: 4, available: true, unit: "TWD", period: "2025 Q4", sourceId: "finmind:financials",
  });

  const [{ ResearchContextAggregator }, { buildResearchPacket },
    { validateResearchFindingRuntime }, { evaluateInvestmentConclusion }] = await Promise.all([
    import("../server/lib/researchContext.js"), import("../server/lib/aiResearchPacket.js"),
    import("../server/lib/aiResearchFindingPolicy.js"), import("../server/lib/aiResearchInvestmentConclusion.js"),
  ]);
  const context = await new ResearchContextAggregator(adapter, {
    asOfDate: "2026-03-31", clock: () => new Date("2026-03-31T00:00:00.000Z"),
  }).aggregate("2330");
  const packet = buildResearchPacket(context);
  const evidence = (field: string) => packet.evidence.find((item) => item.field === field)!;
  const findings = [
    { id: "institutional-positive", kind: "institutional_flow", stance: "positive", fragments: [
      { evidenceId: evidence("institutional.2026-03-31.trustNet").id, role: "value", format: "value_with_unit" },
      { evidenceId: evidence("institutional.2026-03-31.date").id, role: "date", format: "date" },
    ] },
    { id: "strategy-positive", kind: "strategy_result", strategyId: "sr", stance: "positive", fragments: [
      { evidenceId: evidence("strategies.sr.signal").id, role: "subject", format: "label" },
      { evidenceId: evidence("strategies.sr.date").id, role: "date", format: "date" },
    ] },
    { id: "strategy-negative", kind: "strategy_result", strategyId: "ma", stance: "negative", fragments: [
      { evidenceId: evidence("strategies.ma.signal").id, role: "subject", format: "label" },
      { evidenceId: evidence("strategies.ma.date").id, role: "date", format: "date" },
    ] },
  ].map((finding) => validateResearchFindingRuntime(finding, packet));
  const valuation = evaluateInvestmentConclusion({ recommendation: {
    verdict: "BUY", horizonMonths: 12, confidence: 0.5,
    supportingFindingIds: ["institutional-positive", "strategy-positive"],
    opposingFindingIds: ["strategy-negative"], riskFindingIds: [],
  }, valuation: { method: "PE", horizonMonths: 12,
    currentPriceEvidenceId: evidence("market.price").id,
    metricEvidenceId: evidence("fundamentals.metrics.eps").id,
    scenarios: { conservative: { multiple: 8 }, base: { multiple: 12 }, optimistic: { multiple: 16 } },
  } }, packet, findings);
  assert.deepEqual(valuation.errors, []);
  assert.equal(valuation.valuation?.metric.period, "TTM");
  assert.equal(valuation.valuation?.scenarios[1].targetPrice, 120);

  readers.readFinancials = async () => financials(incomeRows.slice(0, 3));
  const incomplete = await module.createCloudResearchContextAdapter({ readers,
    clock: () => new Date("2026-03-31T00:00:00.000Z") }).readFundamentals("2330");
  const unavailableEps = incomplete.data.metrics.find((metric) => metric.key === "eps");
  assert.equal(unavailableEps?.available, false);
  assert.equal(unavailableEps?.value, null);
  assert.equal(unavailableEps?.period, "TTM");
  assert.equal(incomplete.data.metrics.some((metric) => metric.key === "bvps"), false);
});

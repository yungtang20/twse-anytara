import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ResearchContextAdapter } from "../server/lib/researchContext.js";
import type { ResearchContext, ResearchDataset, ResearchSource } from "../shared/researchContext.js";
import { createResearchContextAdapter, type StrategyId } from "./helpers/research-context-fixtures.js";

type AggregatorModule = {
  ResearchContextAggregator: new (adapter: ResearchContextAdapter,
    options?: { clock: () => Date; asOfDate?: string }) => {
    aggregate(stockId: string): Promise<ResearchContext>;
  };
};

type Eligibility = { stockId: string; status: string; type: string; market: string };
type AggregatorOptions = { clock: () => Date; asOfDate: string };
type EligibilityAdapter = ResearchContextAdapter & {
  readTradingCalendar(asOfDate: string): Promise<ResearchDataset<{ dates: string[] }>>;
};
type AuditedSource = ResearchSource & {
  status: "available" | "unavailable" | "error";
  error: string | null;
};

function provenance(
  id: string,
  dataset: string,
  status: AuditedSource["status"] = "available",
  error: string | null = null,
): ResearchSource {
  return {
    id, dataset, provider: "supabase", asOf: status === "available" ? "2026-07-31" : null,
    retrievedAt: "2026-08-02T03:04:05.000Z", rowCount: status === "available" ? 1 : 0,
    estimated: false, status, error,
  };
}

const loadAggregator = async (): Promise<AggregatorModule> =>
  import("../server/lib/researchContext.js") as Promise<AggregatorModule>;

function eligibilityAdapter(overrides: Partial<Eligibility> = {}): EligibilityAdapter {
  const adapter = createResearchContextAdapter() as EligibilityAdapter;
  const originalCompany = adapter.readCompany;
  adapter.readCompany = async (stockId) => {
    const result = await originalCompany(stockId);
    const data = {
      ...result.data, stockId, status: "active", type: "COMMON", market: "TSE", ...overrides,
    };
    return { ...result, data };
  };
  adapter.readTradingCalendar = async () => ({
    data: { dates: ["2026-07-29", "2026-07-30", "2026-07-31"] },
    source: {
      id: "supabase:trading_calendar", dataset: "trading_calendar", provider: "supabase",
      asOf: "2026-07-31", retrievedAt: "2026-08-02T03:04:05.000Z", rowCount: 3, estimated: false,
      status: "available", error: null,
    },
  });
  return adapter;
}

const options: AggregatorOptions = {
  clock: () => new Date("2026-08-02T04:00:00.000Z"),
  asOfDate: "2026-08-02",
};

test("eligibility reuses the ordinary-stock contract before every downstream loader", async () => {
  const { ResearchContextAggregator } = await loadAggregator();
  for (const [stockId, type] of [["2330", "COMMON"], ["1701", "stock"]] as const) {
    const context = await new ResearchContextAggregator(
      eligibilityAdapter({ stockId, type }), options,
    ).aggregate(stockId);
    assert.equal(context.stockId, stockId);
  }

  for (const [label, stockId, overrides] of [
    ["ETF", "0050", {}],
    ["TDR", "9105", {}],
    ["six-digit product", "02001R", {}],
    ["inactive", "2330", { status: "inactive" }],
    ["wrong market", "2330", { market: "ESB" }],
    ["warrant", "2330", { type: "WARRANT" }],
    ["preferred", "2330", { type: "PREFERRED" }],
  ] as const) {
    const adapter = eligibilityAdapter(overrides);
    const downstreamCalls: string[] = [];
    adapter.readMarket = async () => { downstreamCalls.push("market"); throw new Error("must not run"); };
    adapter.readFundamentals = async () => { downstreamCalls.push("fundamentals"); throw new Error("must not run"); };
    adapter.readInstitutional = async () => { downstreamCalls.push("institutional"); throw new Error("must not run"); };
    adapter.readTdcc = async () => { downstreamCalls.push("tdcc"); throw new Error("must not run"); };
    adapter.readTradeRisks = async () => { downstreamCalls.push("risks"); throw new Error("must not run"); };
    adapter.readTradingCalendar = async () => { downstreamCalls.push("calendar"); throw new Error("must not run"); };
    adapter.runStrategy = async () => { downstreamCalls.push("strategy"); throw new Error("must not run"); };
    await assert.rejects(
      new ResearchContextAggregator(adapter, options).aggregate(stockId),
      (error: unknown) => error instanceof Error && error.message === "stock_not_eligible_for_research",
      label,
    );
    assert.deepEqual(downstreamCalls, [], `${label} must stop before every downstream loader`);
  }
});

test("freshness uses injected as-of date and trading calendar with dataset-specific thresholds", async () => {
  const { ResearchContextAggregator } = await loadAggregator();
  const fresh = await new ResearchContextAggregator(eligibilityAdapter(), options).aggregate("2330");
  assert.deepEqual(fresh.quality.staleDatasets, []);

  const boundary = eligibilityAdapter();
  const atBoundary = <T>(loader: (stockId: string) => Promise<ResearchDataset<T>>, asOf: string) => async (stockId: string) => {
    const result = await loader(stockId);
    return { ...result, source: { ...result.source, asOf } };
  };
  boundary.readInstitutional = atBoundary(boundary.readInstitutional, "2026-07-30");
  boundary.readTdcc = atBoundary(boundary.readTdcc, "2026-07-23");
  boundary.readFundamentals = atBoundary(boundary.readFundamentals, "2026-03-31");
  const risk = await boundary.readTradeRisks("2330");
  boundary.readTradeRisks = async () => ({
    data: { highestLevel: "medium", flags: [{ type: "attention" }], dataAsOf: "2026-07-30" },
    source: { ...risk.source, asOf: "2026-07-30", rowCount: 1 },
  });
  const thresholdContext = await new ResearchContextAggregator(boundary, options).aggregate("2330");
  assert.deepEqual(
    thresholdContext.quality.staleDatasets,
    [],
    "1 trading day / 10-day TDCC / current required quarter / 3-day risk thresholds are inclusive",
  );

  const adapter = eligibilityAdapter();
  const setAsOf = <T>(loader: (stockId: string) => Promise<ResearchDataset<T>>, asOf: string | null) => async (stockId: string) => {
    const result = await loader(stockId);
    return { ...result, source: { ...result.source, asOf } };
  };
  adapter.readMarket = setAsOf(adapter.readMarket, "2026-07-30");
  adapter.readInstitutional = setAsOf(adapter.readInstitutional, "2026-07-29");
  adapter.readTdcc = setAsOf(adapter.readTdcc, "2026-07-20");
  adapter.readFundamentals = setAsOf(adapter.readFundamentals, "2026-03-01");
  adapter.readTradeRisks = setAsOf(adapter.readTradeRisks, "2026-07-28");
  const stale = await new ResearchContextAggregator(adapter, options).aggregate("2330");
  assert.deepEqual(
    [...stale.quality.staleDatasets].sort(),
    ["financials", "stock_institutional", "stock_price", "stock_trade_risk", "tdcc_shareholding"].sort(),
  );
});

test("implicit Taipei as-of excludes today's trading session before 13:30 only for market freshness", async () => {
  const { ResearchContextAggregator } = await loadAggregator();
  const aggregateAt = async (clockIso: string, asOfDate?: string) => {
    const adapter = eligibilityAdapter();
    const withSourceDate = <T>(loader: (stockId: string) => Promise<ResearchDataset<T>>, date: string) =>
      async (stockId: string) => {
        const result = await loader(stockId);
        return { ...result, source: { ...result.source, asOf: date } };
      };
    adapter.readMarket = withSourceDate(adapter.readMarket, "2026-07-31");
    adapter.readInstitutional = withSourceDate(adapter.readInstitutional, "2026-07-30");
    adapter.readTdcc = withSourceDate(adapter.readTdcc, "2026-07-21");
    adapter.readTradeRisks = withSourceDate(adapter.readTradeRisks, "2026-07-29");
    adapter.readTradingCalendar = async () => ({
      data: { dates: ["2026-07-30", "2026-07-31", "2026-08-03"] },
      source: {
        id: "supabase:trading_calendar", dataset: "trading_calendar", provider: "supabase",
        asOf: "2026-08-03", retrievedAt: clockIso, rowCount: 3, estimated: false,
        status: "available", error: null,
      },
    });
    return new ResearchContextAggregator(adapter, {
      clock: () => new Date(clockIso), ...(asOfDate ? { asOfDate } : {}),
    }).aggregate("2330");
  };

  const preMarket = await aggregateAt("2026-08-02T22:18:00.000Z");
  assert.equal(preMarket.quality.staleDatasets.includes("stock_price"), false);
  assert.equal(preMarket.quality.staleDatasets.includes("stock_institutional"), false);
  assert.equal(preMarket.quality.staleDatasets.includes("tdcc_shareholding"), true,
    "TDCC freshness must keep the calendar date");
  assert.equal(preMarket.quality.staleDatasets.includes("stock_trade_risk"), true,
    "trade-risk freshness must keep the calendar date");

  const postClose = await aggregateAt("2026-08-03T05:31:00.000Z");
  assert.equal(postClose.quality.staleDatasets.includes("stock_price"), true);
  assert.equal(postClose.quality.staleDatasets.includes("stock_institutional"), true);
  assert.ok(postClose.quality.warnings.includes("stock_price:trading_lag:1"));
  assert.ok(postClose.quality.warnings.includes("stock_institutional:trading_lag:2"));

  const weekend = await aggregateAt("2026-08-02T04:00:00.000Z");
  assert.equal(weekend.quality.staleDatasets.includes("stock_price"), false);
  assert.equal(weekend.quality.staleDatasets.includes("stock_institutional"), false);

  const explicit = await aggregateAt("2026-08-02T22:18:00.000Z", "2026-08-03");
  assert.equal(explicit.quality.staleDatasets.includes("stock_price"), true);
  assert.equal(explicit.quality.staleDatasets.includes("stock_institutional"), true);
});

test("financial freshness switches at the quarterly filing deadline", async () => {
  const { ResearchContextAggregator } = await loadAggregator();
  const aggregateAt = async (asOfDate: string, financialAsOf: string) => {
    const adapter = eligibilityAdapter();
    const market = await adapter.readMarket("2330");
    adapter.readMarket = async () => ({
      data: {
        ...market.data,
        latestDate: asOfDate,
        history: [{ date: asOfDate, close: 1 }],
      },
      source: { ...market.source, asOf: asOfDate },
    });
    adapter.readTradingCalendar = async () => ({
      data: { dates: [asOfDate] },
      source: {
        id: "supabase:trading_calendar", dataset: "trading_calendar", provider: "supabase",
        asOf: asOfDate, retrievedAt: `${asOfDate}T04:00:00.000Z`, rowCount: 1, estimated: false,
        status: "available", error: null,
      },
    });
    const fundamentals = await adapter.readFundamentals("2330");
    adapter.readFundamentals = async () => ({
      ...fundamentals,
      source: { ...fundamentals.source, asOf: financialAsOf },
    });
    return new ResearchContextAggregator(adapter, {
      asOfDate,
      clock: () => new Date(`${asOfDate}T04:00:00.000Z`),
    }).aggregate("2330");
  };

  const beforeDeadline = await aggregateAt("2026-08-13", "2026-03-31");
  assert.equal(
    beforeDeadline.quality.staleDatasets.includes("financials"),
    false,
    "Q1 remains current until the Q2 filing deadline",
  );

  const deadlineWithoutQ2 = await aggregateAt("2026-08-14", "2026-03-31");
  assert.equal(
    deadlineWithoutQ2.quality.staleDatasets.includes("financials"),
    true,
    "Q1 becomes stale on the Q2 filing deadline even inside an absolute day limit",
  );

  const deadlineWithQ2 = await aggregateAt("2026-08-14", "2026-06-30");
  assert.equal(
    deadlineWithQ2.quality.staleDatasets.includes("financials"),
    false,
    "Q2 data satisfies the Q2 filing deadline",
  );
});

test("financial freshness follows filing periods across year and leap-day boundaries", async () => {
  const { ResearchContextAggregator } = await loadAggregator();
  const isStale = async (asOfDate: string, financialAsOf: string) => {
    const adapter = eligibilityAdapter();
    const market = await adapter.readMarket("2330");
    adapter.readMarket = async () => ({
      data: { ...market.data, latestDate: asOfDate, history: [{ date: asOfDate, close: 1 }] },
      source: { ...market.source, asOf: asOfDate },
    });
    adapter.readTradingCalendar = async () => ({
      data: { dates: [asOfDate] },
      source: {
        id: "supabase:trading_calendar", dataset: "trading_calendar", provider: "supabase",
        asOf: asOfDate, retrievedAt: `${asOfDate}T04:00:00.000Z`, rowCount: 1,
        estimated: false, status: "available", error: null,
      },
    });
    const fundamentals = await adapter.readFundamentals("2330");
    adapter.readFundamentals = async () => ({
      ...fundamentals, source: { ...fundamentals.source, asOf: financialAsOf },
    });
    const context = await new ResearchContextAggregator(adapter, {
      asOfDate, clock: () => new Date(`${asOfDate}T04:00:00.000Z`),
    }).aggregate("2330");
    return context.quality.staleDatasets.includes("financials");
  };

  const cases = [
    ["2026-02-28", "2025-09-30", false],
    ["2026-03-30", "2025-09-30", false],
    ["2026-03-31", "2025-09-30", true],
    ["2026-03-31", "2025-12-31", false],
    ["2026-05-14", "2025-12-31", false],
    ["2026-05-15", "2025-12-31", true],
    ["2026-05-15", "2026-03-31", false],
    ["2026-08-13", "2026-03-31", false],
    ["2026-08-14", "2026-03-31", true],
    ["2026-08-14", "2026-06-30", false],
    ["2026-11-13", "2026-06-30", false],
    ["2026-11-14", "2026-06-30", true],
    ["2026-11-14", "2026-09-30", false],
    ["2024-02-29", "2023-09-30", false],
    ["2025-02-28", "2024-09-30", false],
  ] as const;
  for (const [asOfDate, financialAsOf, expected] of cases) {
    assert.equal(await isStale(asOfDate, financialAsOf), expected, `${asOfDate} / ${financialAsOf}`);
  }
});

test("future and null source dates are stale, except an empty risk dataset", async () => {
  const { ResearchContextAggregator } = await loadAggregator();
  const adapter = eligibilityAdapter();
  const institutional = await adapter.readInstitutional("2330");
  adapter.readInstitutional = async () => ({ ...institutional, source: { ...institutional.source, asOf: "2026-08-03" } });
  const tdcc = await adapter.readTdcc("2330");
  adapter.readTdcc = async () => ({ ...tdcc, source: { ...tdcc.source, asOf: null } });
  const fundamentals = await adapter.readFundamentals("2330");
  adapter.readFundamentals = async () => ({
    ...fundamentals, source: { ...fundamentals.source, asOf: "2026-02-30" },
  });
  const risks = await adapter.readTradeRisks("2330");
  adapter.readTradeRisks = async () => ({
    ...risks,
    source: { ...risks.source, asOf: null, rowCount: 0 },
    data: { highestLevel: "none", flags: [], dataAsOf: null },
  });

  const context = await new ResearchContextAggregator(adapter, options).aggregate("2330");
  assert.ok(context.quality.staleDatasets.includes("stock_institutional"));
  assert.ok(context.quality.staleDatasets.includes("tdcc_shareholding"));
  assert.ok(context.quality.staleDatasets.includes("financials"));
  assert.ok(context.quality.warnings.some((warning) => /stock_institutional.*future|future.*stock_institutional/i.test(warning)));
  assert.ok(context.quality.warnings.some((warning) => /financials.*invalid/i.test(warning)));
  assert.equal(context.quality.staleDatasets.includes("stock_trade_risk"), false);
  assert.equal(context.quality.missingDatasets.includes("stock_trade_risk"), false);
});

test("null asOf is stale only for the five freshness datasets", async () => {
  const { ResearchContextAggregator } = await loadAggregator();
  const adapter = eligibilityAdapter();
  const company = await adapter.readCompany("2330");
  adapter.readCompany = async () => ({
    ...company,
    source: { ...company.source, asOf: null, rowCount: 1, status: "available", error: null },
  });
  const calendar = await adapter.readTradingCalendar(options.asOfDate);
  adapter.readTradingCalendar = async () => ({
    ...calendar,
    source: { ...calendar.source, asOf: null, rowCount: calendar.data.dates.length, status: "available", error: null },
  });
  adapter.runStrategy = async (_stockId, strategy) => {
    if (strategy === "chips") throw new Error("chips unavailable");
    return {
      strategy, status: "ok", date: "2026-07-31", score: null,
      signal: "UNKNOWN", confidence: null, summary: null, details: {},
    };
  };

  const context = await new ResearchContextAggregator(adapter, options).aggregate("2330");
  assert.equal(context.quality.staleDatasets.includes("stock_meta"), false);
  assert.equal(context.quality.staleDatasets.includes("trading_calendar"), false);
  assert.equal(context.quality.staleDatasets.includes("strategy_chips"), false);
});

test("null asOf remains stale for non-empty freshness datasets", async () => {
  const { ResearchContextAggregator } = await loadAggregator();
  const adapter = eligibilityAdapter();
  const withoutAsOf = <T>(loader: (stockId: string) => Promise<ResearchDataset<T>>) => async (stockId: string) => {
    const result = await loader(stockId);
    return { ...result, source: { ...result.source, asOf: null, rowCount: Math.max(1, result.source.rowCount) } };
  };
  adapter.readMarket = withoutAsOf(adapter.readMarket);
  adapter.readInstitutional = withoutAsOf(adapter.readInstitutional);
  adapter.readTdcc = withoutAsOf(adapter.readTdcc);
  adapter.readFundamentals = withoutAsOf(adapter.readFundamentals);
  const risks = await adapter.readTradeRisks("2330");
  adapter.readTradeRisks = async () => ({
    data: { highestLevel: "medium", flags: [{ type: "attention" }], dataAsOf: null },
    source: { ...risks.source, asOf: null, rowCount: 1, status: "available", error: null },
  });

  const context = await new ResearchContextAggregator(adapter, options).aggregate("2330");
  assert.deepEqual(
    [...context.quality.staleDatasets].sort(),
    ["financials", "stock_institutional", "stock_price", "stock_trade_risk", "tdcc_shareholding"].sort(),
  );
});

test("optional loader errors retain explicit provenance without fabricated data", async () => {
  const { ResearchContextAggregator } = await loadAggregator();
  const adapter = eligibilityAdapter();
  adapter.readTdcc = async () => { throw new Error("tdcc upstream unavailable"); };

  const context = await new ResearchContextAggregator(adapter, options).aggregate("2330");
  const source = context.sources.find((item) => item.dataset === "tdcc_shareholding") as AuditedSource | undefined;
  assert.ok(source, "failed optional dataset must retain a source record");
  assert.equal(source.status === "error" || source.status === "unavailable", true);
  assert.equal(source.asOf, null);
  assert.equal(source.rowCount, 0);
  assert.match(source.error ?? "", /tdcc upstream unavailable/);
  assert.equal(context.quality.status, "partial");
  assert.deepEqual(context.tdcc, {
    date: null, source: null, totalShares: null, whaleRatio: null, retailRatio: null,
    totalPeople: null, whaleShares: null, whalePeople: null,
  });
});

test("company lookup errors fail as unavailable while empty metadata is ineligible", async () => {
  const { ResearchContextAggregator } = await loadAggregator();
  const unavailable = eligibilityAdapter();
  unavailable.readCompany = async () => { throw new Error("supabase unavailable"); };
  await assert.rejects(
    new ResearchContextAggregator(unavailable, options).aggregate("2330"),
    (error: unknown) => error instanceof Error && error.message === "research_context_unavailable",
  );

  const absent = eligibilityAdapter();
  const company = await absent.readCompany("2330");
  absent.readCompany = async () => ({
    data: {
      stockId: "2330", name: null, market: null, industry: null,
      status: "", type: "",
    },
    source: { ...company.source, rowCount: 0, asOf: null },
  });
  await assert.rejects(
    new ResearchContextAggregator(absent, options).aggregate("2330"),
    (error: unknown) => error instanceof Error && error.message === "stock_not_eligible_for_research",
  );
});

test("all strategy dates are normalized to the actual latest input price date", async () => {
  const { ResearchContextAggregator } = await loadAggregator();
  const adapter = eligibilityAdapter();
  const market = await adapter.readMarket("2330");
  adapter.readMarket = async () => ({
    ...market,
    data: { ...market.data, latestDate: "2026-07-31", history: [{ date: "2026-07-31", close: 1 }] },
    source: { ...market.source, asOf: "2026-07-31" },
  });
  adapter.runStrategy = async (_stockId, strategy) => ({
    strategy, status: "ok", date: "2099-01-01", score: 1, signal: "HOLD",
    confidence: 1, summary: null, details: {},
  });
  const context = await new ResearchContextAggregator(adapter, options).aggregate("2330");
  for (const strategy of ["sr", "ma", "chips", "pattern"] as const) {
    assert.equal(context.strategies[strategy].date, "2026-07-31");
  }

});

test("ResearchContextAggregator keeps zero, null, exact strategies, and source metadata", async () => {
  const { ResearchContextAggregator } = await loadAggregator();
  const strategies: StrategyId[] = [];
  const adapter = createResearchContextAdapter();
  const originalRunStrategy = adapter.runStrategy;
  adapter.runStrategy = async (stockId, strategy) => {
    strategies.push(strategy);
    return originalRunStrategy(stockId, strategy);
  };

  const context = await new ResearchContextAggregator(adapter).aggregate("2330");

  assert.equal(context.schemaVersion, 1);
  assert.equal(context.stockId, "2330");
  assert.equal(context.institutional.dailyFlows[0]?.foreignNet, 0);
  assert.equal(context.institutional.dailyFlows[0]?.dealerNet, 0);
  assert.equal(context.tdcc.retailRatio, null);
  assert.deepEqual(strategies, ["sr", "ma", "chips", "pattern"]);
  assert.deepEqual(Object.keys(context.strategies).sort(), ["chips", "ma", "pattern", "sr"]);
  assert.equal("prediction" in context.strategies, false);
  assert.equal("ai" in context.strategies, false);
  assert.ok(context.sources.length >= 6);
  for (const item of context.sources) {
    const audited = item as AuditedSource;
    assert.deepEqual(
      Object.keys(item).sort(),
      ["asOf", "dataset", "error", "estimated", "id", "provider", "retrievedAt", "rowCount", "status"].sort(),
    );
    assert.equal(typeof item.retrievedAt, "string");
    assert.equal(typeof item.rowCount, "number");
    assert.equal(typeof item.estimated, "boolean");
    assert.equal(audited.status, "available");
    assert.equal(audited.error, null);
  }
});

test("source aggregation expands every dataset, keeps first duplicate, and propagates child failures", async () => {
  const { ResearchContextAggregator } = await loadAggregator();
  const adapter = eligibilityAdapter();
  const originalCompany = adapter.readCompany;
  adapter.readCompany = async (stockId) => {
    const result = await originalCompany(stockId);
    return {
      ...result,
      source: provenance("company:primary", "stock_meta"),
      sources: [
        provenance("shared:duplicate", "company_first"),
        provenance("company:error", "company_child_error", "error", "company child failed"),
      ],
    };
  };
  const originalMarket = adapter.readMarket;
  adapter.readMarket = async (stockId) => {
    const result = await originalMarket(stockId);
    return {
      ...result,
      source: provenance("market:primary", "stock_price"),
      sources: [
        provenance("shared:duplicate", "market_conflict", "error", "must lose"),
        provenance("market:unavailable", "market_child_unavailable", "unavailable"),
      ],
    };
  };
  const originalTdcc = adapter.readTdcc;
  adapter.readTdcc = async (stockId) => {
    const result = await originalTdcc(stockId);
    return {
      ...result,
      source: provenance("tdcc:primary", "tdcc_shareholding"),
      sources: [
        provenance("tdcc:child", "tdcc_child"),
        provenance("shared:duplicate", "optional_conflict", "unavailable"),
      ],
    };
  };

  const context = await new ResearchContextAggregator(adapter, options).aggregate("2330");
  const ids = context.sources.map((source) => source.id);
  assert.equal(ids.length, new Set(ids).size, "final source ids must be unique");
  assert.equal(ids.filter((id) => id === "shared:duplicate").length, 1);
  assert.equal(context.sources.find((source) => source.id === "shared:duplicate")?.dataset, "company_first");
  assert.deepEqual(ids.slice(0, 8), [
    "company:primary", "shared:duplicate", "company:error",
    "market:primary", "market:unavailable", "finmind:financials",
    "supabase:stock_institutional", "tdcc:primary",
  ]);
  assert.ok(ids.includes("tdcc:child"), "optional child source must be retained");
  assert.ok(ids.indexOf("company:primary") < ids.indexOf("market:primary"));
  assert.ok(ids.indexOf("market:primary") < ids.indexOf("tdcc:primary"));
  assert.equal(context.quality.status, "partial");
  assert.ok(context.quality.missingDatasets.includes("company_child_error"));
  assert.ok(context.quality.missingDatasets.includes("market_child_unavailable"));
  assert.ok(context.quality.warnings.includes("company_child_error:company child failed"));
  assert.equal(context.quality.warnings.includes("market_conflict:must lose"), false);
});

test("optional dataset and one strategy failure produce partial context without fabricated results", async () => {
  const { ResearchContextAggregator } = await loadAggregator();
  const adapter = createResearchContextAdapter();
  adapter.readTdcc = async () => { throw new Error("tdcc unavailable"); };
  adapter.runStrategy = async (_stockId, strategy) => {
    if (strategy === "chips") throw new Error("chips unavailable");
    return {
      strategy,
      status: "ok",
      date: "2026-08-01",
      score: null,
      signal: "UNKNOWN",
      confidence: null,
      summary: null,
      details: {},
    };
  };

  const context = await new ResearchContextAggregator(adapter).aggregate("2330");

  assert.equal(context.quality.status, "partial");
  assert.ok(context.quality.missingDatasets.includes("tdcc_shareholding"));
  assert.equal(context.strategies.chips.strategy, "chips");
  assert.equal(context.strategies.chips.status, "error");
  assert.equal(
    context.strategies.chips.date,
    context.market.latestDate,
    "a failed strategy still traces the actual dated price input it attempted",
  );
  assert.equal(context.strategies.chips.score, null);
  assert.equal(context.strategies.chips.signal, "UNKNOWN");
  assert.equal(context.strategies.chips.summary, null);
  assert.deepEqual(context.strategies.chips.details, {});
  const chipsSource = context.sources.find((source) => source.dataset === "strategy_chips");
  assert.ok(chipsSource, "failed strategy must retain explicit source provenance");
  assert.equal(chipsSource.asOf, null);
  assert.equal(chipsSource.rowCount, 0);
  assert.equal(chipsSource.status, "error");
  assert.match(chipsSource.error ?? "", /chips unavailable/);
});

test("missing required market data fails closed with research_context_unavailable", async () => {
  const { ResearchContextAggregator } = await loadAggregator();
  const adapter = createResearchContextAdapter();
  adapter.readMarket = async () => { throw new Error("supabase unreachable"); };

  await assert.rejects(
    new ResearchContextAggregator(adapter).aggregate("2330"),
    (error: unknown) => error instanceof Error && error.message === "research_context_unavailable",
  );
});

test("aggregator uses injected adapters without SQLite sidecars or paid AI network", async () => {
  const { ResearchContextAggregator } = await loadAggregator();
  const sandbox = await mkdtemp(path.join(os.tmpdir(), "trinity-research-context-"));
  const bait = path.join(sandbox, "missing", "research-context-bait.db");
  const originalFetch = globalThis.fetch;
  const originalSqlitePath = process.env.SQLITE_DB_PATH;
  const originalTradeRiskPath = process.env.TRADE_RISK_SQLITE_PATH;
  let fetchCalls = 0;
  process.env.SQLITE_DB_PATH = bait;
  process.env.TRADE_RISK_SQLITE_PATH = bait;
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    throw new Error("network is forbidden in injected-adapter tests");
  }) as typeof fetch;

  try {
    await new ResearchContextAggregator(createResearchContextAdapter()).aggregate("2330");
    assert.equal(fetchCalls, 0, "aggregator must not call NVIDIA, OpenAI-compatible transports, or any network directly");
    assert.deepEqual(await readdir(sandbox), [], "SQLite bait DB, WAL, and SHM must not be created");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalSqlitePath === undefined) delete process.env.SQLITE_DB_PATH;
    else process.env.SQLITE_DB_PATH = originalSqlitePath;
    if (originalTradeRiskPath === undefined) delete process.env.TRADE_RISK_SQLITE_PATH;
    else process.env.TRADE_RISK_SQLITE_PATH = originalTradeRiskPath;
    await rm(sandbox, { recursive: true, force: true });
  }
});

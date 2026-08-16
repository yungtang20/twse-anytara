import assert from "node:assert/strict";
import "./tdcc-local-check";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import Database from "better-sqlite3";
import express from "express";
import { calcATR, calcRSI, type PriceData } from "../src/lib/indicators";
import { clampSidebarWidth } from "../src/components/Layout";
import { SupportResistanceEngine } from "../src/lib/strategy-engine";
import apiRouter from "../server/routes";
import {
  isLoopbackAddress,
  validateEnvValue,
} from "../server/lib/security";
import { buildStockSnapshot, formatSnapshotForPrompt } from "../server/lib/stockSnapshot";
import { validateEvidenceReport } from "../server/lib/evidenceReport";
import { runMigrations } from "../server/lib/migrations";
import { fetchWithOneRetry } from "../server/lib/fetchRetry";
import { withAbortSignal } from "../server/lib/mcpClient";
import { createJobDedupeKey, mapWithConcurrency } from "../server/lib/jobQueue";
import { selectFinMindDatasetNames } from "../server/lib/legacyFrameworkAnalysis";
import {
  filterTdccRecordsByEligibleStocks,
  classifyTdccCleanupCandidates,
  ingestTdccCSV,
  parseTdccCSV,
  saveTdccToSQLite,
  selectCoreCompleteTdccDates,
  selectTdccBackfillCandidates,
  summarizeTdccExclusionCounts,
  summarizeTdccCoverage,
} from "../server/lib/tdccDownload";
import { syncTdccPages } from "../server/lib/syncBridge";
import { isOrdinaryStockId } from "../server/lib/stockUniverse";
import { describeSupabaseError } from "../server/lib/supabaseDiagnostics";
import { ensureCanonicalSchema } from "../server/lib/sqliteSchema";
import { hasUsableLocalPriceRows } from "../server/lib/marketDataRepository";
import { resolveDatabasePath } from "../server/db";
import {
  applyTradeRiskPolicy, applyTradeRiskPolicyRows, buildStockTradeRiskResponse,
  TRADE_RISK_POLICY_ERROR, type StoredTradeRisk,
} from "../server/lib/tradeRisks";
import { listPendingCalendarDates } from "../scripts/lib/syncDates";
import { applyConsecutiveTrustDays, sortTrustBuyByDays } from "../server/routes/dashboard";
import { buildSimulatedPriceProjection } from "../server/lib/priceProjection";
import { analyzeChartPattern } from "../server/lib/patternStrategy";
import { DEFAULT_NVIDIA_MODEL, NVIDIA_BASE_URL, nvidiaModel } from "../server/lib/nvidiaAi";
import { parseInstitutionalHoldingSeries } from "../server/lib/institutionalHoldings";
import {
  INSTITUTIONAL_SELECT_COLUMNS,
  parseTpexInstitutionalRow,
} from "../server/lib/institutionalFlow";
import {
  createFinMindMemoryCache,
  FINMIND_CACHE_TTL_MS,
} from "../server/lib/finmindCache";
import {
  detectStatementBasis,
  normalizeFinancialSnapshot,
} from "../server/lib/financialNormalization";
import { appViewHash, parseAppView } from "../src/lib/navigation";
import { buildIntegratedMarketData } from "../src/lib/integratedMarketData";
import {
  buildSupportResistanceLines,
  selectExtremeAnchors,
  selectTrendAnchors,
} from "../src/lib/trendLines";
import {
  formatPriceAxisTick,
  formatTrendLegendLabel,
  mondayTicks,
} from "../src/lib/chartFormatting";

const rising = Array.from({ length: 20 }, (_, index) => 100 + index);
assert.equal(NVIDIA_BASE_URL, "https://integrate.api.nvidia.com/v1");
assert.equal(DEFAULT_NVIDIA_MODEL, "z-ai/glm-5.2");
assert.equal(nvidiaModel(), process.env.NVIDIA_MODEL || DEFAULT_NVIDIA_MODEL);
const holdingSnapshot = parseInstitutionalHoldingSeries("2330", "https://example.test/2330.json", [
  { date: "2026-07-30", foreign_ratio: 68, trust_ratio: 1, dealer_ratio: 0.5, three_inst_ratio: 69.5 },
  { date: "2026-07-31", foreign_ratio: 69, trust_ratio: 1.1, dealer_ratio: 0.6, three_inst_ratio: 70.7 },
], "2026-08-01");
assert.equal(holdingSnapshot.date, "2026-07-31");
assert.equal(holdingSnapshot.totalRatio, 70.7);
assert.equal(holdingSnapshot.ageDays, 1);
assert.equal(holdingSnapshot.stale, false);
assert.equal(Number(holdingSnapshot.trustRatioChange?.toFixed(4)), 0.1);
assert.equal(FINMIND_CACHE_TTL_MS, 30 * 60 * 1000);

let cacheNow = 0;
let cacheLoads = 0;
const memoryCache = createFinMindMemoryCache({ capacity: 2, ttlMs: 100, now: () => cacheNow });
const cacheRequest = { stockId: "2330", dataset: "TaiwanStockFinancialStatements", startDate: "2023-01-01", endDate: "2026-01-01" };
assert.equal((await memoryCache.load(cacheRequest, async () => { cacheLoads++; return [{ value: 1 }]; })).status, "miss");
assert.equal((await memoryCache.load(cacheRequest, async () => { cacheLoads++; return [{ value: 2 }]; })).status, "hit");
assert.equal(cacheLoads, 1, "fresh FinMind memory cache entries must skip the loader");
cacheNow = 101;
assert.equal((await memoryCache.load(cacheRequest, async () => { cacheLoads++; return [{ value: 3 }]; })).status, "miss");
assert.equal(cacheLoads, 2, "expired FinMind memory cache entries must reload");

let releaseFinMindLoad: ((rows: Array<Record<string, unknown>>) => void) | undefined;
const sharedRequest = { ...cacheRequest, dataset: "TaiwanStockBalanceSheet" };
const firstLoad = memoryCache.load(sharedRequest, () => new Promise((resolve) => { cacheLoads++; releaseFinMindLoad = resolve; }));
const sharedLoad = memoryCache.load(sharedRequest, async () => { cacheLoads++; return [{ value: 5 }]; });
await Promise.resolve();
assert.ok(releaseFinMindLoad);
releaseFinMindLoad([{ value: 4 }]);
assert.deepEqual((await Promise.all([firstLoad, sharedLoad])).map((result) => result.status), ["miss", "shared"]);
assert.equal(cacheLoads, 3, "identical in-flight FinMind requests must share one loader");

let boundedLoads = 0;
const boundedCache = createFinMindMemoryCache({ capacity: 1, ttlMs: 100 });
const loadBounded = async (request: typeof cacheRequest) => boundedCache.load(request, async () => [{ value: ++boundedLoads }]);
await loadBounded(cacheRequest);
await loadBounded({ ...cacheRequest, dataset: "TaiwanStockCashFlowsStatement" });
await loadBounded(cacheRequest);
assert.equal(boundedLoads, 3, "FinMind memory cache must evict entries beyond its capacity");

type FinancialFixtureOptions = {
  cashBasis?: "single-quarter" | "ytd-cumulative";
  positiveCapex?: boolean;
  omitIncomeDate?: string;
  financialIndustry?: boolean;
};

function financialFixture(options: FinancialFixtureOptions = {}) {
  const dates = ["2024-12-31", "2025-03-31", "2025-06-30", "2025-09-30", "2025-12-31"];
  const ytd = [40, 10, 30, 60, 100];
  const incomeTypes = ["Revenue", "GrossProfit", "OperatingIncome", "IncomeAfterTaxes", "EPS"];
  const incomeFactors = [1, 0.5, 0.3, 0.2, 0.1];
  const income = dates.flatMap((date, dateIndex) => incomeTypes.map((type, typeIndex) => ({
    date, type, value: ytd[dateIndex] * incomeFactors[typeIndex],
    origin_name: type === "Revenue" ? "營業收入合計" : type,
    period_type: "ytd-cumulative",
  }))).filter((row) => row.date !== options.omitIncomeDate);
  income.push({ date: "2025-12-31", type: "Revenue", value: 9999, origin_name: "其他收入", period_type: "ytd-cumulative" });
  const cfo = [40, 10, 25, 45, 70];
  const capex = [-8, -2, -5, -9, -14].map((value) => options.positiveCapex ? Math.abs(value) : value);
  const cash = dates.flatMap((date, index) => [
    { date, type: "CashFlowsFromOperatingActivities", value: cfo[index], origin_name: "營業活動之淨現金流入", period_type: options.cashBasis || "ytd-cumulative" },
    { date, type: "PropertyAndPlantAndEquipment", value: capex[index], origin_name: "取得不動產、廠房及設備", period_type: options.cashBasis || "ytd-cumulative" },
  ]);
  const balance = dates.flatMap((date, index) => [
    { date, type: "CurrentAssets", value: 200 + index * 10, origin_name: "流動資產" },
    { date, type: "CurrentLiabilities", value: 100 + index * 5, origin_name: "流動負債" },
    { date, type: "Liabilities", value: 80 + index * 5, origin_name: "負債總額" },
    { date, type: "Equity", value: 90 + index * 10, origin_name: "權益總額" },
    { date, type: "CashAndCashEquivalents", value: 50 + index, origin_name: "現金及約當現金" },
  ]);
  return normalizeFinancialSnapshot("TEST", [
    { dataset: "TaiwanStockFinancialStatements", rows: income },
    { dataset: "TaiwanStockCashFlowsStatement", rows: cash },
    { dataset: "TaiwanStockBalanceSheet", rows: balance },
  ], options.financialIndustry ? { industry: "金融保險業" } : { industry: "半導體業" }, "2026-01-15T00:00:00.000Z");
}

const normalizedFinancials = financialFixture();
assert.equal(detectStatementBasis("TaiwanStockFinancialStatements", [{ period_type: "ytd-cumulative" }]), "ytd-cumulative");
assert.equal(detectStatementBasis("TaiwanStockCashFlowsStatement", []), "ytd-cumulative");
assert.equal(detectStatementBasis("TaiwanStockBalanceSheet", []), "point-in-time");
const normalized2025 = normalizedFinancials.quarters.filter((quarter) => quarter.date.startsWith("2025"));
assert.deepEqual(normalized2025.map((quarter) => quarter.metrics.revenue.value), [10, 20, 30, 40], "Q1-Q4 cumulative income values must become single quarters");
assert.deepEqual(normalized2025.map((quarter) => quarter.metrics.eps.value), [1, 2, 3, 4], "EPS must use the same cumulative-to-quarter conversion");
assert.deepEqual(normalized2025.map((quarter) => quarter.metrics.operatingCashFlow.value), [10, 15, 20, 25]);
assert.deepEqual(normalized2025.map((quarter) => quarter.metrics.capitalExpenditure.value), [2, 3, 4, 5], "CapEx outflows must normalize to positive spend");
assert.deepEqual(normalized2025.map((quarter) => quarter.metrics.freeCashFlow.value), [8, 12, 16, 20], "FCF must equal CFO minus absolute CapEx");
assert.equal(normalized2025[1].metrics.equity.value, 110, "balance-sheet stocks must never be quarter-subtracted");
assert.equal(normalized2025[1].metrics.currentRatio.periodBasis, "point-in-time");
assert.equal(normalizedFinancials.ttm.revenue.value, 100);
assert.equal(normalizedFinancials.ttm.eps.value, 10);
assert.equal(normalizedFinancials.ttm.operatingCashFlow.value, 70);
assert.equal(normalizedFinancials.ttm.freeCashFlow.value, 56);
assert.equal(normalizedFinancials.ttm.roe.periodBasis, "ttm");
assert.equal(normalized2025.at(-1)?.metrics.revenue.sources[0].originName, "營業收入合計", "duplicate metric selection must use deterministic origin priority");

const positiveCapex = financialFixture({ cashBasis: "single-quarter", positiveCapex: true });
assert.equal(positiveCapex.quarters.find((quarter) => quarter.date === "2025-03-31")?.metrics.freeCashFlow.value, 8, "positive or negative reported CapEx must produce the same normalized FCF rule");
const missingQuarter = financialFixture({ omitIncomeDate: "2025-06-30" });
assert.equal(missingQuarter.quarters.find((quarter) => quarter.date === "2025-09-30")?.metrics.revenue.missingReason, "missing_previous_cumulative_quarter");
assert.equal(missingQuarter.ttm.revenue.value, null, "TTM must not bridge a missing quarter");
const bankFinancials = financialFixture({ financialIndustry: true });
const bankLatest = bankFinancials.quarters.at(-1)!;
for (const metric of [bankLatest.metrics.grossMargin, bankLatest.metrics.currentRatio, bankLatest.metrics.debtRatio, bankLatest.metrics.freeCashFlow]) {
  assert.equal(metric.value, null);
  assert.equal(metric.missingReason, "not_applicable_financial_industry");
}
assert.notEqual(bankLatest.metrics.eps.value, null);
assert.notEqual(bankLatest.metrics.netIncome.value, null);
assert.notEqual(bankLatest.metrics.equity.value, null);
assert.notEqual(bankFinancials.ttm.roe.value, null);
assert.equal(bankLatest.metrics.currentRatio.periodBasis, "point-in-time");
assert.equal(bankFinancials.ttm.freeCashFlow.periodBasis, "ttm");
assert.equal(normalizeFinancialSnapshot("2881", [], { companyName: "富邦金", industry: "" }).isFinancialIndustry, true, "financial stock IDs and names must work when stock_meta industry is blank");

let failedCacheLoads = 0;
const failureCache = createFinMindMemoryCache({ capacity: 2, ttlMs: 100 });
await assert.rejects(failureCache.load(cacheRequest, async () => { failedCacheLoads++; throw new Error("FinMind unavailable"); }));
const recovered = await failureCache.load(cacheRequest, async () => { failedCacheLoads++; return [{ value: 7 }]; });
assert.equal(recovered.status, "miss");
assert.equal(failedCacheLoads, 2, "failed FinMind responses must not be cached as data");

for (const runtimeFile of [
  "server/lib/finmindCache.ts",
  "server/lib/legacyFrameworkAnalysis.ts",
  "server/routes/fundamentals.ts",
]) {
  const source = readFileSync(path.join(process.cwd(), runtimeFile), "utf8");
  assert.equal(source.includes("stock_dataset_cache"), false, `${runtimeFile} must not access Supabase stock_dataset_cache`);
}

function patternFixture(kind: "bottom" | "top", secondIndex = 50, confirmed = true) {
  const rows = Array.from({ length: 60 }, (_, index) => {
    const base = kind === "bottom" ? 100 : 120;
    const date = new Date(Date.UTC(2026, 0, index + 1)).toISOString().slice(0, 10);
    return {
      stock_id: "TEST", date, open: base, high: base + 2, low: base - 2,
      close: base, volume: index === 59 ? 2_000 : 1_000,
    };
  });
  if (kind === "bottom") {
    rows[30].low = 90;
    rows[40].high = 110;
    rows[secondIndex].low = 91;
    rows[59].close = confirmed ? 112 : 105;
    rows[59].high = Math.max(rows[59].high, rows[59].close + 1);
  } else {
    rows[30].high = 130;
    rows[40].low = 108;
    rows[secondIndex].high = 129;
    rows[59].close = confirmed ? 106 : 115;
    rows[59].low = Math.min(rows[59].low, rows[59].close - 1);
  }
  return rows;
}

const confirmedBottom = analyzeChartPattern(patternFixture("bottom"));
assert.equal(confirmedBottom.patternName, "W底");
assert.equal(confirmedBottom.stage, "confirmed");
assert.equal(confirmedBottom.secondPivot?.price, 91);
assert.equal(confirmedBottom.breakoutDate, "2026-03-01");
assert.ok(confirmedBottom.confidence >= 0.7);
const formingBottom = analyzeChartPattern(patternFixture("bottom", 50, false));
assert.equal(formingBottom.patternName, "W底");
assert.equal(formingBottom.stage, "forming");
const confirmedTop = analyzeChartPattern(patternFixture("top"));
assert.equal(confirmedTop.patternName, "M頂");
assert.equal(confirmedTop.stage, "confirmed");
assert.equal(
  analyzeChartPattern(patternFixture("bottom", 45)).stage,
  "none",
  "patterns whose second pivot is older than ten bars must not be shown",
);
const syncRouteSource = readFileSync(
  path.join(process.cwd(), "server", "routes", "syncBackfill.ts"),
  "utf8",
);
const settingsRouteSource = readFileSync(
  path.join(process.cwd(), "server", "routes", "settings.ts"),
  "utf8",
);
const cloudSyncSource = readFileSync(
  path.join(process.cwd(), "scripts", "syncData.ts"),
  "utf8",
);
const retentionMigrationSource = readFileSync(
  path.join(process.cwd(), "supabase", "migrations", "20260731030000_align_market_retention.sql"),
  "utf8",
);
const volumeUnitMigrationSource = readFileSync(
  path.join(
    process.cwd(),
    "supabase",
    "migrations",
    "20260731043043_normalize_stock_price_volume_units.sql",
  ),
  "utf8",
);
const chipsChartSource = readFileSync(
  path.join(process.cwd(), "src", "components", "ChipsBarChart.tsx"),
  "utf8",
);
const klineChartSource = readFileSync(
  path.join(process.cwd(), "src", "components", "KlineChart.tsx"),
  "utf8",
);
const integratedPanelsSource = readFileSync(
  path.join(process.cwd(), "src", "components", "IntegratedMarketPanels.tsx"),
  "utf8",
);
const marketsViewSource = readFileSync(
  path.join(process.cwd(), "src", "components", "views", "MarketsView.tsx"),
  "utf8",
);
const marketWorkflowSource = readFileSync(
  path.join(process.cwd(), ".github", "workflows", "supabase-market-sync.yml"),
  "utf8",
);
const tdccWorkflowSource = readFileSync(
  path.join(process.cwd(), ".github", "workflows", "supabase-tdcc-sync.yml"),
  "utf8",
);
const triggerUpdateSource = syncRouteSource.split('router.post("/api/trigger-update"')[1]
  ?.split('// GET Endpoint to poll sync progress')[0] || "";
assert.match(
  triggerUpdateSource,
  /scripts[\\/]syncData\.ts/,
  "the web update action must upload the latest market data to Supabase",
);
assert.doesNotMatch(
  triggerUpdateSource,
  /complete_and_fetch_today|pull_from_supabase/,
  "the Supabase web update action must remain independent from local SQLite sync",
);
assert.match(
  settingsRouteSource,
  /router\.post\("\/api\/settings\/sync-bridge"[\s\S]*?status\(410\)/,
  "the retired bidirectional bridge must not mix Supabase and local SQLite",
);
assert.match(cloudSyncSource, /INITIAL_INSTITUTIONAL_DATES = 60/);
assert.match(cloudSyncSource, /INSTITUTIONAL_RETENTION = 512/);
assert.match(cloudSyncSource, /TDCC_RETENTION = 512/);
assert.match(cloudSyncSource, /PRICE_RETENTION - status\.price_dates/);
assert.doesNotMatch(cloudSyncSource, /downloadTdccCSV|syncTdccCloud/, "cloud market sync must not independently download TDCC");
assert.match(marketWorkflowSource, /cron: "0 10 \* \* \*"/);
assert.match(marketWorkflowSource, /scripts\/dispatchDailySync\.ts/);
assert.match(marketWorkflowSource, /scripts\/syncOfficialTdccCloud\.ts --execute/);
assert.match(marketWorkflowSource, /SYNC_SCOPE: market/);
assert.doesNotMatch(tdccWorkflowSource, /cron:/, "cloud-only TDCC schedule must remain disabled");
assert.match(tdccWorkflowSource, /Historical 52-week backfill is not automated[\s\S]*requires explicit approval/);
assert.match(tdccWorkflowSource, /Local SQLite must not be used as a production cloud-backfill source/);
assert.doesNotMatch(tdccWorkflowSource, /remains local-first/);
assert.doesNotMatch(marketsViewSource, /\/api\/sync-status|\/api\/trigger-update/);
assert.match(marketsViewSource, /Supabase 資料庫日期/);
assert.equal(isOrdinaryStockId("2330"), true);
assert.equal(isOrdinaryStockId("9910"), true);
assert.equal(isOrdinaryStockId("0050"), false);
assert.equal(isOrdinaryStockId("9103"), false);

const tpexInstitutionalFixture = JSON.parse(readFileSync(
  path.join(process.cwd(), "tests", "fixtures", "tpex-institutional-24-columns.json"),
  "utf8",
)) as { date: string; row: unknown[] };
assert.equal(tpexInstitutionalFixture.row.length, 24, "TPEx official institutional fixture must have exactly 24 columns");
const parsedTpexInstitutional = parseTpexInstitutionalRow(
  tpexInstitutionalFixture.row,
  tpexInstitutionalFixture.date,
);
assert.ok(parsedTpexInstitutional);
assert.equal(parsedTpexInstitutional.foreign_net, 800);
assert.equal(parsedTpexInstitutional.trust_net, -200);
assert.equal(parsedTpexInstitutional.dealer_net, 50);
assert.equal(parsedTpexInstitutional.institutional_net, 650);
assert.equal(
  parsedTpexInstitutional.institutional_net,
  parsedTpexInstitutional.foreign_net + parsedTpexInstitutional.trust_net + parsedTpexInstitutional.dealer_net,
  "institutional_net must always be recomputed from the three institutional net fields",
);
const invalidTpexTotal = [...tpexInstitutionalFixture.row];
invalidTpexTotal[23] = "999";
assert.throws(
  () => parseTpexInstitutionalRow(invalidTpexTotal, tpexInstitutionalFixture.date),
  /TPEx institutional total mismatch/,
);
assert.equal(
  INSTITUTIONAL_SELECT_COLUMNS,
  "date, foreign_net, trust_net, dealer_net, institutional_net",
);
const stockRoutesInstitutionalSource = readFileSync(
  path.join(process.cwd(), "server", "routes", "stocks.ts"),
  "utf8",
);
assert.match(
  stockRoutesInstitutionalSource,
  /stock_institutional"\)[\s\S]*?\.select\(INSTITUTIONAL_SELECT_COLUMNS\)/,
  "quote API must select foreign, trust, dealer and institutional net fields together",
);
assert.equal(isOrdinaryStockId("2881A"), false);
assert.deepEqual(
  sortTrustBuyByDays([
    { stock_id: "2886", trust_days: 10 },
    { stock_id: "2027", trust_days: 6 },
    { stock_id: "1326", trust_days: 6 },
  ]),
  [
    { stock_id: "1326", trust_days: 6 },
    { stock_id: "2027", trust_days: 6 },
    { stock_id: "2886", trust_days: 10 },
  ],
);
assert.deepEqual(
  applyConsecutiveTrustDays(
    [{ stock_id: "2330", trust_days: 9 }, { stock_id: "2317", trust_days: 9 }],
    [
      { stock_id: "2330", date: "2026-08-14", trust_net: 10 },
      { stock_id: "2330", date: "2026-08-13", trust_net: 20 },
      { stock_id: "2330", date: "2026-08-12", trust_net: -1 },
      { stock_id: "2330", date: "2026-08-11", trust_net: 30 },
      { stock_id: "2317", date: "2026-08-14", trust_net: 0 },
    ],
  ),
  [{ stock_id: "2330", trust_days: 2 }, { stock_id: "2317", trust_days: 0 }],
  "trust_days must count only the uninterrupted latest positive-buy streak",
);
assert.deepEqual(
  buildIntegratedMarketData(
    ["2026-07-31"],
    [{ date: "2026-07-31", foreign_net: -3_957_455, trust_net: 7_046_889, dealer_net: 2_724_666 }],
    [],
  )[0],
  { date: "2026-07-31", foreign: -3957, trust: 7046, dealer: 2724, whaleRatio: null },
  "institutional shares must use the same whole-lot truncation in every chart and table",
);
assert.deepEqual(
  mondayTicks(["2026-07-24", "2026-07-27", "2026-07-31", "2026-08-03"]),
  ["2026-07-27", "2026-08-03"],
);
assert.equal(parseAppView(""), "dashboard");
assert.equal(parseAppView("#/dashboard"), "dashboard");
assert.equal(parseAppView("#/markets"), "markets");
assert.equal(parseAppView("#/strategies"), "strategies");
assert.equal(parseAppView("#/ai-analysis"), "ai-analysis");
assert.equal(parseAppView("#/settings"), "settings");
assert.equal(parseAppView("#/unknown"), "dashboard");
assert.equal(appViewHash("markets"), "#/markets");

const indexHtml = readFileSync(path.join(process.cwd(), "index.html"), "utf8");
assert.match(indexHtml, /<title>TRINITY 台股決策研究平台<\/title>/);
assert.doesNotMatch(indexHtml, /My Google AI Studio App/);
const simulatedProjection = buildSimulatedPriceProjection(
  Array.from({ length: 20 }, (_, index) => ({ close: 100 + index })),
);
assert.equal(simulatedProjection.isSimulated, true);
assert.equal(simulatedProjection.predictions.length, 5);
assert.match(simulatedProjection.disclaimer, /不代表未來價格/);
assert.deepEqual(
  buildIntegratedMarketData(
    ["2026-07-23", "2026-07-24", "2026-07-27", "T+1", "T+5"],
    [
      { date: "2026-07-24", foreign_net: 1_500_000, trust_net: -250_000, dealer_net: 75_000 },
      { date: "2026-07-27", foreign_net: -500_000, trust_net: 100_000, dealer_net: -25_000 },
    ],
    [
      { date: "2026-07-18", ratio: 60.5 },
      { date: "2026-07-25", ratio: 61.25 },
    ],
  ),
  [
    { date: "2026-07-23", foreign: null, trust: null, dealer: null, whaleRatio: 60.5 },
    { date: "2026-07-24", foreign: 1500, trust: -250, dealer: 75, whaleRatio: 60.5 },
    { date: "2026-07-27", foreign: -500, trust: 100, dealer: -25, whaleRatio: 61.25 },
    { date: "T+1", foreign: null, trust: null, dealer: null, whaleRatio: null },
    { date: "T+5", foreign: null, trust: null, dealer: null, whaleRatio: null },
  ],
);
const trendRows: PriceData[] = Array.from({ length: 60 }, (_, index) => ({
  date: `D${index + 1}`,
  open: 100,
  high: index === 5 ? 200 : index === 10 ? 190 : index === 40 ? 180 : index === 50 ? 170 : 120,
  low: index === 6 ? 40 : index === 11 ? 45 : index === 41 ? 50 : index === 51 ? 55 : 80,
  close: index === 5
    ? 160
    : index === 6
      ? 60
      : index === 10
        ? 150
        : index === 11
          ? 65
          : index === 40
            ? 150
            : index === 41
              ? 70
              : index === 50
                ? 140
                : index === 51
                  ? 75
                  : 100,
  volume: 1_000,
}));
const trendLines = buildSupportResistanceLines(trendRows, 59);
trendRows.forEach((row, index) => {
  if (index >= 35) {
    assert.ok(
      trendLines.shortResistance[index] !== null
        && trendLines.shortResistance[index] >= row.high,
      `short resistance must stay above the high at index ${index}`,
    );
    assert.ok(
      trendLines.shortSupport[index] !== null
        && trendLines.shortSupport[index] <= row.low,
      `short support must stay below the low at index ${index}`,
    );
  }
  assert.ok(
    trendLines.longResistance[index] !== null
      && trendLines.longResistance[index] >= row.close,
    `long resistance must stay above the close at index ${index}`,
  );
  assert.ok(
    trendLines.longSupport[index] !== null
      && trendLines.longSupport[index] <= row.close,
    `long support must stay below the close at index ${index}`,
  );
});
const adjacentExtremes: PriceData[] = Array.from({ length: 60 }, (_, index) => ({
  date: `A${index + 1}`,
  open: 300,
  high: index === 59 ? 550 : index === 40 ? 500 : index === 46 ? 490 : 400 + index * 0.1,
  low: index === 0 ? 90 : index === 10 ? 100 : index === 30 ? 150 : 300 + index * 0.1,
  close: 300,
  volume: 1_000,
}));
assert.deepEqual(
  selectTrendAnchors(adjacentExtremes, 59, 60, "high", true).map(({ index }) => index),
  [59, 46],
  "anchors must use the two most recent distinct highs when scanning newest-first",
);
assert.deepEqual(
  selectTrendAnchors(adjacentExtremes, 59, 60, "low", false).map(({ index }) => index),
  [30, 10],
  "support anchors must use the two strongest distinct lows and remain newest-first",
);
const edgeAwareSwings: PriceData[] = Array.from({ length: 30 }, (_, index) => ({
  date: `S${index + 1}`,
  open: 100,
  high: index === 12 ? 150 : index === 29 ? 140 : 100 + index * 0.01,
  low: index === 4 ? 30 : index === 5 ? 40 : index === 15 ? 50 : index === 29 ? 45 : 80 + index * 0.01,
  close: 100,
  volume: 1_000,
}));
assert.deepEqual(
  selectTrendAnchors(edgeAwareSwings, 29, 25, "high", true).map(({ index }) => index),
  [29, 12],
  "the latest candle may be a visually confirmed one-sided swing",
);
assert.deepEqual(
  selectTrendAnchors(edgeAwareSwings, 29, 25, "low", false).map(({ index }) => index),
  [29, 15],
  "the window start must use earlier candles for confirmation while the latest low remains selectable",
);
const plateauSwings: PriceData[] = Array.from({ length: 25 }, (_, index) => ({
  date: `P${index + 1}`,
  open: 100,
  high: index === 10 || index === 11
    ? 150
    : index >= 18
      ? 140 - (index - 18)
      : 100 + index * 0.01,
  low: 80 + index * 0.01,
  close: 100,
  volume: 1_000,
}));
assert.deepEqual(
  selectTrendAnchors(plateauSwings, 24, 25, "high", true).map(({ index }) => index),
  [18, 11],
  "adjacent candles on the same plateau must count as one swing high",
);
const mixedPriceBasis: PriceData[] = Array.from({ length: 60 }, (_, index) => ({
  date: `M${index + 1}`,
  open: 100,
  high: index === 10 ? 500 : index === 40 ? 400 : 110,
  low: index === 15 ? 1 : index === 45 ? 2 : 90,
  close: index === 20 ? 160 : index === 50 ? 150 : 100,
  volume: 1_000,
}));
assert.deepEqual(
  selectTrendAnchors(mixedPriceBasis, 59, 60, "close", true).map(({ index }) => index),
  [50, 20],
  "long-term pressure anchors must be selectable from closes instead of intraday highs",
);
assert.deepEqual(
  selectTrendAnchors(mixedPriceBasis, 59, 60, "close", false).map(({ index }) => index),
  [52, 22],
  "long-term support anchors must follow closing-price valleys instead of intraday lows",
);
const longCloseExtremes: PriceData[] = Array.from({ length: 60 }, (_, index) => ({
  date: `L${index + 1}`,
  open: 100,
  high: 120,
  low: 80,
  close: index === 10
    ? 200
    : index === 20
      ? 190
      : index === 30
        ? 40
        : index === 40
          ? 50
          : index === 50
            ? 180
            : index === 55
              ? 60
              : 100,
  volume: 1_000,
}));
assert.deepEqual(
  selectExtremeAnchors(longCloseExtremes, 59, 60, "close", true).map(({ index }) => index),
  [20, 10],
  "long resistance must start from the two highest distinct closing-price peaks",
);
assert.deepEqual(
  selectExtremeAnchors(longCloseExtremes, 59, 60, "close", false).map(({ index }) => index),
  [40, 30],
  "long support must start from the two lowest distinct closing-price valleys",
);
const clusteredLongPeaks: PriceData[] = Array.from({ length: 60 }, (_, index) => ({
  date: `P${index + 1}`,
  open: 70,
  high: 100,
  low: 40,
  close: index === 20 ? 88.7 : index === 21 ? 87 : index === 37 ? 85.7 : 70,
  volume: 1_000,
}));
assert.deepEqual(
  selectExtremeAnchors(clusteredLongPeaks, 59, 60, "close", true).map(({ index }) => index),
  [37, 20],
  "an adjacent candle from the same peak must not replace the second distinct peak",
);
const latestDayBoundaryBreak: PriceData[] = Array.from({ length: 25 }, (_, index) => ({
  date: `R${index + 1}`,
  open: 100,
  high: index === 5 ? 200 : index === 15 ? 190 : index === 24 ? 189 : 100,
  low: index === 5 ? 50 : index === 15 ? 60 : index === 24 ? 61 : 100,
  close: 100,
  volume: 1_000,
}));
const latestDayLines = buildSupportResistanceLines(latestDayBoundaryBreak, 24);
assert.ok(
  Number(latestDayLines.shortResistance[24]) >= latestDayBoundaryBreak[24].high,
  "short resistance must restart from the latest day when a later high crosses the line",
);
assert.ok(
  Number(latestDayLines.shortSupport[24]) <= latestDayBoundaryBreak[24].low,
  "short support must restart from the latest day when a later low crosses the line",
);
assert.equal(formatPriceAxisTick(49.999999999), "50.00");
assert.equal(formatPriceAxisTick(277.5), "277.50");
assert.equal(formatTrendLegendLabel("長壓60", 81.6), "長壓60 81.60");
assert.match(klineChartSource, /label: '均線'/);
assert.doesNotMatch(
  klineChartSource,
  /useState\(true\)/,
  "chart indicators must be opt-in rather than enabled on first load",
);
assert.doesNotMatch(klineChartSource, /均線 MA25\/60\/200/);
assert.match(klineChartSource, /\(\[26, 61, 201\] as const\)/);
assert.doesNotMatch(klineChartSource, /\[30, 60, 120, 250, 512\]/);
assert.doesNotMatch(klineChartSource, /institutionalLayer/);
assert.match(klineChartSource, /aria-pressed=\{item\.state\}/);
assert.match(klineChartSource, /showForeign/);
assert.match(klineChartSource, /showTrust/);
assert.match(klineChartSource, /showShareholding/);
assert.match(klineChartSource, /visibleDates=\{chartData\.map/);
assert.doesNotMatch(klineChartSource, /Kronos|kronos/);
assert.doesNotMatch(klineChartSource, /const drift =/);
assert.equal(klineChartSource.split("<Tooltip content={<CustomTooltip />} />").length - 1, 0);
assert.match(klineChartSource, /function CandlestickShape/);
assert.match(klineChartSource, /aria-live="polite"/);
assert.match(klineChartSource, /onMouseMove=\{handleChartMouseMove\}/);
assert.match(klineChartSource, /domain=\{priceDomain\}/);
assert.match(klineChartSource, /tickFormatter=\{formatPriceAxisTick\}/);
assert.match(klineChartSource, /<IndicatorValue label="短壓25"/);
assert.match(klineChartSource, /<VolumeDataStrip datum=\{displayDatum\} showVolMAs=\{showVolMAs\}/);
assert.match(klineChartSource, /<IndicatorValue label="VolMA5"/);
assert.match(klineChartSource, /<IndicatorValue label="VolMA60"/);
assert.match(klineChartSource, /activeDate=\{displayDatum\?\.date\}/);
assert.doesNotMatch(klineChartSource, /function LineLegend/);
assert.match(integratedPanelsSource, /selectedDate = hoveredDate \?\? activeDate/);
assert.match(integratedPanelsSource, /<InvisibleTooltip \/>/);
assert.doesNotMatch(integratedPanelsSource, /function PanelTooltip/);
assert.match(klineChartSource, /allowDataOverflow/);
assert.doesNotMatch(klineChartSource, /dataKey="wickRange"/);
assert.doesNotMatch(klineChartSource, /dataKey="boxRange"/);
assert.doesNotMatch(klineChartSource, /const CustomTooltip/);
assert.match(klineChartSource, /<IndicatorValue label="MA25"/);
assert.match(klineChartSource, /<IndicatorValue label="MA60"/);
assert.match(klineChartSource, /<IndicatorValue label="MA200"/);
const legacyFrameworkAnalysisSource = readFileSync(
  path.join(process.cwd(), "server", "lib", "legacyFrameworkAnalysis.ts"),
  "utf8",
);
assert.match(legacyFrameworkAnalysisSource, /return token && failed \? request\(""\) : first/);
assert.doesNotMatch(legacyFrameworkAnalysisSource, /error: "missing_api_key"/);
assert.match(retentionMigrationSource, /offset \(price_rows - 1\)/);
assert.match(volumeUnitMigrationSource, /set volume = volume \* 1000/);
assert.match(volumeUnitMigrationSource, /volume < 1000000/);
const finMindCacheMigrationSource = readFileSync(
  path.join(process.cwd(), "supabase", "migrations", "20260731040000_expand_finmind_cache.sql"),
  "utf8",
);
for (const dataset of ["institutional", "margin", "dividend", "foreign_shareholding"]) {
  assert.match(finMindCacheMigrationSource, new RegExp(`'${dataset}'`));
}
for (const table of ["stock_price", "stock_institutional", "tdcc_shareholding"]) {
  assert.match(
    retentionMigrationSource,
    new RegExp(`delete from public\\.${table} where date < shared_cutoff`),
    `${table} must use the shared 512-price-date cutoff`,
  );
}
assert.doesNotMatch(chipsChartSource, /slice\(-20\)/, "chip charts must use the full retained API range");
assert.deepEqual(
  listPendingCalendarDates("2026-07-24", "2026-07-31"),
  [
    "2026-07-25", "2026-07-26", "2026-07-27", "2026-07-28",
    "2026-07-29", "2026-07-30", "2026-07-31",
  ],
  "Supabase catch-up must not skip dates between the cloud maximum and today",
);
const sqliteResolutionCwd = path.resolve("fixtures", "runtime");
const sqliteResolutionRelative = path.join("nested", "smoke.db");
assert.equal(
  resolveDatabasePath(sqliteResolutionCwd, sqliteResolutionRelative),
  path.resolve(sqliteResolutionCwd, sqliteResolutionRelative),
  "configured SQLite paths must resolve relative to the process directory",
);
const freshLocalRows = Array.from({ length: 30 }, (_, index) => ({
  date: `2026-07-${String(index + 1).padStart(2, "0")}`,
  open: 1,
  high: 1,
  low: 1,
  close: 1,
  volume: 1,
}));
assert.equal(
  hasUsableLocalPriceRows(freshLocalRows, new Date("2026-08-01T00:00:00+08:00").getTime()),
  true,
  "explicit local mode may use sufficiently fresh local prices",
);
assert.equal(
  hasUsableLocalPriceRows(freshLocalRows, new Date("2026-08-15T00:00:00+08:00").getTime()),
  false,
  "explicit local mode must reject stale local prices",
);
assert.equal(clampSidebarWidth(100, 1200), 132, "sidebar width must keep navigation usable");
assert.equal(clampSidebarWidth(500, 800), 288, "sidebar width must preserve responsive content space");
assert.equal(clampSidebarWidth(300, 1200), 300, "sidebar width must retain a valid user size");
assert.equal(calcRSI(rising, 14).at(-1), 100, "RSI must be 100 when average loss is zero");
assert.equal(calcRSI(Array(20).fill(100), 14).at(-1), 50, "flat RSI must be neutral");
assert.throws(() => calcRSI(rising, 0), RangeError);

const atrRows: PriceData[] = Array.from({ length: 15 }, (_, index) => ({
  date: `2026-01-${String(index + 1).padStart(2, "0")}`,
  open: 100 + index,
  high: 101 + index,
  low: 99 + index,
  close: 100 + index,
  volume: 1_000,
}));
const atr = calcATR(atrRows, 14);
assert.equal(atr.length, atrRows.length, "ATR output must align with input rows");
assert.deepEqual(atr.slice(0, 14), Array(14).fill(null));
assert.equal(atr[14], 2);
assert.throws(() => calcATR(atrRows, -1), RangeError);

const engineRows = Array.from({ length: 20 }, (_, index) => ({
  date: 20260101 + index,
  open: 100,
  high: index < 6 ? 120 : 101,
  low: index < 6 ? 80 : 99,
  close: 100,
  volume: 1_000,
}));
assert.equal(new SupportResistanceEngine(engineRows).atr14, 2, "strategy ATR must use only the latest period");


assert.equal(isLoopbackAddress("127.0.0.1"), true);
assert.equal(isLoopbackAddress("::1"), true);
assert.equal(isLoopbackAddress("192.168.1.10"), false);
assert.equal(validateEnvValue("key", "  abc=123  "), "abc=123");
assert.throws(() => validateEnvValue("key", "abc\nINJECTED=value"));
assert.equal(createJobDedupeKey("2330", ["goldman", "berkshire", "goldman"]), "2330:berkshire,goldman");
assert.deepEqual(selectFinMindDatasetNames(["deshaw"]), ["TaiwanStockPrice"], "single framework must fetch only required FinMind datasets");
const allFrameworkDatasets = selectFinMindDatasetNames([
  "berkshire", "goldman", "morgan_stanley", "bridgewater", "jpmorgan", "blackrock", "citadel",
  "renaissance", "vanguard", "deshaw", "twosigma", "hedge_fund", "industry",
]);
assert.equal(allFrameworkDatasets.includes("TaiwanStockMarginPurchaseShortSale"), false, "unused FinMind data must not be fetched");
assert.equal(allFrameworkDatasets.includes("TaiwanStockShareholding"), false, "unused FinMind data must not be fetched");

let activeWorkers = 0;
let peakWorkers = 0;
await mapWithConcurrency([1, 2, 3, 4, 5], 3, async () => {
  activeWorkers++;
  peakWorkers = Math.max(peakWorkers, activeWorkers);
  await new Promise((resolve) => setTimeout(resolve, 5));
  activeWorkers--;
});
assert.equal(peakWorkers, 3, "AI worker pool must honor its concurrency limit");

const pgrst002 = describeSupabaseError(
  { code: "PGRST002", message: "Could not query the database for the schema cache. Retrying." },
  "https://example-ref.supabase.co",
);
assert.equal(pgrst002.code, "PGRST002");
assert.match(pgrst002.message, /不是 URL 或 anon key/);
assert.equal(pgrst002.dashboardUrl, "https://supabase.com/dashboard/project/example-ref/integrations/data_api/overview");
assert.equal(pgrst002.steps.length, 4);

let retryAttempts = 0;
const retryServer = createServer((_request, response) => {
  retryAttempts++;
  response.statusCode = retryAttempts === 1 ? 503 : 200;
  response.end(retryAttempts === 1 ? "retry" : "ok");
});
retryServer.listen(0, "127.0.0.1");
await once(retryServer, "listening");
try {
  const address = retryServer.address();
  assert(address && typeof address === "object");
  const response = await fetchWithOneRetry(`http://127.0.0.1:${address.port}`, {}, undefined, 2_000);
  assert.equal(response.status, 200);
  assert.equal(retryAttempts, 2, "transient HTTP failures should retry exactly once");
} finally {
  retryServer.close();
  await once(retryServer, "close");
}

let timeoutAttempts = 0;
const timeoutServer = createServer((_request, response) => {
  timeoutAttempts++;
  setTimeout(() => response.end("late"), 40);
});
timeoutServer.listen(0, "127.0.0.1");
await once(timeoutServer, "listening");
try {
  const address = timeoutServer.address();
  assert(address && typeof address === "object");
  const requestSeen = once(timeoutServer, "request");
  const timedRequest = fetchWithOneRetry(`http://127.0.0.1:${address.port}`, {}, undefined, 20);
  await requestSeen;
  await assert.rejects(
    timedRequest,
    (error: any) => error?.name === "TimeoutError",
  );
  assert.equal(timeoutAttempts, 1, "request timeouts must not silently double the total wait");
  await new Promise((resolve) => setTimeout(resolve, 50));
} finally {
  timeoutServer.close();
  await once(timeoutServer, "close");
}

const connectAbort = new AbortController();
setTimeout(() => connectAbort.abort(new DOMException("Timed out", "TimeoutError")), 5);
await assert.rejects(
  withAbortSignal(new Promise(() => {}), connectAbort.signal),
  (error: any) => error?.name === "TimeoutError",
  "MCP connection waits must obey their abort signal",
);

const snapshotPrices = Array.from({ length: 15 }, (_, index) => ({
  date: `2026-07-${String(index + 1).padStart(2, "0")}`,
  open: 100 + index,
  max: 101 + index,
  min: 99 + index,
  close: 100 + index,
}));
const snapshot = buildStockSnapshot("2330", [
  { dataset: "TaiwanStockPrice", rows: snapshotPrices },
  { dataset: "TaiwanStockMonthRevenue", rows: [
    { date: "2025-06-01", revenue_year: 2025, revenue_month: 6, revenue: 100 },
    { date: "2026-06-01", revenue_year: 2026, revenue_month: 6, revenue: 110 },
  ] },
  { dataset: "TaiwanStockFinancialStatements", rows: [
    { date: "2026-03-31", type: "Revenue", value: 200 },
  ] },
], { companyName: "台積電" }, "2026-07-22T00:00:00.000Z");
assert.equal(snapshot.metrics.latest_close.value, 114);
assert.equal(snapshot.metrics.atr14.value, 2);
assert.ok(Math.abs(snapshot.metrics.monthly_revenue_yoy.value - 10) < 1e-10);
assert.equal(snapshot.quality.staleDatasets.includes("TaiwanStockFinancialStatements"), false, "fresh quarterly filings must not use the daily stale threshold");
const priceOnlyPrompt = formatSnapshotForPrompt(snapshot, {
  datasets: ["TaiwanStockPrice"],
  metrics: ["latest_close", "atr14"],
});
assert.match(priceOnlyPrompt, /TaiwanStockPrice/);
assert.doesNotMatch(priceOnlyPrompt, /TaiwanStockMonthRevenue/);
assert.doesNotMatch(priceOnlyPrompt, /monthly_revenue_yoy/);

const validatedReport = validateEvidenceReport([
  "最新收盤價為 114 元 [[metric:latest_close]]",
  "未經證實的目標價為 999 元",
  "錯誤引用的 ROE 為 20% [[metric:not_real]]",
].join("\n"), snapshot);
assert.equal(validatedReport.summary.numericClaimLines, 3);
assert.equal(validatedReport.summary.supportedClaimLines, 1);
assert.equal(validatedReport.summary.redactedLines, 2);
assert.match(validatedReport.markdown, /〔metric:latest_close〕/);
assert.doesNotMatch(validatedReport.markdown, /999/);
assert.equal(validatedReport.evidence["metric:latest_close"].value, 114);

const migrationDb = new Database(":memory:");
try {
  ensureCanonicalSchema(migrationDb);
  const compatibilityInsert = migrationDb.prepare(`
    INSERT OR REPLACE INTO stock_price
      (stock_id, date, open, high, low, close, volume, amount, trade_count, spread, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  compatibilityInsert.run("2330", "2026-07-22", 100, 105, 99, 103, 1_000, 100_000, 10, 4, "contract_test");
  compatibilityInsert.run("2330", "2026-07-22", 101, 106, 100, 104, 2_000, 200_000, 20, 5, "contract_test");
  assert.equal(
    (migrationDb.prepare("SELECT close FROM stock_history WHERE stock_id = '2330'").get() as { close: number }).close,
    104,
    "stock_price compatibility writes must land in canonical stock_history",
  );
  runMigrations(migrationDb);
  const migrationCount = (migrationDb.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get() as { count: number }).count;
  runMigrations(migrationDb);
  assert.equal((migrationDb.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get() as { count: number }).count, migrationCount, "migrations must be idempotent");
  assert.throws(
    () => migrationDb.prepare(
      "INSERT INTO stock_meta (stock_id, stock_name) VALUES ('0050', 'ETF must be rejected')",
    ).run(),
    /only ordinary stock IDs are allowed/,
  );
  for (const table of ["analysis_snapshots", "analysis_job_reports", "analysis_jobs"]) {
    assert.ok(migrationDb.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table), `${table} must exist`);
  }
  const jobColumns = new Set((migrationDb.prepare("PRAGMA table_info(analysis_jobs)").all() as Array<{ name: string }>).map((column) => column.name));
  for (const column of ["worker_id", "lease_until", "attempt_count", "dedupe_key"]) assert.ok(jobColumns.has(column));
  const insertJob = migrationDb.prepare(`
    INSERT INTO analysis_jobs (id, stock_id, framework_ids, framework_count, status, per_framework, started_at, updated_at, dedupe_key)
    VALUES (?, '2330', '["goldman"]', 1, ?, '{}', 1, 1, '2330:goldman')
  `);
  insertJob.run("lease-a", "running");
  assert.throws(() => insertJob.run("lease-b", "running"), /UNIQUE/, "only one active duplicate job is allowed");
  migrationDb.prepare("UPDATE analysis_jobs SET status = 'done' WHERE id = 'lease-a'").run();
  insertJob.run("lease-b", "running");

  const tdccCsv = [
    "資料日期,證券代號,持股分級,人數,股數,占集保庫存數比例%",
    '"1150718","2330","1","10","100","10"',
    "20260718,2330,6,20,200,20",
    "2026-07-18,2330,15,5,300,30",
    "2026/07/18,2330,16,1,100,10",
    '20260718,2330,17,36,"1,000",100',
    "20260718,2317,1,10,100,25",
    "20260718,2317,15,2,300,75",
    "20260718,0050,17,1,100,100",
    "20261340,9999,1,1,100,100",
    "20260718,9999,1,1,-10,100",
  ].join("\n");
  const parsedTdcc = parseTdccCSV(tdccCsv);
  assert.equal(parsedTdcc.date, "2026-07-18");
  assert.equal(parsedTdcc.parsedRows, 7);
  assert.equal(parsedTdcc.records.length, 2);
  assert.deepEqual(parsedTdcc.records.find((record) => record.stock_id === "2330"), {
    stock_id: "2330", date: "2026-07-18", total_shares: 1_000, whale_ratio: 30, retail_ratio: 30,
    total_people: 36, whale_shares: 300, whale_people: 5,
  });
  assert.deepEqual(parsedTdcc.records.find((record) => record.stock_id === "2317"), {
    stock_id: "2317", date: "2026-07-18", total_shares: 400, whale_ratio: 75, retail_ratio: 25,
    total_people: 12, whale_shares: 300, whale_people: 2,
  });
  const tdccEligibilityCsv = readFileSync(
    path.join(process.cwd(), "tests", "fixtures", "tdcc-eligibility.csv"),
    "utf8",
  );
  const eligibilityParsed = parseTdccCSV(tdccEligibilityCsv);
  const eligibleIds = new Set(["2330", "4130"]);
  const eligibilityFiltered = filterTdccRecordsByEligibleStocks(eligibilityParsed, eligibleIds);
  assert.deepEqual(eligibilityParsed.rawSymbols, ["0050", "1107", "2330"]);
  assert.deepEqual(eligibilityParsed.parsedSymbols, ["1107", "2330"]);
  assert.deepEqual(eligibilityFiltered.records.map((record) => record.stock_id), ["2330"]);
  assert.deepEqual(eligibilityFiltered.report, {
    rawSymbols: 3,
    parsedSymbols: 2,
    eligibleSymbols: 2,
    matchedSymbols: 1,
    excludedSymbols: 1,
    eligibleButMissingSymbols: 1,
    recordsToWrite: 1,
    excludedStockIds: ["1107"],
    eligibleButMissingStockIds: ["4130"],
  });
  let sqliteStockIds: string[] = [];
  let supabaseStockIds: string[] = [];
  const eligibilityIngest = await ingestTdccCSV(tdccEligibilityCsv, {
    eligibleStockIds: eligibleIds,
    writeLocal: async (records) => {
      sqliteStockIds = records.map((record) => record.stock_id);
      return records.length;
    },
    writeCloud: async (records) => {
      supabaseStockIds = records.map((record) => record.stock_id);
      return { attempted: true, synced: true };
    },
    log: () => {},
  });
  assert.deepEqual(sqliteStockIds, ["2330"]);
  assert.deepEqual(supabaseStockIds, sqliteStockIds, "Supabase and SQLite must receive the same filtered TDCC stock set");
  assert.equal(eligibilityIngest.report.eligibleButMissingStockIds[0], "4130");
  await saveTdccToSQLite(parsedTdcc.records, "contract_test", migrationDb);
  await saveTdccToSQLite(parsedTdcc.records, "contract_test", migrationDb);
  assert.equal((migrationDb.prepare("SELECT COUNT(*) AS count FROM tdcc_shareholding").get() as { count: number }).count, 2, "TDCC upsert must be idempotent");

  const coverageRows = [
    ...Array.from({ length: 52 }, (_, index) => ({
      stock_id: "2454", date: `2025-${String(Math.floor(index / 4) + 1).padStart(2, "0")}-${String((index % 4) * 7 + 1).padStart(2, "0")}`,
      total_shares: 1_000, whale_ratio: 50,
      retail_ratio: null, total_people: null, whale_shares: null, whale_people: null,
    })),
    ...Array.from({ length: 52 }, (_, index) => ({
      stock_id: "3008", date: `2025-${String(Math.floor(index / 4) + 1).padStart(2, "0")}-${String((index % 4) * 7 + 1).padStart(2, "0")}`,
      total_shares: 1_000, whale_ratio: index === 51 ? null : 50,
      retail_ratio: 10, total_people: 100, whale_shares: 500, whale_people: 10,
    })),
    { stock_id: "2317", date: "2026-07-24", total_shares: 1_000, whale_ratio: 50, retail_ratio: 10, total_people: 100, whale_shares: 500, whale_people: 10 },
    { stock_id: "2317", date: "2026-07-31", total_shares: 1_000, whale_ratio: 50, retail_ratio: 10, total_people: 100, whale_shares: 500, whale_people: 10 },
    { stock_id: "2317", date: "2026-07-31", total_shares: 1_000, whale_ratio: 50, retail_ratio: 10, total_people: 100, whale_shares: 500, whale_people: 10 },
  ];
  const coverageSummary = summarizeTdccCoverage(new Set(["2317", "2330", "2454", "3008"]), coverageRows);
  assert.deepEqual(
    { reached52Weeks: coverageSummary.reached52Weeks, partial: coverageSummary.partial, missing: coverageSummary.missing },
    { reached52Weeks: 1, partial: 2, missing: 1 },
    "52-week completion must require 52 distinct dates with core fields",
  );
  assert.deepEqual(
    coverageSummary.perStock.find((stock) => stock.stockId === "2317"),
    { stockId: "2317", distinctWeeks: 2, coreCompleteWeeks: 2, latestDate: "2026-07-31", detailIncompleteRows: 0 },
    "coverage and latest date must be calculated per stock and deduplicate dates",
  );
  assert.equal(coverageSummary.perStock.find((stock) => stock.stockId === "2454")?.detailIncompleteRows, 52);
  assert.equal(coverageSummary.perStock.find((stock) => stock.stockId === "3008")?.coreCompleteWeeks, 51);
  assert.deepEqual(
    selectTdccBackfillCandidates(coverageSummary.perStock),
    ["2330", "2317", "3008"],
    "zero-row, partial and 52-date core-incomplete stocks must all remain backfill candidates",
  );
  assert.deepEqual(
    [...selectCoreCompleteTdccDates([
      { date: "2026-07-03", total_shares: 1_000, whale_ratio: 50 },
      { date: "2026-07-10", total_shares: null, whale_ratio: 50 },
      { date: "2026-07-17", total_shares: 1_000, whale_ratio: null },
    ])],
    ["2026-07-03"],
    "existingDates must contain only dates whose TDCC core fields are complete",
  );

  const cleanupClassification = classifyTdccCleanupCandidates(
    ["0050", "1107", "1234", "2330", "7777", "8888", "9999"].flatMap((stockId) => [{ stock_id: stockId }, { stock_id: stockId }]),
    [
      { stock_id: "0050", status: "active", type: "ETF", market: "TSE", source: "TWSE", last_trade_date: "2026-07-31" },
      { stock_id: "2330", status: "active", type: "COMMON", market: "TSE", source: "quotes", last_trade_date: "2026-07-31" },
      { stock_id: "1107", status: "inactive", type: "COMMON", market: "TSE", source: "TWSE", last_trade_date: "2026-07-31" },
      { stock_id: "7777", status: "active", type: "COMMON", market: "TSE", source: "TWSE", last_trade_date: "2026-07-30" },
      { stock_id: "8888", status: "active", type: "COMMON", market: "ESB", source: "TPEx", last_trade_date: "2026-07-31" },
      { stock_id: "9999", status: "active", type: "ETF", market: "TSE", source: "quotes", last_trade_date: "2026-07-31" },
    ],
    [
      { stock_id: "0050", status: "active", type: "ETF", market: "TSE", source: "TWSE", last_trade_date: "2026-07-31" },
      { stock_id: "2330", status: "active", type: "stock", market: "TSE", source: "FinMind", last_trade_date: "2026-07-30" },
      { stock_id: "1107", status: "inactive", type: "COMMON", market: "TSE", source: "TWSE", last_trade_date: "2026-07-31" },
      { stock_id: "7777", status: "active", type: "COMMON", market: "TSE", source: "TWSE", last_trade_date: "2026-07-31" },
      { stock_id: "8888", status: "active", type: "COMMON", market: "ESB", source: "TPEx", last_trade_date: "2026-07-31" },
      { stock_id: "9999", status: "active", type: "ETF", market: "TSE", source: "quotes", last_trade_date: "2026-07-31" },
    ],
    new Set(["2330"]),
  );
  assert.deepEqual(cleanupClassification.categories.confirmed_nonordinary.stockIds, ["0050"]);
  assert.deepEqual(cleanupClassification.categories.inactive.stockIds, ["1107"]);
  assert.deepEqual(cleanupClassification.categories.missing_meta.stockIds, ["1234"]);
  assert.deepEqual(cleanupClassification.categories.local_cloud_mismatch.stockIds, ["7777", "9999"]);
  assert.deepEqual(cleanupClassification.categories.unsupported_market.stockIds, ["8888"]);
  assert.equal(cleanupClassification.projectedDeleteSymbols, 1, "only confirmed official nonordinary metadata may be cleanup-eligible");
  assert.equal(cleanupClassification.projectedDeleteRows, 2);
  assert.equal(cleanupClassification.dryRun, true);
  assert.deepEqual(summarizeTdccExclusionCounts(cleanupClassification), {
    missingStockMeta: 1,
    excludedNonOrdinary: 1,
    inactive: 1,
    metadataMismatch: 2,
    unsupportedMarket: 1,
  }, "status exclusion categories must remain distinct");
} finally {
  migrationDb.close();
}

const legacyTdccDb = new Database(":memory:");
try {
  legacyTdccDb.exec(`
    CREATE TABLE tdcc_shareholding (
      stock_id TEXT NOT NULL, date TEXT NOT NULL, total_shares INTEGER,
      whale_ratio REAL, retail_ratio REAL, total_people INTEGER,
      whale_shares INTEGER, whale_people INTEGER, source TEXT, updated_at TEXT,
      PRIMARY KEY(stock_id, date)
    );
    INSERT INTO tdcc_shareholding VALUES
      ('2330','2026-07-31',1000,50,10,100,500,10,'legacy','2026-08-01');
  `);
  ensureCanonicalSchema(legacyTdccDb);
  assert.equal(
    (legacyTdccDb.prepare("SELECT type FROM sqlite_master WHERE name = 'tdcc_shareholding'").get() as { type: string }).type,
    "view",
    "legacy physical TDCC table must become a compatibility view",
  );
  assert.deepEqual(
    legacyTdccDb.prepare("SELECT stock_id,date,total_shares,whale_ratio FROM tdcc_shareholding").all(),
    [{ stock_id: "2330", date: "2026-07-31", total_shares: 1000, whale_ratio: 50 }],
    "legacy TDCC rows must survive compatibility migration",
  );
} finally {
  legacyTdccDb.close();
}

const tdccPageFixture = Array.from({ length: 15_001 }, (_, index) => ({
  stock_id: "2330",
  date: new Date(Date.UTC(1980, 0, index + 1)).toISOString().slice(0, 10),
  total_shares: 1_000,
  whale_ratio: 50,
  retail_ratio: 10,
  total_people: 100,
  whale_shares: 500,
  whale_people: 10,
}));
const syncedTdccRows = new Map<string, (typeof tdccPageFixture)[number]>();
const readTdccPage = async (cursor: { date: string; stockId: string } | null, limit: number) => {
  const start = cursor
    ? tdccPageFixture.findIndex((row) => row.date > cursor.date || (row.date === cursor.date && row.stock_id > cursor.stockId))
    : 0;
  return start < 0 ? [] : tdccPageFixture.slice(start, start + limit);
};
const upsertTdccPage = async (rows: typeof tdccPageFixture) => {
  for (const row of rows) syncedTdccRows.set(`${row.stock_id}:${row.date}`, row);
};
assert.equal((await syncTdccPages(readTdccPage, upsertTdccPage, new Set(["2330"]), 500)).pushed, 15_001);
assert.equal(syncedTdccRows.size, 15_001, "all TDCC rows beyond the former 15,000 cap must be delivered");
await syncTdccPages(readTdccPage, upsertTdccPage, new Set(["2330"]), 500);
assert.equal(syncedTdccRows.size, 15_001, "a second TDCC sync must not create duplicate keys");

const packageJson = JSON.parse(readFileSync(path.join(process.cwd(), "package.json"), "utf8")) as { scripts: Record<string, string> };
assert.equal(packageJson.scripts["backfill:tdcc"], "tsx scripts/backfillTdccLocal.ts", "TDCC backfill command must be local-only");
const tdccLocalBackfillSource = readFileSync(path.join(process.cwd(), "scripts", "backfillTdccLocal.ts"), "utf8");
const tdccBackfillSource = readFileSync(path.join(process.cwd(), "server", "lib", "tdccBackfill.ts"), "utf8");
assert.match(tdccLocalBackfillSource, /buildLocalTdccBackfillPlan/);
assert.match(tdccLocalBackfillSource, /selectExistingCoreCompleteDates/);
assert.match(tdccBackfillSource, /total_shares IS NOT NULL[\s\S]*whale_ratio IS NOT NULL/i);
assert.match(tdccBackfillSource, /loadEligibleOrdinaryStockIds/, "local TDCC backfill must use the canonical ordinary-stock universe");
const retiredCloudBackfillSource = readFileSync(path.join(process.cwd(), "scripts", "backfillTdccUniverse.ts"), "utf8");
assert.doesNotMatch(retiredCloudBackfillSource, /supabaseAdmin|\.from\("stock_meta"\)|backfillTdccHistory/, "retired cloud TDCC backfill must not maintain an independent universe or execute history fetches");
assert.match(retiredCloudBackfillSource, /disabled|停用/i);
const syncBridgeSource = readFileSync(path.join(process.cwd(), "server", "lib", "syncBridge.ts"), "utf8");
assert.doesNotMatch(syncBridgeSource, /LIMIT 15000/, "TDCC SQLite-to-Supabase sync must not stop at a global row cap");
assert.match(syncBridgeSource, /ORDER BY date, stock_id/i, "TDCC sync pages must use a stable compound sort");
const tdccDownloadSource = readFileSync(path.join(process.cwd(), "server", "lib", "tdccDownload.ts"), "utf8");
assert.doesNotMatch(
  tdccDownloadSource.slice(tdccDownloadSource.indexOf("getTdccCleanupDryRun"), tdccDownloadSource.indexOf("// Master sync flow")),
  /\.delete\(|\bDELETE\b/i,
  "TDCC cleanup must remain dry-run and contain no delete operation",
);

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(apiRouter);
const routeIds: string[] = [];
const collectRoutes = (stack: any[]) => {
  for (const layer of stack) {
    if (layer.route) {
      for (const method of Object.keys(layer.route.methods)) routeIds.push(`${method.toUpperCase()} ${layer.route.path}`);
    } else if (layer.handle?.stack) collectRoutes(layer.handle.stack);
  }
};
collectRoutes((apiRouter as any).stack);
assert.equal(new Set(routeIds).size, routeIds.length, "API routes must not be registered twice after router extraction");
for (const route of [
  "POST /api/ai-analysis",
  "POST /api/analysis-mvp",
  "POST /api/job/batch",
  "POST /api/job/:id/cancel",
  "GET /api/job/:id",
  "GET /api/job",
  "POST /api/upload-tdcc",
  "POST /api/auto-download-tdcc",
  "POST /api/tdcc/sync",
  "GET /api/tdcc/status",
  "GET /api/settings",
  "POST /api/settings",
  "GET /api/movers",
  "GET /api/dashboard/recent-dividend",
  "GET /api/dashboard/trust-buy-2day",
  "GET /api/dashboard/break-ma200",
  "GET /api/dashboard/limit-up-yesterday",
  "GET /api/stock/:id/sr-analysis",
  "GET /api/stock/:id/ma-analysis",
  "GET /api/stock/:id/chips-analysis",
  "GET /api/stock/:id/institutional-holdings",
  "GET /api/stock/:id/prediction-analysis",
  "GET /api/stock/:id/pattern-analysis",
  "GET /api/strategy/sr-scan",
  "GET /api/strategy/ma-scan",
  "GET /api/strategy/chips-scan",
  "GET /api/strategy/prediction-scan",
  "GET /api/strategy/pattern-scan",
  "GET /api/stock/search",
  "GET /api/stock/:id/history",
  "GET /api/stock/:id/indicators",
  "GET /api/stock/:id/institutional",
  "GET /api/stock/:id/shareholding",
  "POST /api/stock/:id/shareholding/backfill",
  "GET /api/stock/:id/quote",
  "GET /api/stock/:id/valuation",
  "GET /api/stock/:id/margin",
  "GET /api/stock/:id/revenue",
  "GET /api/stock/:id/financials",
  "POST /api/sync-daily",
  "POST /api/trigger-update",
  "GET /api/sync-status",
  "POST /api/local/backfill-finmind",
  "GET /api/health",
  "GET /api/twse-stats",
  "GET /api/otc-stats",
  "GET /api/debug-status",
  "GET /api/stock/:id/trade-risks",
  "GET /api/market/trade-risks",
  "GET /api/status/trade-risk",
  "POST /api/trade-risks/sync",
]) assert.ok(routeIds.includes(route), `${route} must remain registered`);
const server = app.listen(0, "127.0.0.1");
await once(server, "listening");
try {
  const address = server.address();
  assert(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  process.env.TRINITY_ADMIN_TOKEN = "self-check-admin-token-0123456789";
  const settings = await fetch(`${baseUrl}/api/settings`, {
    headers: { "X-Trinity-Admin-Token": process.env.TRINITY_ADMIN_TOKEN },
  }).then((response) => response.json()) as Record<string, unknown>;
  assert.equal(settings.success, true);
  for (const secret of ["nvidiaApiKey", "finmindApiKey", "webhookUrl"]) {
    assert.equal(Object.hasOwn(settings, secret), false, `/api/settings must not expose ${secret}`);
  }
  const legacy = await fetch(`${baseUrl}/api/ai-analysis`, {
    method: "POST",
    headers: { "X-Trinity-Admin-Token": process.env.TRINITY_ADMIN_TOKEN },
  });
  assert.equal(legacy.status, 410, "unsafe legacy AI route must stay retired");
  const etfResponse = await fetch(`${baseUrl}/api/stock/0050/history`);
  assert.equal(etfResponse.status, 400, "stock APIs must reject non-ordinary securities");
  const etfBody = await etfResponse.json() as Record<string, unknown>;
  assert.equal(etfBody.success, false);
} finally {
  server.close();
  await once(server, "close");
}

const riskFixtureBase = {
  id: 1, stock_id: "2330", market: "TWSE" as const,
  reason: "fixture", restrictions: "fixture restriction", announced_date: "2026-08-01",
  start_date: "2026-08-03", end_date: "2026-08-14", source: "fixture",
  source_url: "https://www.twse.com.tw/", source_updated_at: "2026-08-01",
  fetched_at: "2026-08-01T00:00:00Z", is_active: 0,
};
const emptyRisk = buildStockTradeRiskResponse("2330", [], "sqlite", "2026-08-01");
assert.equal(emptyRisk.hasActiveRisk, false);
assert.deepEqual(emptyRisk.risks, []);
const multipleRisks = buildStockTradeRiskResponse("2330", [
  { ...riskFixtureBase, risk_type: "attention", risk_level: "medium" },
  { ...riskFixtureBase, id: 2, risk_type: "disposition", risk_level: "high" },
], "sqlite", "2026-08-01");
assert.deepEqual(multipleRisks.risks.map((risk) => risk.type), ["disposition", "attention"]);
assert.equal(multipleRisks.risks[0].daysUntilStart, 2);
assert.equal(multipleRisks.risks[0].daysUntilEnd, 13);
const policyRows: StoredTradeRisk[] = [
  { ...riskFixtureBase, stock_id: "2330", risk_type: "attention", risk_level: "medium", start_date: "2026-07-01", is_active: 1 },
  { ...riskFixtureBase, id: 2, stock_id: "2454", risk_type: "disposition", risk_level: "high", start_date: "2026-07-01", is_active: 1 },
  { ...riskFixtureBase, id: 3, stock_id: "2317", risk_type: "trading_halt", risk_level: "critical", start_date: "2026-07-01", is_active: 1 },
];
const filtered = applyTradeRiskPolicyRows(
  [{ stock_id: "2330" }, { stock_id: "2454" }, { stock_id: "2317" }], policyRows, false, "2026-08-01",
);
assert.deepEqual(filtered.map((row) => row.stock_id), ["2330"]);
assert.equal(filtered[0].riskFlags[0].action, "warn", "attention must warn without exclusion");
assert.deepEqual(
  applyTradeRiskPolicyRows([{ stock_id: "2454" }], policyRows, true, "2026-08-01").map((row) => row.stock_id),
  ["2454"], "disposition opt-in must preserve the candidate",
);
const ineffectiveRisks: StoredTradeRisk[] = [
  { ...riskFixtureBase, stock_id: "2330", risk_type: "disposition", risk_level: "high", is_active: 0 },
  { ...riskFixtureBase, id: 2, stock_id: "2454", risk_type: "trading_halt", risk_level: "critical",
    start_date: "2099-01-01", is_active: 1 },
  { ...riskFixtureBase, id: 3, stock_id: "2317", risk_type: "attention", risk_level: "medium", start_date: "2026-07-01", end_date: "2026-07-31", is_active: 1 },
];
assert.deepEqual(
  applyTradeRiskPolicyRows(
    [{ stock_id: "2330" }, { stock_id: "2454" }, { stock_id: "2317" }], ineffectiveRisks, false, "2026-08-01",
  ),
  [
    { stock_id: "2330", riskFlags: [] },
    { stock_id: "2454", riskFlags: [] },
    { stock_id: "2317", riskFlags: [] },
  ],
  "stored inactive, future, and expired risks must not filter strategy candidates",
);
const previousTradeRiskFilter = process.env.TRADE_RISK_FILTER_ENABLED;
delete process.env.TRADE_RISK_FILTER_ENABLED;
await assert.rejects(
  applyTradeRiskPolicy([{ stock_id: "2330" }], false, async () => { throw new Error("cloud down"); }),
  new RegExp(TRADE_RISK_POLICY_ERROR),
  "trade-risk lookup failure must fail closed",
);
process.env.TRADE_RISK_FILTER_ENABLED = "false";
assert.equal((await applyTradeRiskPolicy([{ stock_id: "2330" }])).riskPolicy, "disabled");
if (previousTradeRiskFilter === undefined) delete process.env.TRADE_RISK_FILTER_ENABLED;
else process.env.TRADE_RISK_FILTER_ENABLED = previousTradeRiskFilter;
const tradeRiskMigration = readFileSync(
  path.join(process.cwd(), "supabase", "migrations", "20260801060757_stock_trade_risk.sql"), "utf8",
);
assert.match(tradeRiskMigration, /enable row level security/i);
assert.match(tradeRiskMigration, /for select to anon, authenticated/i);
assert.match(tradeRiskMigration, /grant all on table public\.stock_trade_risk to service_role/i);
assert.doesNotMatch(tradeRiskMigration, /for (?:insert|update|delete) to anon/i);
const tradeRiskSource = readFileSync(path.join(process.cwd(), "server", "lib", "tradeRisks.ts"), "utf8");
assert.match(tradeRiskSource, /onConflict: "record_key"/);
assert.doesNotMatch(tradeRiskSource, /catch\s*\{\s*return items\.map/, "trade-risk cloud failures must never fail open");
const tradeRiskBannerSource = readFileSync(path.join(process.cwd(), "src", "components", "TradeRiskBanner.tsx"), "utf8");
assert.match(tradeRiskBannerSource, /交易風險資料載入中/);
assert.match(tradeRiskBannerSource, /交易風險資料暫時無法取得/);
assert.match(tradeRiskBannerSource, /risks\.length === 0\) return null/);
assert.match(tradeRiskBannerSource, /官方未公告結束日/);

console.log("self-check: ok");

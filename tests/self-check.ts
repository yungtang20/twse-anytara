import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import Database from "better-sqlite3";
import express from "express";
import { calcATR, calcRSI, type PriceData } from "../src/lib/indicators";
import { clampSidebarWidth } from "../src/components/Layout";
import { SupportResistanceEngine } from "../src/lib/strategy-engine";
import apiRouter from "../server/routes";
import {
  isLoopbackAddress,
  normalizeLongcatBaseUrl,
  resolveLongcatCompletionsUrl,
  validateEnvValue,
} from "../server/lib/security";
import { buildStockSnapshot, formatSnapshotForPrompt } from "../server/lib/stockSnapshot";
import { validateEvidenceReport } from "../server/lib/evidenceReport";
import { runMigrations } from "../server/lib/migrations";
import { fetchWithOneRetry } from "../server/lib/fetchRetry";
import { withAbortSignal } from "../server/lib/mcpClient";
import { createJobDedupeKey, mapWithConcurrency } from "../server/lib/jobQueue";
import { selectFinMindDatasetNames } from "../server/mvpMcpRoutes";
import { parseTdccCSV, saveTdccToSQLite } from "../server/lib/tdccDownload";
import { describeSupabaseError } from "../server/lib/supabaseDiagnostics";

const rising = Array.from({ length: 20 }, (_, index) => 100 + index);
assert.equal(clampSidebarWidth(100, 1200), 176, "sidebar width must keep navigation usable");
assert.equal(clampSidebarWidth(500, 800), 360, "sidebar width must preserve responsive content space");
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

assert.equal(normalizeLongcatBaseUrl(), "https://api.longcat.chat");
assert.equal(normalizeLongcatBaseUrl("https://api.longcat.chat/openai"), "https://api.longcat.chat/openai");
assert.equal(normalizeLongcatBaseUrl("https://api.longcat.chat/openai/v1/"), "https://api.longcat.chat/openai/v1");
assert.equal(resolveLongcatCompletionsUrl("https://api.longcat.chat/openai"), "https://api.longcat.chat/openai/v1/chat/completions");
assert.equal(resolveLongcatCompletionsUrl("https://api.longcat.chat/openai/v1"), "https://api.longcat.chat/openai/v1/chat/completions");
for (const unsafe of [
  "http://api.longcat.chat",
  "https://api.longcat.chat.evil.example/openai/v1",
  "https://api.longcat.chat@evil.example/openai/v1",
  "https://api.longcat.chat/openai/v1?redirect=evil",
]) assert.throws(() => normalizeLongcatBaseUrl(unsafe));

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
assert.equal(peakWorkers, 3, "LongCat worker pool must honor its concurrency limit");

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
  runMigrations(migrationDb);
  runMigrations(migrationDb);
  assert.equal((migrationDb.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get() as { count: number }).count, 3, "migrations must be idempotent");
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
    "2026-07-18,2330,12,5,300,30",
    "2026/07/18,2330,16,1,100,10",
    '20260718,2330,17,36,"1,000",100',
    "20260718,2317,1,10,100,25",
    "20260718,2317,12,2,300,75",
    "20261340,9999,1,1,100,100",
    "20260718,9999,1,1,-10,100",
  ].join("\n");
  const parsedTdcc = parseTdccCSV(tdccCsv);
  assert.equal(parsedTdcc.date, "2026-07-18");
  assert.equal(parsedTdcc.parsedRows, 7);
  assert.equal(parsedTdcc.records.length, 2);
  assert.deepEqual(parsedTdcc.records.find((record) => record.stock_id === "2330"), {
    stock_id: "2330", date: "2026-07-18", total_shares: 1_000, whale_ratio: 40, retail_ratio: 30,
  });
  assert.deepEqual(parsedTdcc.records.find((record) => record.stock_id === "2317"), {
    stock_id: "2317", date: "2026-07-18", total_shares: 400, whale_ratio: 75, retail_ratio: 25,
  });
  migrationDb.exec(`CREATE TABLE tdcc_shareholding (
    stock_id TEXT, date TEXT, total_shares INTEGER, whale_ratio REAL, retail_ratio REAL,
    source TEXT, updated_at TEXT, PRIMARY KEY (stock_id, date)
  )`);
  await saveTdccToSQLite(parsedTdcc.records, "contract_test", migrationDb);
  await saveTdccToSQLite(parsedTdcc.records, "contract_test", migrationDb);
  assert.equal((migrationDb.prepare("SELECT COUNT(*) AS count FROM tdcc_shareholding").get() as { count: number }).count, 2, "TDCC upsert must be idempotent");
} finally {
  migrationDb.close();
}

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
  "GET /api/stock/:id/quote",
  "GET /api/stock/:id/valuation",
  "GET /api/stock/:id/margin",
  "GET /api/stock/:id/revenue",
  "GET /api/stock/:id/financials",
  "POST /api/sync-daily",
  "POST /api/trigger-update",
  "GET /api/sync-status",
  "POST /api/backfill-finmind",
  "GET /api/health",
  "GET /api/twse-stats",
  "GET /api/otc-stats",
  "GET /api/debug-status",
]) assert.ok(routeIds.includes(route), `${route} must remain registered`);
const server = app.listen(0, "127.0.0.1");
await once(server, "listening");
try {
  const address = server.address();
  assert(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const settings = await fetch(`${baseUrl}/api/settings`).then((response) => response.json()) as Record<string, unknown>;
  assert.equal(settings.success, true);
  for (const secret of ["longcatApiKey", "finmindApiKey", "geminiApiKey", "webhookUrl"]) {
    assert.equal(Object.hasOwn(settings, secret), false, `/api/settings must not expose ${secret}`);
  }
  const legacy = await fetch(`${baseUrl}/api/ai-analysis`, { method: "POST" });
  assert.equal(legacy.status, 410, "unsafe legacy AI route must stay retired");
} finally {
  server.close();
  await once(server, "close");
}

console.log("self-check: ok");

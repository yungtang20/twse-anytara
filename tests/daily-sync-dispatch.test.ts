import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { resolveDailySyncMode, runDailySyncDispatcher } from "../scripts/dispatchDailySync.js";
import {
  evaluateOfficialTdccCoverage,
  planOfficialTdccCloudRows,
  runOfficialTdccCloudSync,
} from "../scripts/syncOfficialTdccCloud.js";

test("formal calendar row deterministically selects market or TDCC", () => {
  assert.equal(resolveDailySyncMode("2026-08-03",
    [{ date: "2026-08-03", is_open: true, source: "official_calendar" }]), "market");
  assert.equal(resolveDailySyncMode("2026-08-02",
    [{ date: "2026-08-02", is_open: false, source: "official_calendar" }]), "tdcc");
});

test("calendar lookup fails closed for absent duplicate mismatched or untrusted rows", () => {
  assert.throws(() => resolveDailySyncMode("2026-08-03", []), /trading_calendar_missing/);
  assert.throws(() => resolveDailySyncMode("2026-08-03", [
    { date: "2026-08-03", is_open: true, source: "a" },
    { date: "2026-08-03", is_open: false, source: "b" },
  ]), /trading_calendar_duplicate/);
  assert.throws(() => resolveDailySyncMode("2026-08-03",
    [{ date: "2026-08-02", is_open: true, source: "official" }]), /trading_calendar_date_mismatch/);
  assert.throws(() => resolveDailySyncMode("2026-08-03",
    [{ date: "2026-08-03", is_open: true, source: "" }]), /trading_calendar_source_missing/);
  assert.throws(() => resolveDailySyncMode("2026-02-30", []), /invalid_dispatch_date/);
});

test("dispatcher uses the injected Taipei date and emits one branch without writes", async () => {
  const reads: string[] = [];
  const outputs: Array<{ mode: string; targetDate: string }> = [];
  const result = await runDailySyncDispatcher({ targetDate: "2026-08-03",
    readCalendarRows: async (date) => {
      reads.push(date);
      return [{ date, is_open: true, source: "official_calendar" }];
    }, emitOutput: async (value) => { outputs.push(value); } });
  assert.deepEqual(result, { mode: "market", targetDate: "2026-08-03" });
  assert.deepEqual(reads, ["2026-08-03"]);
  assert.deepEqual(outputs, [result]);
});

test("official TDCC dry-run validates and never upserts", async () => {
  const csv = ["資料日期,證券代號,持股分級,人數,股數,占集保庫存數比例%",
    "20260731,2330,15,2,700000,70", "20260731,2330,17,10,1000000,100"].join("\n");
  let upserts = 0;
  const result = await runOfficialTdccCloudSync(["--dry-run"], {
    downloadCsv: async () => csv, loadEligibleStockIds: async () => new Set(["2330"]),
    readDatabaseBytes: async () => 100, loadCloudRows: async () => [],
    upsertRows: async () => { upserts += 1; },
  });
  assert.equal(result.mode, "dry-run");
  assert.equal(result.records, 1);
  assert.equal(result.date, "2026-07-31");
  assert.equal(result.coverageRatio, 1);
  assert.equal(result.missingStocks, 0);
  assert.equal(result.plannedRows, 1);
  assert.equal(result.writtenRows, 0);
  assert.equal(upserts, 0);
});

test("official TDCC sync rejects empty whitelist partial payload and capacity before writes", async () => {
  const validCsv = ["資料日期,證券代號,持股分級,人數,股數,占集保庫存數比例%",
    "20260731,2330,17,10,1000000,100"].join("\n");
  const base = { downloadCsv: async () => validCsv, readDatabaseBytes: async () => 100,
    loadCloudRows: async () => [],
    upsertRows: async () => { throw new Error("must_not_write"); } };
  await assert.rejects(() => runOfficialTdccCloudSync(["--execute"], {
    ...base, loadEligibleStockIds: async () => new Set(),
  }), /tdcc_eligible_stock_universe_empty/);
  await assert.rejects(() => runOfficialTdccCloudSync(["--execute"], {
    ...base, loadEligibleStockIds: async () => new Set(["2330", "2317"]),
  }), /tdcc_official_coverage_below_threshold/);
  await assert.rejects(() => runOfficialTdccCloudSync(["--execute"], {
    ...base, loadEligibleStockIds: async () => new Set(["2330"]),
    readDatabaseBytes: async () => 450 * 1024 * 1024,
  }), /tdcc_cloud_capacity_blocked/);
});

test("coverage policy accepts the real 1989 of 2035 case and rejects below 95 percent", () => {
  assert.deepEqual(evaluateOfficialTdccCoverage(1_989, 2_035), {
    matchedStocks: 1_989, eligibleStocks: 2_035, missingStocks: 46,
    coverageRatio: 1_989 / 2_035,
  });
  assert.throws(() => evaluateOfficialTdccCoverage(949, 1_000), /tdcc_official_coverage_below_threshold/);
  assert.throws(() => evaluateOfficialTdccCoverage(1, 0), /tdcc_eligible_stock_universe_empty/);
});

test("TDCC deterministic diff writes only new or fully changed rows", () => {
  const base = { stock_id: "2330", date: "2026-07-31", total_shares: 1_000,
    whale_ratio: 70, retail_ratio: 5, total_people: 10, whale_shares: 700,
    whale_people: 2 };
  assert.deepEqual(planOfficialTdccCloudRows([base], [{ ...base, source: "tdcc" }]), []);
  assert.deepEqual(planOfficialTdccCloudRows([base], [{ ...base, whale_people: 3, source: "tdcc" }]), [base]);
  assert.deepEqual(planOfficialTdccCloudRows([base], []), [base]);
});

test("second identical official TDCC execute is idempotent with zero writes", async () => {
  const csv = ["資料日期,證券代號,持股分級,人數,股數,占集保庫存數比例%",
    "20260731,2330,15,2,700000,70", "20260731,2330,17,10,1000000,100"].join("\n");
  const existing = { stock_id: "2330", date: "2026-07-31", total_shares: 1_000_000,
    whale_ratio: 70, retail_ratio: 0, total_people: 10, whale_shares: 700_000,
    whale_people: 2, source: "tdcc" };
  let upsertCalls = 0;
  const result = await runOfficialTdccCloudSync(["--execute"], {
    downloadCsv: async () => csv, loadEligibleStockIds: async () => new Set(["2330"]),
    readDatabaseBytes: async () => 100, loadCloudRows: async () => [existing],
    upsertRows: async () => { upsertCalls += 1; },
  });
  assert.equal(result.plannedRows, 0);
  assert.equal(result.writtenRows, 0);
  assert.equal(upsertCalls, 0);
});

test("official TDCC execute sends only local-only and changed rows to upsert", async () => {
  const csv = ["資料日期,證券代號,持股分級,人數,股數,占集保庫存數比例%",
    "20260731,2330,17,10,1000000,100", "20260731,2317,17,8,800000,100"].join("\n");
  const existing = { stock_id: "2330", date: "2026-07-31", total_shares: 1_000_000,
    whale_ratio: 0, retail_ratio: 0, total_people: 10, whale_shares: 0,
    whale_people: 0, source: "tdcc" };
  const writes: Array<Array<{ stock_id: string }>> = [];
  const result = await runOfficialTdccCloudSync(["--execute"], {
    downloadCsv: async () => csv, loadEligibleStockIds: async () => new Set(["2330", "2317"]),
    readDatabaseBytes: async () => 100, loadCloudRows: async () => [existing],
    upsertRows: async (rows) => { writes.push(rows); },
  });
  assert.equal(result.plannedRows, 1);
  assert.equal(result.writtenRows, 1);
  assert.deepEqual(writes.flat().map((row) => row.stock_id), ["2317"]);
});

test("official TDCC rejects malformed header before cloud reads or writes", async () => {
  let cloudReads = 0;
  await assert.rejects(() => runOfficialTdccCloudSync(["--execute"], {
    downloadCsv: async () => "wrong,header\n20260731,2330,17,10,1000000,100",
    loadEligibleStockIds: async () => new Set(["2330"]), readDatabaseBytes: async () => 100,
    loadCloudRows: async () => { cloudReads += 1; return []; },
    upsertRows: async () => { throw new Error("must_not_write"); },
  }), /tdcc_official_header_invalid/);
  assert.equal(cloudReads, 0);
});

test("one daily workflow owns the only schedule and keeps service role server-side", async () => {
  const root = path.resolve(import.meta.dirname, "..");
  const workflowDir = path.join(root, ".github", "workflows");
  const files = (await readdir(workflowDir)).filter((name) => /\.ya?ml$/.test(name));
  const sources = await Promise.all(files.map(async (name) => ({ name,
    source: await readFile(path.join(workflowDir, name), "utf8") })));
  const scheduled = sources.filter((item) => /\bschedule\s*:/.test(item.source));
  assert.equal(scheduled.length, 1);
  const workflow = scheduled[0].source;
  assert.match(workflow, /cron:\s*["']0 10 \* \* \*["']/);
  assert.match(workflow, /scripts\/dispatchDailySync\.ts/);
  assert.match(workflow, /steps\.dispatch\.outputs\.mode\s*==\s*'market'/);
  assert.match(workflow, /steps\.dispatch\.outputs\.mode\s*==\s*'tdcc'/);
  assert.match(workflow, /scripts\/syncData\.ts/);
  assert.match(workflow, /SYNC_TARGET_DATE:\s*\$\{\{ steps\.dispatch\.outputs\.target_date \}\}/);
  assert.match(workflow, /scripts\/syncOfficialTdccCloud\.ts\s+--execute/);
  assert.match(workflow, /SUPABASE_SERVICE_ROLE_KEY:\s*\$\{\{ secrets\.SUPABASE_SERVICE_ROLE_KEY \}\}/);
  const frontend = await readFile(path.join(root, "src", "lib", "api.ts"), "utf8");
  assert.doesNotMatch(frontend, /SUPABASE_SERVICE_ROLE_KEY|service_role/);
});

test("daily dispatcher and official cloud runner have no SQLite or destructive path", async () => {
  const root = path.resolve(import.meta.dirname, "..");
  const sources = (await Promise.all(["scripts/dispatchDailySync.ts", "scripts/syncOfficialTdccCloud.ts"]
    .map((file) => readFile(path.join(root, file), "utf8")))).join("\n");
  assert.doesNotMatch(sources, /better-sqlite3|getDb\s*\(|SQLITE_DB_PATH|shareholding_unified/);
  assert.doesNotMatch(sources, /\b(?:DELETE|TRUNCATE|DROP)\b/i);
  assert.doesNotMatch(sources, /src\/|SUPABASE_SERVICE_ROLE_KEY\s*=|console\.(?:log|error).*service_role/i);
  assert.match(sources, /--dry-run/);
  assert.match(sources, /tdcc_cloud_capacity_blocked/);
  assert.match(sources, /MINIMUM_COVERAGE_RATIO\s*=\s*0\.95/);
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import {
  buildLocalTdccBackfillPlan,
  buildLocalTdccDryRunReport,
  selectExistingCoreCompleteDates,
  upsertLocalTdccRecord,
} from "../server/lib/tdccBackfill";
import { runTdccLocal } from "../scripts/backfillTdccLocal";

const db = new Database(":memory:");
db.exec(`
  CREATE TABLE stock_meta (
    stock_id TEXT PRIMARY KEY,
    status TEXT,
    type TEXT,
    market TEXT
  );
  CREATE TABLE shareholding_unified (
    stock_id TEXT NOT NULL,
    date TEXT NOT NULL,
    source TEXT NOT NULL,
    total_shares INTEGER,
    whale_ratio REAL,
    retail_ratio REAL,
    total_people INTEGER,
    whale_shares INTEGER,
    whale_people INTEGER,
    updated_at TEXT,
    UNIQUE(stock_id, date, source)
  );
`);

const insertMeta = db.prepare(
  "INSERT INTO stock_meta (stock_id, status, type, market) VALUES (?, ?, ?, ?)",
);
insertMeta.run("2330", "active", "COMMON", "TSE");
insertMeta.run("2317", "active", "stock", "TSE");
insertMeta.run("2454", "active", "COMMON", "OTC");
insertMeta.run("3008", "active", "COMMON", "TSE");
insertMeta.run("6488", "active", "COMMON", "OTC");
insertMeta.run("0050", "active", "ETF", "TSE");
insertMeta.run("9105", "active", "COMMON", "TSE");
insertMeta.run("7777", "inactive", "COMMON", "OTC");

const targetDates = Array.from(
  { length: 52 },
  (_, index) => `2026-${String(Math.floor(index / 4) + 1).padStart(2, "0")}-${String((index % 4) * 7 + 1).padStart(2, "0")}`,
);

for (const [index, date] of targetDates.entries()) {
  upsertLocalTdccRecord(db, {
    stock_id: "2454", date, source: "tdcc", total_shares: 1_000,
    whale_ratio: 50, retail_ratio: null, total_people: null,
    whale_shares: null, whale_people: null,
  });
  upsertLocalTdccRecord(db, {
    stock_id: "3008", date, source: "tdcc", total_shares: 1_000,
    whale_ratio: index === 51 ? null : 50, retail_ratio: null,
    total_people: null, whale_shares: null, whale_people: null,
  });
}
upsertLocalTdccRecord(db, {
  stock_id: "2317", date: targetDates[0], source: "tdcc", total_shares: 1_000,
  whale_ratio: 50, retail_ratio: null, total_people: null,
  whale_shares: null, whale_people: null,
});
for (let index = 0; index < 52; index += 1) {
  upsertLocalTdccRecord(db, {
    stock_id: "6488", date: `2024-01-${String(index + 1).padStart(2, "0")}`,
    source: "tdcc", total_shares: 1_000, whale_ratio: 50,
    retail_ratio: null, total_people: null, whale_shares: null, whale_people: null,
  });
}

assert.deepEqual(
  buildLocalTdccBackfillPlan(db, targetDates, 50).map((row) => [row.stockId, row.completeWeeks]),
  [["2330", 0], ["6488", 0], ["2317", 1], ["3008", 51]],
  "zero-row, stale-only, partial and 52-date core-incomplete stocks must be queued",
);
assert.deepEqual(
  [...selectExistingCoreCompleteDates(db, "3008", targetDates)],
  targetDates.slice(0, 51),
  "existing dates must recognize only target dates with total_shares and whale_ratio",
);
assert.deepEqual(
  buildLocalTdccBackfillPlan(db, targetDates, 50, "2454"),
  [],
  "a stock with all 52 target dates and complete core fields must not be queued",
);
assert.throws(
  () => buildLocalTdccBackfillPlan(db, targetDates, 50, "0050"),
  /not an active ordinary stock/,
  "explicit ETF requests must be rejected by the canonical local universe",
);

const idempotentRecord = {
  stock_id: "2330", date: targetDates[0], source: "tdcc",
  total_shares: 1_000, whale_ratio: 50, retail_ratio: null,
  total_people: null, whale_shares: null, whale_people: null,
} as const;
upsertLocalTdccRecord(db, idempotentRecord);
upsertLocalTdccRecord(db, { ...idempotentRecord, whale_ratio: 51 });
assert.deepEqual(
  db.prepare("SELECT COUNT(*) AS count, whale_ratio FROM shareholding_unified WHERE stock_id = '2330'").get(),
  { count: 1, whale_ratio: 51 },
  "rerunning a completed week must update the same key without creating a duplicate",
);

db.close();

const dryDb = new Database(":memory:");
dryDb.exec(`
  CREATE TABLE stock_meta (stock_id TEXT PRIMARY KEY, status TEXT, type TEXT, market TEXT);
  CREATE TABLE shareholding_unified (
    stock_id TEXT NOT NULL, date TEXT NOT NULL, source TEXT NOT NULL,
    total_shares INTEGER, whale_ratio REAL, retail_ratio REAL,
    total_people INTEGER, whale_shares INTEGER, whale_people INTEGER,
    updated_at TEXT, UNIQUE(stock_id, date, source)
  );
  INSERT INTO stock_meta VALUES ('2317','active','COMMON','TSE');
  INSERT INTO stock_meta VALUES ('2454','active','stock','OTC');
`);
for (const date of targetDates) {
  upsertLocalTdccRecord(dryDb, {
    stock_id: "2454", date, source: "tdcc", total_shares: 1_000,
    whale_ratio: 50, retail_ratio: null, total_people: null,
    whale_shares: null, whale_people: null,
  });
}
upsertLocalTdccRecord(dryDb, {
  stock_id: "2317", date: targetDates[0], source: "tdcc", total_shares: 1_000,
  whale_ratio: 50, retail_ratio: null, total_people: null,
  whale_shares: null, whale_people: null,
});
let readonlyRequested = false;
let fetchCalls = 0;
let upsertFactoryCalls = 0;
let writeCalls = 0;
const dryRunLogs: string[] = [];
await runTdccLocal(["--dry-run"], {
  openDatabase: (readonly) => {
    readonlyRequested = readonly;
    return dryDb;
  },
  fetchImpl: async () => {
    fetchCalls += 1;
    throw new Error("dry-run must never fetch");
  },
  createUpsert: () => {
    upsertFactoryCalls += 1;
    return () => { writeCalls += 1; };
  },
  log: (message) => { dryRunLogs.push(message); },
});
assert.equal(readonlyRequested, true, "formal dry-run must request a read-only database handle");
assert.equal(fetchCalls, 0, "formal dry-run must not call fetch");
assert.equal(upsertFactoryCalls, 0, "formal dry-run must not even prepare the write path");
assert.equal(writeCalls, 0, "formal dry-run must not write SQLite");
const dryRunReport = JSON.parse(dryRunLogs[0]) as Record<string, unknown>;
assert.deepEqual(
  {
    source: dryRunReport.targetDateSource,
    eligible: dryRunReport.eligibleStocks,
    completed: dryRunReport.completed,
    partial: dryRunReport.partial,
    missing: dryRunReport.missing,
  },
  {
    source: "local shareholding_unified DISTINCT date DESC LIMIT 52",
    eligible: 2, completed: 1, partial: 1, missing: 0,
  },
  "dry-run must report its local target-window source and coverage categories",
);

const insufficientDb = new Database(":memory:");
insufficientDb.exec(`
  CREATE TABLE stock_meta (stock_id TEXT PRIMARY KEY, status TEXT, type TEXT, market TEXT);
  CREATE TABLE shareholding_unified (
    stock_id TEXT, date TEXT, source TEXT, total_shares INTEGER, whale_ratio REAL
  );
  INSERT INTO stock_meta VALUES ('2330','active','COMMON','TSE');
  INSERT INTO shareholding_unified VALUES ('2330','2026-07-31','tdcc',1000,50);
`);
assert.throws(
  () => buildLocalTdccDryRunReport(insufficientDb, 50),
  /只有 1\/52.*dry-run 不會連網.*人工批准.*官方 TDCC/s,
  "fewer than 52 local dates must fail explicitly instead of silently fetching",
);
insufficientDb.close();

const localRunnerSource = readFileSync(
  path.join(process.cwd(), "scripts", "backfillTdccLocal.ts"),
  "utf8",
);
assert.match(localRunnerSource, /args\.includes\("--dry-run"\)/, "formal local runner must expose --dry-run");
assert.match(localRunnerSource, /openDatabase\(options\.dryRun\)/, "dry-run must request a read-only SQLite handle");
assert.match(localRunnerSource, /fileMustExist:\s*readonly/, "dry-run must never create a missing SQLite database");
assert.match(localRunnerSource, /buildLocalTdccDryRunReport/, "dry-run must use the local-only report builder");

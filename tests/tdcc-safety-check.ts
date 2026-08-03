import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { ensureCanonicalSchema } from "../server/lib/sqliteSchema";
import {
  classifyTdccCleanupCandidates,
  selectTdccBackfillCandidates,
  summarizeTdccCoverage,
  summarizeTdccExclusionCounts,
} from "../server/lib/tdccDownload";

const db = new Database(":memory:");
try {
  db.exec(`
    CREATE TABLE shareholding_unified (
      stock_id TEXT, date TEXT, source TEXT, total_shares INTEGER,
      whale_ratio REAL, retail_ratio REAL, foreign_shares INTEGER,
      foreign_ratio REAL, updated_at TEXT, PRIMARY KEY (stock_id, date)
    );
    INSERT INTO shareholding_unified VALUES
      ('2330','2026-07-31','finmind',900,40,8,777,12.5,'2026-07-30');
    CREATE TABLE tdcc_shareholding (
      stock_id TEXT NOT NULL, date TEXT NOT NULL, total_shares INTEGER,
      whale_ratio REAL, retail_ratio REAL, updated_at TEXT,
      PRIMARY KEY(stock_id, date)
    );
    INSERT INTO tdcc_shareholding VALUES
      ('2330','2026-07-31',1000,50,10,'2026-08-01');
  `);

  ensureCanonicalSchema(db);
  ensureCanonicalSchema(db);
  assert.equal(
    (db.prepare("SELECT type FROM sqlite_master WHERE name='tdcc_shareholding'").get() as { type: string }).type,
    "view",
  );
  assert.deepEqual(
    db.prepare(`SELECT stock_id,date,source,total_shares,whale_ratio,retail_ratio,
      foreign_shares,foreign_ratio FROM shareholding_unified`).all(),
    [{
      stock_id: "2330", date: "2026-07-31", source: "tdcc",
      total_shares: 1000, whale_ratio: 50, retail_ratio: 10,
      foreign_shares: 777, foreign_ratio: 12.5,
    }],
    "legacy migration must merge TDCC fields without erasing existing unified fields",
  );
  db.prepare(`INSERT INTO tdcc_shareholding
    (stock_id,date,total_shares,whale_ratio,retail_ratio,updated_at)
    VALUES ('2330','2026-07-31',1100,55,11,'2026-08-02')`).run();
  assert.deepEqual(
    db.prepare("SELECT total_shares,whale_ratio,foreign_shares,foreign_ratio FROM shareholding_unified").get(),
    { total_shares: 1100, whale_ratio: 55, foreign_shares: 777, foreign_ratio: 12.5 },
    "compatibility-view upserts must not erase unrelated unified fields",
  );
} finally {
  db.close();
}

const coverage = summarizeTdccCoverage(new Set(["2317", "2330"]), [{
  stock_id: "2317", date: "2026-07-31", total_shares: 1000, whale_ratio: 50,
  retail_ratio: null, total_people: null, whale_shares: null, whale_people: null,
}]);
assert.equal(coverage.missing, 1);
assert.deepEqual(selectTdccBackfillCandidates(coverage.perStock), ["2330", "2317"]);

const classified = classifyTdccCleanupCandidates(
  [{ stock_id: "0050" }, { stock_id: "7777" }],
  [{ stock_id: "0050", status: "active", type: "ETF", market: "TSE", source: "TWSE", last_trade_date: "2026-07-31" }],
  [{ stock_id: "0050", status: "active", type: "ETF", market: "TSE", source: "TWSE", last_trade_date: "2026-07-31" }],
);
assert.deepEqual(summarizeTdccExclusionCounts(classified), {
  missingStockMeta: 1,
  excludedNonOrdinary: 1,
  inactive: 0,
  metadataMismatch: 0,
  unsupportedMarket: 0,
});

const statusSource = readFileSync(path.join(process.cwd(), "server/lib/tdccDownload.ts"), "utf8");
assert.match(statusSource, /historyMode:\s*"tdcc_history_page_per_stock_per_week_local_only_manual_approval"/);
const retiredSource = readFileSync(path.join(process.cwd(), "scripts/backfillTdccUniverse.ts"), "utf8");
assert.doesNotMatch(retiredSource, /supabaseAdmin|backfillTdccHistory|\.from\(["']stock_meta["']\)/);
assert.match(retiredSource, /disabled|停用/i);

console.log("TDCC safety checks passed");

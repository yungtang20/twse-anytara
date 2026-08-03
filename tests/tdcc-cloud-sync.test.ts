import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  buildTdccCloudSyncPlan,
  executeTdccUpsertBatches,
  pushTdccToSupabase,
  serializeTdccCloudRow,
  syncTdccPages,
  type TdccSyncCursor,
  type TdccSyncRow,
} from "../server/lib/syncBridge.js";

type Row = TdccSyncRow & { source?: string };

function row(stockId: string, date: string, overrides: Partial<Row> = {}): Row {
  return {
    stock_id: stockId,
    date,
    total_shares: 1_000,
    whale_ratio: 52.3,
    retail_ratio: null,
    total_people: 10,
    whale_shares: 700,
    whale_people: 2,
    source: "tdcc",
    ...overrides,
  };
}

test("TDCC keyset pagination crosses 50,000 rows without omissions", async () => {
  const rows = Array.from({ length: 50_001 }, (_, index) => row(
    String(1000 + (index % 1_000)),
    `2026-${String(1 + Math.floor(index / 28_000)).padStart(2, "0")}-${String(1 + (index % 28)).padStart(2, "0")}`,
  )).sort((left, right) => left.date.localeCompare(right.date) || left.stock_id.localeCompare(right.stock_id));
  const unique = rows.map((item, index) => ({ ...item, stock_id: `${item.stock_id}-${index}` }));
  const written = new Set<string>();
  await syncTdccPages(
    (cursor: TdccSyncCursor | null, limit: number) => unique.filter((item) => cursor === null
      || item.date > cursor.date || (item.date === cursor.date && item.stock_id > cursor.stockId)).slice(0, limit),
    async (page) => { page.forEach((item) => written.add(`${item.stock_id}:${item.date}`)); },
    new Set(unique.map((item) => item.stock_id)),
    777,
  );
  assert.equal(written.size, 50_001);
});

test("dry-run plans only local-only and content-different keys and is idempotent", () => {
  const local = [row("2330", "2026-07-31"), row("2317", "2026-07-31"), row("2881", "2026-07-31")];
  const cloud = [
    row("2330", "2026-07-31"),
    row("2317", "2026-07-31", { whale_ratio: 1 }),
    row("9999", "2025-01-01"),
  ];
  const plan = buildTdccCloudSyncPlan(local, cloud, new Set(["2330", "2317", "2881"]));
  assert.deepEqual(plan.rowsToUpsert.map((item) => item.stock_id), ["2317", "2881"]);
  assert.equal(plan.localOnlyKeys, 1);
  assert.equal(plan.contentDifferentKeys, 1);
  assert.equal(plan.identicalKeys, 1);
  assert.equal(plan.cloudOnlyKeys, 1);
  const after = buildTdccCloudSyncPlan(local, [...cloud, ...plan.rowsToUpsert], new Set(["2330", "2317", "2881"]));
  assert.equal(after.rowsToUpsert.length, 0);
});

test("serialization preserves nulls and forces official tdcc source", () => {
  assert.deepEqual(serializeTdccCloudRow(row("2330", "2026-07-31", {
    retail_ratio: null, total_people: null, whale_shares: null, whale_people: null, source: "sqlite_push",
  })), {
    stock_id: "2330", date: "2026-07-31", total_shares: 1_000, whale_ratio: 52.3,
    retail_ratio: null, total_people: null, whale_shares: null, whale_people: null, source: "tdcc",
  });
});

test("non-ordinary rows never enter the plan and cloud-only rows are retained", () => {
  const cloudOnly = row("9105", "2025-01-01", { source: "legacy" });
  const plan = buildTdccCloudSyncPlan(
    [row("2330", "2026-07-31"), row("0050", "2026-07-31"), row("9105", "2026-07-31")],
    [cloudOnly],
    new Set(["2330"]),
  );
  assert.deepEqual(plan.rowsToUpsert.map((item) => item.stock_id), ["2330"]);
  assert.equal(plan.excludedLocalRows, 2);
  assert.equal(plan.cloudOnlyKeys, 1);
  assert.deepEqual(cloudOnly, row("9105", "2025-01-01", { source: "legacy" }));
});

test("a failed batch is not checkpointed and a retry is safe", async () => {
  const rows = [row("1101", "2026-07-31"), row("1102", "2026-07-31"), row("1103", "2026-07-31")]
    .map(serializeTdccCloudRow);
  const stored = new Map<string, Row>();
  const committed: number[] = [];
  let calls = 0;
  await assert.rejects(() => executeTdccUpsertBatches(rows, 2, async (batch) => {
    calls += 1;
    if (calls === 2) throw new Error("transient");
    batch.forEach((item) => stored.set(`${item.stock_id}:${item.date}`, item));
  }, (progress) => committed.push(progress.writtenRows)), /tdcc_cloud_batch_failed:2/);
  assert.deepEqual(committed, [2]);
  calls = 0;
  const result = await executeTdccUpsertBatches(rows, 2, async (batch) => {
    batch.forEach((item) => stored.set(`${item.stock_id}:${item.date}`, item));
  });
  assert.deepEqual(result, { writtenRows: 3, successfulBatches: 2, failedBatches: 0 });
  assert.equal(stored.size, 3);
});

test("formal runner is SQLite read-only and service-role stays server-side and out of logs", async () => {
  const root = path.resolve(import.meta.dirname, "..");
  const runner = await readFile(path.join(root, "scripts", "syncTdccCloud.ts"), "utf8");
  assert.match(runner, /readonly:\s*true/);
  assert.match(runner, /fileMustExist:\s*true/);
  assert.match(runner, /query_only\s*=\s*ON/i);
  assert.doesNotMatch(runner, /DELETE|TRUNCATE|DROP/i);
  assert.doesNotMatch(runner, /console\.(?:log|error)[^\n]*SERVICE_ROLE/i);
  const client = await readFile(path.join(root, "scripts", "lib", "supabaseAdmin.ts"), "utf8");
  assert.match(client, /SUPABASE_SERVICE_ROLE_KEY/);
  const frontend = await readFile(path.join(root, "src", "lib", "api.ts"), "utf8");
  assert.doesNotMatch(frontend, /SUPABASE_SERVICE_ROLE_KEY|service_role/);
});

test("legacy bridge push reuses canonical TDCC mapping and ordinary-stock filter", async () => {
  const bridgeSource = await readFile(path.resolve(import.meta.dirname, "../server/lib/syncBridge.ts"), "utf8");
  assert.match(bridgeSource, /export interface TdccBridgePushDependencies/,
    "dependency injection seam is required before the fake bridge may run");
  const localRows = [
    row("2330", "2026-07-31", { retail_ratio: null, total_people: null,
      whale_shares: null, whale_people: null, source: "sqlite_push" }),
    row("0050", "2026-07-31"),
    row("9105", "2026-07-31"),
    row("123456", "2026-07-31"),
  ];
  const calls: Array<{ table: string; rows: unknown[]; options: unknown }> = [];
  const fakeDb = {
    prepare: () => ({ all: () => localRows }),
  };
  const fakeSupabase = {
    from: (table: string) => ({
      upsert: async (rows: unknown[], options: unknown) => {
        calls.push({ table, rows, options });
        return { error: null };
      },
    }),
  };
  const result = await pushTdccToSupabase(365, {
    database: fakeDb,
    admin: fakeSupabase,
    eligibleStockIds: new Set(["2330"]),
    cutoffDate: "2025-08-02",
  });
  assert.deepEqual(result, { pushed: 1 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].table, "tdcc_shareholding");
  assert.deepEqual(calls[0].options, { onConflict: "stock_id,date" });
  assert.deepEqual(calls[0].rows, [serializeTdccCloudRow(localRows[0])]);
  assert.deepEqual(calls[0].rows, [{
    stock_id: "2330", date: "2026-07-31", total_shares: 1_000, whale_ratio: 52.3,
    retail_ratio: null, total_people: null, whale_shares: null, whale_people: null, source: "tdcc",
  }]);
});

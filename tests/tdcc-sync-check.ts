import assert from "node:assert/strict";
import {
  compareTdccSyncKey,
  syncTdccPages,
  type TdccSyncCursor,
  type TdccSyncRow,
} from "../server/lib/syncBridge";

type FixtureRow = TdccSyncRow & { marker: number };

function makeRow(date: string, stockId: string, marker: number): FixtureRow {
  return {
    stock_id: stockId,
    date,
    total_shares: 1_000,
    whale_ratio: 50,
    retail_ratio: null,
    total_people: null,
    whale_shares: null,
    whale_people: null,
    marker,
  };
}

function createFakeDb(rows: FixtureRow[]) {
  const sorted = [...rows].sort((left, right) => compareTdccSyncKey(left, right));
  const observedCursors: Array<TdccSyncCursor | null> = [];
  return {
    observedCursors,
    readPage(cursor: TdccSyncCursor | null, limit: number) {
      observedCursors.push(cursor);
      return sorted
        .filter((row) => cursor === null || compareTdccSyncKey(row, cursor) > 0)
        .slice(0, limit);
    },
  };
}

function createFakeSupabase() {
  const rows = new Map<string, FixtureRow>();
  let calls = 0;
  return {
    rows,
    get calls() { return calls; },
    async upsert(batch: FixtureRow[]) {
      calls++;
      for (const row of batch) rows.set(`${row.stock_id}:${row.date}`, row);
    },
  };
}

assert.ok(compareTdccSyncKey(
  { date: "2026-07-31", stock_id: "2330" },
  { date: "2026-07-31", stockId: "2454" },
) < 0, "same-date rows must use stock_id as the keyset tie-breaker");
assert.ok(compareTdccSyncKey(
  { date: "2026-08-01", stock_id: "1101" },
  { date: "2026-07-31", stockId: "9999" },
) > 0, "date must be the primary keyset component");

const rowsOver500 = Array.from({ length: 501 }, (_, index) =>
  makeRow("2026-07-31", String(1000 + index).padStart(4, "0"), index));
const dbOver500 = createFakeDb(rowsOver500);
const cloudOver500 = createFakeSupabase();
assert.deepEqual(
  await syncTdccPages(dbOver500.readPage, cloudOver500.upsert, new Set(rowsOver500.map((row) => row.stock_id)), 500),
  { pushed: 501 },
);
assert.equal(cloudOver500.rows.size, 501, "a second page after 500 rows must reach the fake Supabase");
assert.deepEqual(dbOver500.observedCursors[1], { date: "2026-07-31", stockId: "1499" });

const rowsOver15000 = Array.from({ length: 15_001 }, (_, index) => {
  const day = Math.floor(index / 1_000) + 1;
  const stockId = String(1000 + (index % 1_000)).padStart(4, "0");
  return makeRow(`2026-07-${String(day).padStart(2, "0")}`, stockId, index);
});
const largeDb = createFakeDb(rowsOver15000);
const largeCloud = createFakeSupabase();
const largeEligible = new Set(rowsOver15000.map((row) => row.stock_id));
assert.equal((await syncTdccPages(largeDb.readPage, largeCloud.upsert, largeEligible, 500)).pushed, 15_001);
assert.equal(largeCloud.rows.size, 15_001, "pagination must continue beyond the former 15,000-row cap");

const ineligibleFirstPage = [
  ...Array.from({ length: 500 }, (_, index) => makeRow("2026-07-01", String(1000 + index), index)),
  makeRow("2026-07-02", "2330", 500),
];
const filteredDb = createFakeDb(ineligibleFirstPage);
const filteredCloud = createFakeSupabase();
assert.deepEqual(
  await syncTdccPages(filteredDb.readPage, filteredCloud.upsert, new Set(["2330"]), 500),
  { pushed: 1 },
  "a full page with zero eligible rows must not terminate pagination",
);
assert.deepEqual([...filteredCloud.rows.keys()], ["2330:2026-07-02"]);

const callsAfterFirstRun = largeCloud.calls;
await syncTdccPages(largeDb.readPage, largeCloud.upsert, largeEligible, 500);
assert.equal(largeCloud.rows.size, 15_001, "a second upsert run must not create duplicate compound keys");
assert.ok(largeCloud.calls > callsAfterFirstRun, "the idempotency test must execute a real second sync run");

console.log("tdcc-sync-check: ok");

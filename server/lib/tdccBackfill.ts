import type { Database as SqliteDatabase } from "better-sqlite3";
import { loadEligibleOrdinaryStockIds } from "./stockUniverse";

export interface LocalTdccRecord {
  stock_id: string;
  date: string;
  source: "tdcc";
  total_shares: number | null;
  whale_ratio: number | null;
  retail_ratio: number | null;
  total_people: number | null;
  whale_shares: number | null;
  whale_people: number | null;
}

export interface LocalTdccBackfillCandidate {
  stockId: string;
  completeWeeks: number;
}

export interface LocalTdccDryRunReport {
  mode: "dry-run";
  targetDateSource: "local shareholding_unified DISTINCT date DESC LIMIT 52";
  targetDates: string[];
  eligibleStocks: number;
  completed: number;
  partial: number;
  missing: number;
  candidates: LocalTdccBackfillCandidate[];
}

interface CoverageRow {
  stock_id: string;
  date: string;
  total_shares: number | null;
  whale_ratio: number | null;
}

function targetDateSet(targetDates: readonly string[]): Set<string> {
  return new Set(targetDates);
}

function readCoreCompleteDates(
  db: SqliteDatabase,
  eligible: ReadonlySet<string>,
  targets: ReadonlySet<string>,
): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>();
  const rows = db.prepare(
    `SELECT stock_id, date, total_shares, whale_ratio
     FROM shareholding_unified
     WHERE source = 'tdcc'
       AND total_shares IS NOT NULL
       AND whale_ratio IS NOT NULL`,
  ).all() as CoverageRow[];
  for (const row of rows) {
    if (!eligible.has(row.stock_id) || !targets.has(row.date)) continue;
    const dates = result.get(row.stock_id) ?? new Set<string>();
    dates.add(row.date);
    result.set(row.stock_id, dates);
  }
  return result;
}

export function buildLocalTdccBackfillPlan(
  db: SqliteDatabase,
  targetDates: readonly string[],
  limit: number,
  requestedStockId?: string,
): LocalTdccBackfillCandidate[] {
  const eligible = loadEligibleOrdinaryStockIds(db);
  if (requestedStockId && !eligible.has(requestedStockId)) {
    throw new Error(`${requestedStockId} is not an active ordinary stock`);
  }
  const targets = targetDateSet(targetDates);
  const completeDates = readCoreCompleteDates(db, eligible, targets);
  const stockIds = requestedStockId ? [requestedStockId] : [...eligible];
  return stockIds
    .map((stockId) => ({
      stockId,
      completeWeeks: completeDates.get(stockId)?.size ?? 0,
    }))
    .filter((row) => row.completeWeeks < targets.size)
    .sort((left, right) => left.completeWeeks - right.completeWeeks
      || left.stockId.localeCompare(right.stockId))
    .slice(0, limit);
}

export function loadLocalTdccTargetDates(db: SqliteDatabase): string[] {
  const rows = db.prepare(
    `SELECT DISTINCT date
     FROM shareholding_unified
     WHERE source = 'tdcc' AND date IS NOT NULL
     ORDER BY date DESC
     LIMIT 52`,
  ).all() as Array<{ date: string }>;
  if (rows.length < 52) {
    throw new Error(
      `本地 TDCC 只有 ${rows.length}/52 個可用日期；dry-run 不會連網。` +
      "請先取得人工批准，再由官方 TDCC 取得目標日期。",
    );
  }
  return rows.map((row) => row.date);
}

export function buildLocalTdccDryRunReport(
  db: SqliteDatabase,
  limit: number,
  requestedStockId?: string,
): LocalTdccDryRunReport {
  const targetDates = loadLocalTdccTargetDates(db);
  const eligible = loadEligibleOrdinaryStockIds(db);
  if (requestedStockId && !eligible.has(requestedStockId)) {
    throw new Error(`${requestedStockId} is not an active ordinary stock`);
  }
  const targets = targetDateSet(targetDates);
  const completeDates = readCoreCompleteDates(db, eligible, targets);
  const stockIds = requestedStockId ? [requestedStockId] : [...eligible];
  const weeks = stockIds.map((stockId) => completeDates.get(stockId)?.size ?? 0);
  return {
    mode: "dry-run",
    targetDateSource: "local shareholding_unified DISTINCT date DESC LIMIT 52",
    targetDates,
    eligibleStocks: stockIds.length,
    completed: weeks.filter((count) => count === targets.size).length,
    partial: weeks.filter((count) => count > 0 && count < targets.size).length,
    missing: weeks.filter((count) => count === 0).length,
    candidates: buildLocalTdccBackfillPlan(db, targetDates, limit, requestedStockId),
  };
}

export function selectExistingCoreCompleteDates(
  db: SqliteDatabase,
  stockId: string,
  targetDates: readonly string[],
): Set<string> {
  const target = targetDateSet(targetDates);
  const rows = db.prepare(
    `SELECT date, total_shares, whale_ratio
     FROM shareholding_unified
     WHERE stock_id = ? AND source = 'tdcc'
       AND total_shares IS NOT NULL
       AND whale_ratio IS NOT NULL`,
  ).all(stockId) as Omit<CoverageRow, "stock_id">[];
  return new Set(rows.map((row) => row.date).filter((date) => target.has(date)));
}

const LOCAL_TDCC_UPSERT = `
  INSERT INTO shareholding_unified
    (stock_id, date, source, total_shares, whale_ratio, retail_ratio, total_people, whale_shares, whale_people)
  VALUES (@stock_id, @date, @source, @total_shares, @whale_ratio, @retail_ratio, @total_people, @whale_shares, @whale_people)
  ON CONFLICT(stock_id, date, source) DO UPDATE SET
    total_shares = excluded.total_shares,
    whale_ratio = excluded.whale_ratio,
    retail_ratio = excluded.retail_ratio,
    total_people = excluded.total_people,
    whale_shares = excluded.whale_shares,
    whale_people = excluded.whale_people,
    updated_at = datetime('now','localtime')
`;

export function upsertLocalTdccRecord(db: SqliteDatabase, record: LocalTdccRecord): void {
  db.prepare(LOCAL_TDCC_UPSERT).run(record);
}

export function createLocalTdccUpsert(
  db: SqliteDatabase,
): (record: LocalTdccRecord) => void {
  const statement = db.prepare(LOCAL_TDCC_UPSERT);
  return (record) => { statement.run(record); };
}

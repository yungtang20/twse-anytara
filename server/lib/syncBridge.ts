// Supabase ↔ SQLite 同步橋 (背景呼叫)
// 保持 Supabase 有最新資料 (shared, 跨部屬), SQLite 爲主 local cache (高速)
import { getDb } from "../db";
import { supabase, supabaseAdmin } from "./runtimeState";
import { getTdccSqliteStatus } from "./tdccDownload";
import { isOrdinaryStockId, loadEligibleOrdinaryStockIds } from "./stockUniverse";

const BATCH = 500;

export interface TdccSyncRow {
  stock_id: string;
  date: string;
  total_shares: number | null;
  whale_ratio: number | null;
  retail_ratio: number | null;
  total_people: number | null;
  whale_shares: number | null;
  whale_people: number | null;
}

export interface TdccCloudSyncRow extends TdccSyncRow {
  source: "tdcc";
}

export interface TdccCloudSyncPlan {
  requestedLocalRows: number;
  eligibleLocalRows: number;
  excludedLocalRows: number;
  localOnlyKeys: number;
  cloudOnlyKeys: number;
  contentDifferentKeys: number;
  identicalKeys: number;
  rowsToUpsert: TdccCloudSyncRow[];
}

export interface TdccSyncCursor {
  date: string;
  stockId: string;
}

type TdccSyncKey = Pick<TdccSyncRow, "date" | "stock_id"> | TdccSyncCursor;

function stockIdFromSyncKey(key: TdccSyncKey): string {
  return "stock_id" in key ? key.stock_id : key.stockId;
}

/** Compare the exact compound key used by SQLite's ORDER BY and keyset WHERE. */
export function compareTdccSyncKey(left: TdccSyncKey, right: TdccSyncKey): number {
  if (left.date !== right.date) return left.date < right.date ? -1 : 1;
  const leftStockId = stockIdFromSyncKey(left);
  const rightStockId = stockIdFromSyncKey(right);
  if (leftStockId === rightStockId) return 0;
  return leftStockId < rightStockId ? -1 : 1;
}

export async function syncTdccPages<T extends TdccSyncRow>(
  readPage: (cursor: TdccSyncCursor | null, limit: number) => Promise<T[]> | T[],
  upsertPage: (rows: T[]) => Promise<void>,
  eligibleStockIds: ReadonlySet<string> | null,
  pageSize = BATCH,
): Promise<{ pushed: number }> {
  let cursor: TdccSyncCursor | null = null;
  let pushed = 0;
  while (true) {
    const page = await readPage(cursor, pageSize);
    if (page.length === 0) break;
    const lastRow = page.at(-1)!;
    const nextCursor = { date: lastRow.date, stockId: lastRow.stock_id };
    if (cursor && compareTdccSyncKey(nextCursor, cursor) <= 0) {
      throw new Error("TDCC keyset page did not advance (date, stock_id)");
    }
    cursor = nextCursor;
    const eligiblePage = eligibleStockIds === null ? page : page.filter((row) => eligibleStockIds.has(row.stock_id));
    if (eligiblePage.length > 0) {
      await upsertPage(eligiblePage);
      pushed += eligiblePage.length;
    }
    if (page.length < pageSize) break;
  }
  return { pushed };
}

function tdccKey(row: Pick<TdccSyncRow, "stock_id" | "date">): string {
  return `${row.stock_id}\u0000${row.date}`;
}

function normalizeCloudFloat(value: number | null): number | null {
  return value === null ? null : Math.fround(value);
}

/** Map the canonical SQLite row to the exact Supabase storage contract. */
export function serializeTdccCloudRow(row: TdccSyncRow & { source?: string }): TdccCloudSyncRow {
  return {
    stock_id: row.stock_id,
    date: row.date,
    total_shares: row.total_shares,
    whale_ratio: row.whale_ratio,
    retail_ratio: row.retail_ratio,
    total_people: row.total_people,
    whale_shares: row.whale_shares,
    whale_people: row.whale_people,
    source: "tdcc",
  };
}

type TdccComparableRow = TdccSyncRow & { source: string };

function sameTdccCloudContent(left: TdccComparableRow, right: TdccComparableRow): boolean {
  return left.stock_id === right.stock_id && left.date === right.date
    && left.total_shares === right.total_shares
    && normalizeCloudFloat(left.whale_ratio) === normalizeCloudFloat(right.whale_ratio)
    && normalizeCloudFloat(left.retail_ratio) === normalizeCloudFloat(right.retail_ratio)
    && left.total_people === right.total_people
    && left.whale_shares === right.whale_shares
    && left.whale_people === right.whale_people
    && left.source === right.source;
}

/** Pure, non-destructive plan: cloud-only rows are counted but never returned for deletion. */
export function buildTdccCloudSyncPlan(
  localRows: Array<TdccSyncRow & { source?: string }>,
  cloudRows: Array<TdccSyncRow & { source?: string }>,
  eligibleStockIds: ReadonlySet<string>,
): TdccCloudSyncPlan {
  const eligibleLocal = localRows
    .filter((row) => eligibleStockIds.has(row.stock_id))
    .map(serializeTdccCloudRow)
    .sort(compareTdccSyncKey);
  const localByKey = new Map(eligibleLocal.map((row) => [tdccKey(row), row]));
  const cloudByKey = new Map(cloudRows.map((row) => {
    const normalized: TdccComparableRow = { ...serializeTdccCloudRow(row), source: row.source ?? "" };
    return [tdccKey(normalized), normalized] as const;
  }));
  const rowsToUpsert: TdccCloudSyncRow[] = [];
  let localOnlyKeys = 0;
  let contentDifferentKeys = 0;
  let identicalKeys = 0;
  for (const [key, local] of localByKey) {
    const cloud = cloudByKey.get(key);
    if (!cloud) {
      localOnlyKeys += 1;
      rowsToUpsert.push(local);
    } else if (!sameTdccCloudContent(local, cloud)) {
      contentDifferentKeys += 1;
      rowsToUpsert.push(local);
    } else {
      identicalKeys += 1;
    }
  }
  let cloudOnlyKeys = 0;
  for (const key of cloudByKey.keys()) if (!localByKey.has(key)) cloudOnlyKeys += 1;
  return {
    requestedLocalRows: localRows.length,
    eligibleLocalRows: eligibleLocal.length,
    excludedLocalRows: localRows.length - eligibleLocal.length,
    localOnlyKeys,
    cloudOnlyKeys,
    contentDifferentKeys,
    identicalKeys,
    rowsToUpsert,
  };
}

export interface TdccBatchProgress {
  batchNumber: number;
  writtenRows: number;
  successfulBatches: number;
}

export async function executeTdccUpsertBatches(
  rows: TdccCloudSyncRow[],
  batchSize: number,
  upsertBatch: (batch: TdccCloudSyncRow[]) => Promise<void>,
  onBatchCommitted: (progress: TdccBatchProgress) => void = () => undefined,
): Promise<{ writtenRows: number; successfulBatches: number; failedBatches: number }> {
  if (!Number.isSafeInteger(batchSize) || batchSize <= 0) throw new Error("invalid_tdcc_cloud_batch_size");
  let writtenRows = 0;
  let successfulBatches = 0;
  for (let offset = 0; offset < rows.length; offset += batchSize) {
    const batchNumber = successfulBatches + 1;
    const batch = rows.slice(offset, offset + batchSize);
    try {
      await upsertBatch(batch);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`tdcc_cloud_batch_failed:${batchNumber}:${message}`);
    }
    writtenRows += batch.length;
    successfulBatches += 1;
    onBatchCommitted({ batchNumber, writtenRows, successfulBatches });
  }
  return { writtenRows, successfulBatches, failedBatches: 0 };
}

interface PriceRow {
  stock_id: string;
  date: string;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  volume: number | null;
  amount: number | null;
  trade_count: number | null;
  spread: number | null;
}

function requireSupabaseAdmin() {
  if (!supabaseAdmin) {
    throw new Error("Supabase 寫入需要伺服器端 SUPABASE_SERVICE_ROLE_KEY");
  }
  return supabaseAdmin;
}

export interface TdccBridgePushDependencies {
  database?: {
    prepare: (sql: string) => { all: (...parameters: unknown[]) => unknown[] };
  };
  admin?: {
    from: (table: string) => {
      upsert: (rows: TdccCloudSyncRow[], options: { onConflict: string }) => Promise<{ error: unknown }>;
    };
  };
  eligibleStockIds?: ReadonlySet<string>;
  cutoffDate?: string;
}

export interface BridgeStatus {
  sqliteTdcc: { latest: string | null; totalRows: number };
  supabaseTdcc: { latest: string | null; rows: number } | null;
  lastPushAt: string | null;
}

export function getBridgeStatus(): BridgeStatus {
  return {
    sqliteTdcc: getTdccSqliteStatus(),
    supabaseTdcc: null,  // lazy-loaded by /api/bridge/status
    lastPushAt: null,
  };
}

// 取得最近 N 天前的日期字串 YYYY-MM-DD
function getDateDaysAgo(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return date.toISOString().split("T")[0];
}

// ==========================================
// 1. PUSH (SQLite → Supabase)
// ==========================================

// PUSH TDCC: SQLite → Supabase
export async function pushTdccToSupabase(
  days: number = 365,
  dependencies: TdccBridgePushDependencies = {},
): Promise<{ pushed: number }> {
  const sb = dependencies.admin || requireSupabaseAdmin() as unknown as NonNullable<TdccBridgePushDependencies["admin"]>;
  try {
    const cutoffDate = dependencies.cutoffDate || getDateDaysAgo(days);
    
    const db = dependencies.database || getDb();
    const eligible = dependencies.eligibleStockIds
      || loadEligibleOrdinaryStockIds(db as ReturnType<typeof getDb>);
    const selectPage = db.prepare(`
      SELECT stock_id, date, total_shares, whale_ratio, retail_ratio,
             total_people, whale_shares, whale_people
      FROM tdcc_shareholding
      WHERE date >= ? AND (date > ? OR (date = ? AND stock_id > ?))
      ORDER BY date, stock_id
      LIMIT ?
    `);

    return await syncTdccPages(
      (cursor, limit) => selectPage.all(
        cutoffDate,
        cursor?.date || "",
        cursor?.date || "",
        cursor?.stockId || "",
        limit,
      ) as TdccSyncRow[],
      async (batch) => {
        const rows = batch.map(serializeTdccCloudRow);
        const { error } = await sb.from("tdcc_shareholding").upsert(rows, { onConflict: "stock_id,date" });
        if (error) throw error;
      },
      eligible,
    );
  } catch (e: any) {
    console.error("[syncBridge] pushTdccToSupabase error:", e.message);
    throw e;
  }
}

function serializePrice(row: PriceRow) {
  return {
    stock_id: row.stock_id,
    date: row.date,
    open: row.open,
    high: row.high,
    low: row.low,
    close: row.close,
    volume: row.volume ?? 0,
    amount: row.amount ?? 0,
    trade_count: row.trade_count ?? 0,
    spread: row.spread ?? 0,
  };
}

// PUSH Price: SQLite → Supabase
export async function pushPriceToSupabase(days: number = 30): Promise<{ pushed: number }> {
  const sb = requireSupabaseAdmin() as any;
  try {
    const cutoffDate = getDateDaysAgo(days);
    const selectRows = getDb().prepare(`
      SELECT stock_id, date, open, high, low, close, volume, amount, trade_count, spread
      FROM stock_history
      WHERE date >= ?
      ORDER BY date, stock_id
      LIMIT ? OFFSET ?
    `);
    let pushed = 0;
    let offset = 0;
    while (true) {
      const rows = selectRows.all(cutoffDate, BATCH, offset) as PriceRow[];
      if (rows.length === 0) break;
      offset += rows.length;
      const batch = rows.filter((row) => isOrdinaryStockId(row.stock_id)).map(serializePrice);
      if (batch.length > 0) {
        const { error } = await sb.from("stock_price").upsert(batch, { onConflict: "stock_id,date" });
        if (error) throw error;
        pushed += batch.length;
      }
    }
    return { pushed };
  } catch (e: any) {
    console.error("[syncBridge] pushPriceToSupabase error:", e.message);
    throw e;
  }
}

function insertPricesIntoSqlite(rows: PriceRow[]): void {
  const insert = getDb().prepare(`
    INSERT OR REPLACE INTO stock_price (
      stock_id, date, open, high, low, close, volume, amount,
      trade_count, spread, adj_factor, adj_close, source
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1.0, ?, 'supabase_pull')
  `);
  getDb().transaction(() => {
    for (const row of rows) {
      insert.run(
        row.stock_id, row.date, row.open, row.high, row.low, row.close,
        row.volume, row.amount, row.trade_count, row.spread, row.close
      );
    }
  })();
}

// PUSH Institutional: SQLite → Supabase
export async function pushInstitutionalToSupabase(days: number = 30): Promise<{ pushed: number }> {
  const sb = requireSupabaseAdmin() as any;
  try {
    const cutoffDate = getDateDaysAgo(days);
    
    // Pull from local SQLite stock_institutional
    const rows = (getDb()
      .prepare(`SELECT stock_id, date, foreign_net, trust_net, dealer_net FROM stock_institutional WHERE date >= ? ORDER BY date DESC LIMIT 30000`)
      .all(cutoffDate) as any[]).filter((row) => isOrdinaryStockId(row.stock_id));

    let pushed = 0;
    for (let i = 0; i < rows.length; i += BATCH) {
      const batch = rows.slice(i, i + BATCH).map((r: any) => ({
        stock_id: r.stock_id,
        date: r.date,
        foreign_net: r.foreign_net || 0,
        trust_net: r.trust_net || 0,
        dealer_net: r.dealer_net || 0,
        institutional_net: (r.foreign_net || 0) + (r.trust_net || 0) + (r.dealer_net || 0),
        source: "sqlite_push",
      }));
      
      const { error } = await sb.from("stock_institutional").upsert(batch, { onConflict: "stock_id,date" });
      if (!error) pushed += batch.length;
      else {
        console.warn("[syncBridge] Institutional push batch err:", error.message);
        throw error;
      }
    }
    return { pushed };
  } catch (e: any) {
    console.error("[syncBridge] pushInstitutionalToSupabase error:", e.message);
    throw e;
  }
}


// ==========================================
// 2. PULL (Supabase → SQLite)
// ==========================================

// PULL Price: Supabase → SQLite
export async function pullPriceFromSupabase(days: number = 30): Promise<{ pulled: number }> {
  if (!supabase) return { pulled: 0 };
  const sb = supabase as any;
  try {
    const cutoffDate = getDateDaysAgo(days);
    let pulled = 0;
    while (true) {
      const { data, error } = await sb
        .from("stock_price")
        .select("stock_id,date,open,high,low,close,volume,amount,trade_count,spread")
        .gte("date", cutoffDate)
        .order("date", { ascending: true })
        .order("stock_id", { ascending: true })
        .range(pulled, pulled + BATCH - 1);
      if (error) throw error;
      const rows = (data || []) as PriceRow[];
      if (rows.length === 0) break;
      insertPricesIntoSqlite(rows);
      pulled += rows.length;
      if (rows.length < BATCH) break;
    }
    return { pulled };
  } catch (e: any) {
    console.error("[syncBridge] pullPriceFromSupabase error:", e.message);
    throw e;
  }
}

// PULL Institutional: Supabase → SQLite
export async function pullInstitutionalFromSupabase(days: number = 30): Promise<{ pulled: number }> {
  if (!supabase) return { pulled: 0 };
  const sb = supabase as any;
  try {
    const cutoffDate = getDateDaysAgo(days);
    
    // Fetch from Supabase
    const { data, error } = await sb
      .from("stock_institutional")
      .select("stock_id,date,foreign_net,trust_net,dealer_net,source")
      .gte("date", cutoffDate)
      .order("date", { ascending: false });

    if (error) throw error;
    if (!data || data.length === 0) return { pulled: 0 };

    const db = getDb();
    const insertInst = db.prepare(`
      INSERT OR REPLACE INTO stock_institutional (stock_id, date, foreign_net, trust_net, dealer_net, foreign_buy, foreign_sell, trust_buy, trust_sell, dealer_buy, dealer_sell, institutional_net, source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    db.transaction(() => {
      for (const i of data) {
        insertInst.run(
          i.stock_id,
          i.date,
          i.foreign_net || 0,
          i.trust_net || 0,
          i.dealer_net || 0,
          0,
          0,
          0,
          0,
          0,
          0,
          (i.foreign_net || 0) + (i.trust_net || 0) + (i.dealer_net || 0),
          i.source || "supabase_pull"
        );
      }
    })();

    return { pulled: data.length };
  } catch (e: any) {
    console.error("[syncBridge] pullInstitutionalFromSupabase error:", e.message);
    throw e;
  }
}

// PULL TDCC: Supabase → SQLite
export async function pullTdccFromSupabase(days: number = 365): Promise<{ pulled: number }> {
  if (!supabase) return { pulled: 0 };
  const sb = supabase as any;
  try {
    const cutoffDate = getDateDaysAgo(days);
    
    // Fetch from Supabase
    const { data, error } = await sb
      .from("tdcc_shareholding")
      .select("stock_id,date,total_shares,whale_ratio,retail_ratio,source")
      .gte("date", cutoffDate)
      .order("date", { ascending: false });

    if (error) throw error;
    if (!data || data.length === 0) return { pulled: 0 };

    const db = getDb();
    const insertFeat = db.prepare(`
      INSERT OR REPLACE INTO tdcc_shareholding (stock_id, date, total_shares, whale_ratio, retail_ratio, source)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    db.transaction(() => {
      for (const f of data) {
        insertFeat.run(
          f.stock_id,
          f.date,
          f.total_shares || 0,
          f.whale_ratio || 0.0,
          f.retail_ratio || 0.0,
          f.source || "supabase_pull"
        );
      }
    })();

    return { pulled: data.length };
  } catch (e: any) {
    console.error("[syncBridge] pullTdccFromSupabase error:", e.message);
    throw e;
  }
}

// ==========================================
// 3. STORAGE PRUNING (Node JS fallback version)
// ==========================================
export async function pruneSupabaseData(
  maxTradingDays: number = 512,
  onLog: (msg: string) => void,
  execute: boolean = false
): Promise<{ candidateRows: number; deletedRows: number; dryRun: boolean }> {
  const sb = requireSupabaseAdmin();
  onLog(`${execute ? "🧹 執行" : "🔍 預覽"}每檔最新 ${maxTradingDays} 筆保留規則...`);

  const { data, error } = await sb.rpc("prune_stock_price_retention", {
    retain_rows: maxTradingDays,
    execute_delete: execute,
  });
  if (error) throw new Error(`Supabase retention RPC 失敗: ${error.message}`);

  const result = Array.isArray(data) ? data[0] : data;
  const candidateRows = Number(result?.candidate_rows || 0);
  const deletedRows = Number(result?.deleted_rows || 0);
  onLog(execute
    ? `✅ 已刪除 ${deletedRows} 筆超出保留上限的資料。`
    : `ℹ️ Dry-run：共有 ${candidateRows} 筆符合刪除條件，未修改資料。`);
  return { candidateRows, deletedRows, dryRun: !execute };
}

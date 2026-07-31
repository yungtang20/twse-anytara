// Supabase ↔ SQLite 同步橋 (背景呼叫)
// 保持 Supabase 有最新資料 (shared, 跨部屬), SQLite 爲主 local cache (高速)
import { getDb } from "../db";
import { supabase, supabaseAdmin } from "./runtimeState";
import { getTdccSqliteStatus } from "./tdccDownload";
import { isOrdinaryStockId } from "./stockUniverse";

const BATCH = 500;

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
export async function pushTdccToSupabase(days: number = 365): Promise<{ pushed: number }> {
  const sb = requireSupabaseAdmin() as any;
  try {
    const cutoffDate = getDateDaysAgo(days);
    
    // Pull recent weeks from SQLite
    const rows = (getDb()
      .prepare(`SELECT stock_id, date, total_shares, whale_ratio, retail_ratio FROM tdcc_shareholding WHERE date >= ? ORDER BY date DESC LIMIT 15000`)
      .all(cutoffDate) as any[]).filter((row) => isOrdinaryStockId(row.stock_id));

    let pushed = 0;
    for (let i = 0; i < rows.length; i += BATCH) {
      const batch = rows.slice(i, i + BATCH).map((r: any) => ({
        stock_id: r.stock_id,
        date: r.date,
        total_shares: r.total_shares || 0,
        whale_ratio: r.whale_ratio || 0.0,
        retail_ratio: r.retail_ratio || 0.0,
        source: "sqlite_push",
      }));
      const { error } = await sb.from("tdcc_shareholding").upsert(batch, { onConflict: "stock_id,date" });
      if (!error) pushed += batch.length;
      else {
        console.warn("[syncBridge] TDCC push batch err:", error.message);
        throw error;
      }
    }
    return { pushed };
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

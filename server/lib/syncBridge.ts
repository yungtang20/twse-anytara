// Supabase ↔ SQLite 同步橋 (背景呼叫)
// 保持 Supabase 有最新資料 (shared, 跨部屬), SQLite 爲主 local cache (高速)
import { getDb } from "../db";
import { supabase } from "../services";
import { getTdccSqliteStatus } from "./tdccDownload";

const BATCH = 500;

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
  if (!supabase) return { pushed: 0 };
  const sb = supabase as any;
  try {
    const cutoffDate = getDateDaysAgo(days);
    
    // Pull recent weeks from SQLite
    const rows = getDb()
      .prepare(`SELECT stock_id, date, total_shares, whale_ratio, retail_ratio FROM tdcc_shareholding WHERE date >= ? ORDER BY date DESC LIMIT 15000`)
      .all(cutoffDate) as any[];

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

// PUSH Price: SQLite → Supabase
export async function pushPriceToSupabase(days: number = 30): Promise<{ pushed: number }> {
  if (!supabase) return { pushed: 0 };
  const sb = supabase as any;
  try {
    const cutoffDate = getDateDaysAgo(days);
    
    // Pull from local SQLite stock_price
    const rows = getDb()
      .prepare(`SELECT stock_id, date, open, high, low, close, volume, amount, trade_count, spread, adj_factor, adj_close FROM stock_price WHERE date >= ? ORDER BY date DESC LIMIT 30000`)
      .all(cutoffDate) as any[];

    let pushed = 0;
    for (let i = 0; i < rows.length; i += BATCH) {
      const batch = rows.slice(i, i + BATCH).map((r: any) => ({
        stock_id: r.stock_id,
        date: r.date,
        open: r.open,
        high: r.high,
        low: r.low,
        close: r.close,
        volume: r.volume || 0,
        amount: r.amount || 0,
        trade_count: r.trade_count || 0,
        spread: r.spread || 0,
        adj_factor: r.adj_factor || 1.0,
        adj_close: r.adj_close || r.close,
        source: "sqlite_push",
      }));
      
      const { error } = await sb.from("stock_price").upsert(batch, { onConflict: "stock_id,date" });
      if (!error) pushed += batch.length;
      else {
        console.warn("[syncBridge] Price push batch err:", error.message);
        throw error;
      }
    }
    return { pushed };
  } catch (e: any) {
    console.error("[syncBridge] pushPriceToSupabase error:", e.message);
    throw e;
  }
}

// PUSH Institutional: SQLite → Supabase
export async function pushInstitutionalToSupabase(days: number = 30): Promise<{ pushed: number }> {
  if (!supabase) return { pushed: 0 };
  const sb = supabase as any;
  try {
    const cutoffDate = getDateDaysAgo(days);
    
    // Pull from local SQLite stock_institutional
    const rows = getDb()
      .prepare(`SELECT stock_id, date, foreign_net, trust_net, dealer_net, foreign_buy, foreign_sell, trust_buy, trust_sell, dealer_buy, dealer_sell FROM stock_institutional WHERE date >= ? ORDER BY date DESC LIMIT 30000`)
      .all(cutoffDate) as any[];

    let pushed = 0;
    for (let i = 0; i < rows.length; i += BATCH) {
      const batch = rows.slice(i, i + BATCH).map((r: any) => ({
        stock_id: r.stock_id,
        date: r.date,
        foreign_net: r.foreign_net || 0,
        trust_net: r.trust_net || 0,
        dealer_net: r.dealer_net || 0,
        foreign_buy: r.foreign_buy || 0,
        foreign_sell: r.foreign_sell || 0,
        trust_buy: r.trust_buy || 0,
        trust_sell: r.trust_sell || 0,
        dealer_buy: r.dealer_buy || 0,
        dealer_sell: r.dealer_sell || 0,
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
    
    // Fetch from Supabase
    const { data, error } = await sb
      .from("stock_price")
      .select("stock_id,date,open,high,low,close,volume,amount,trade_count,spread,adj_factor,adj_close,source")
      .gte("date", cutoffDate)
      .order("date", { ascending: false });

    if (error) throw error;
    if (!data || data.length === 0) return { pulled: 0 };

    const db = getDb();
    const insertPrice = db.prepare(`
      INSERT OR REPLACE INTO stock_price (stock_id, date, open, high, low, close, volume, amount, trade_count, spread, adj_factor, adj_close, source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    db.transaction(() => {
      for (const p of data) {
        insertPrice.run(
          p.stock_id,
          p.date,
          p.open !== undefined ? p.open : null,
          p.high !== undefined ? p.high : null,
          p.low !== undefined ? p.low : null,
          p.close !== undefined ? p.close : null,
          p.volume !== undefined ? p.volume : null,
          p.amount !== undefined ? p.amount : null,
          p.trade_count !== undefined ? p.trade_count : null,
          p.spread !== undefined ? p.spread : null,
          p.adj_factor !== undefined ? p.adj_factor : 1.0,
          p.adj_close !== undefined ? p.adj_close : p.close,
          p.source || "supabase_pull"
        );
      }
    })();

    return { pulled: data.length };
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
      .select("stock_id,date,foreign_net,trust_net,dealer_net,foreign_buy,foreign_sell,trust_buy,trust_sell,dealer_buy,dealer_sell,source")
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
          i.foreign_buy || 0,
          i.foreign_sell || 0,
          i.trust_buy || 0,
          i.trust_sell || 0,
          i.dealer_buy || 0,
          i.dealer_sell || 0,
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
  onLog: (msg: string) => void
): Promise<{ deletedRegular: number; deletedWarrants: number }> {
  if (!supabase) {
    onLog("❌ Supabase client is not initialized.");
    return { deletedRegular: 0, deletedWarrants: 0 };
  }
  const sb = supabase as any;

  onLog(`🚀 啟動 Supabase 儲存空間備份修剪與優化... (目標保留最新 ${maxTradingDays} 個交易日)`);
  
  // 1. Get cutoff date from 2330
  onLog(`🔍 查詢基準普通股 2330 倒數第 ${maxTradingDays} 個交易日的日期...`);
  const { data: dates, error: dateError } = await sb
    .from("stock_price")
    .select("date")
    .eq("stock_id", "2330")
    .order("date", { ascending: false })
    .range(maxTradingDays - 1, maxTradingDays - 1);

  if (dateError) {
    onLog(`⚠️ 無法定位第 ${maxTradingDays} 個交易日，原因: ${dateError.message}`);
    throw dateError;
  }

  if (!dates?.length) {
    onLog(`⚠️ 交易日不足 ${maxTradingDays} 天，為避免誤刪資料，本次不執行修剪。`);
    return { deletedRegular: 0, deletedWarrants: 0 };
  }
  const cutoffDate = dates[0].date;
  onLog(`🎯 基準日期鎖定為: ${cutoffDate} (大於等於此日期將安全保留)`);

  // ponytail: stock_id 長度無法可靠辨識商品類型；只做日期保留，若要依商品刪除需先有官方 instrument_type。
  const deletedWarrantsCount = 0;

  // 3. Delete old ordinary stocks data by chunks
  onLog(`🧹 正在移除早於基準日 ${cutoffDate} 的過期普通股大歷史數據...`);
  const { data: oldestPrices } = await sb
    .from("stock_price")
    .select("date")
    .order("date", { ascending: true })
    .limit(1);

  let deletedRegularCount = 0;
  if (oldestPrices && oldestPrices.length > 0) {
    const oldestDateStr = oldestPrices[0].date;
    onLog(`📍 偵測到 Supabase 目前最舊的紀錄日期為: ${oldestDateStr}`);
    
    if (oldestDateStr < cutoffDate) {
      let currentStart = new Date(oldestDateStr);
      const targetEnd = new Date(cutoffDate);
      
      while (currentStart < targetEnd) {
        let nextEnd = new Date(currentStart);
        nextEnd.setDate(nextEnd.getDate() + 14); // 14-day chunks to prevent timeout
        if (nextEnd > targetEnd) nextEnd = targetEnd;
        
        const startStr = currentStart.toISOString().split("T")[0];
        const endStr = nextEnd.toISOString().split("T")[0];
        onLog(`   👉 清理進度批次: [${startStr} 至 ${endStr}]`);
        
        const pDel = await sb.from("stock_price").delete().gte("date", startStr).lt("date", endStr);
        await sb.from("stock_institutional").delete().gte("date", startStr).lt("date", endStr);
        await sb.from("stock_features").delete().gte("date", startStr).lt("date", endStr);
        await sb.from("tdcc_shareholding").delete().gte("date", startStr).lt("date", endStr);
        
        if (pDel.data) {
          deletedRegularCount += (pDel.data as any).length || 0;
        }
        
        currentStart = nextEnd;
      }
    } else {
      onLog("✨ 目前 Supabase 沒有更舊的普通股數據，無需進行時間維度修剪。");
    }
  } else {
    onLog("⚠️ 未能在 Supabase 中尋找到有效的行情價格數據。");
  }

  onLog("🎉 Supabase 資料庫修剪與容量極限優化大功告成！");
  return { deletedRegular: deletedRegularCount, deletedWarrants: deletedWarrantsCount };
}

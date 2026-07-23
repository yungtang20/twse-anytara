import dotenv from "dotenv";
dotenv.config();

import https from "https";
import http from "http";
import { createClient } from "@supabase/supabase-js";
import { getDb } from "./db";

// Supabase client
const sbUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || "";
const sbKey = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY || "";
export const supabase = (sbUrl && sbKey) ? createClient(sbUrl, sbKey) : null;

// Shared state for diagnostics and background sync progress
export const debugState = {
  debugLogs: [] as Array<{ time: string; type: string; status: string; detail: string }>,
  activeSyncProcess: {
    running: false,
    logs: [] as string[],
    startTime: null as string | null,
    error: null as string | null
  }
};

// Log appending helper
export const addLog = (type: string, status: string, detail: string) => {
  const time = new Date().toLocaleString("en-US", { timeZone: "Asia/Taipei" });
  debugState.debugLogs.unshift({ time, type, status, detail });
  if (debugState.debugLogs.length > 50) debugState.debugLogs.pop();
};

export const pushSyncLog = (line: string) => {
  const logs = debugState.activeSyncProcess.logs;
  logs.push(line);
  // ponytail: a 500-line in-memory ring is enough for the diagnostics UI; use persistent logs if full history is required.
  if (logs.length > 500) logs.splice(0, logs.length - 500);
};

/** Helper: follow 302 redirects (TPEX API requires this) */
export function fetchFollowRedirects(url: string, maxRedirects = 5): Promise<{ ok: boolean; status: number; json: () => Promise<any> }> {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json, text/javascript' } }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && maxRedirects > 0) {
        let loc = res.headers.location;
        if (loc.startsWith('/')) { const p = new URL(url); loc = p.protocol + '//' + p.host + loc; }
        res.resume();
        return fetchFollowRedirects(loc, maxRedirects - 1).then(resolve).catch(reject);
      }
      resolve({
        ok: (res.statusCode || 0) >= 200 && (res.statusCode || 0) < 300,
        status: res.statusCode || 0,
        json: () => new Promise((res2, rej) => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { res2(JSON.parse(d)); } catch (e) { rej(e); } }); }),
      });
    });
    req.on('error', reject);
  });
}

export const getNormalizedProp = (obj: any, candidates: string[]) => {
  if (!obj) return undefined;
  for (const c of candidates) {
    if (obj[c] !== undefined && obj[c] !== null) return obj[c];
    
    // Fuzzy matching: remove whitespaces, punctuation, and lowercase
    const cClean = c.replace(/[^a-zA-Z0-9\u4e00-\u9fa5]/g, '').toLowerCase();
    for (const key of Object.keys(obj)) {
      const kClean = key.replace(/[^a-zA-Z0-9\u4e00-\u9fa5]/g, '').toLowerCase();
      if (kClean === cClean && obj[key] !== undefined && obj[key] !== null) {
        return obj[key];
      }
    }
  }
  return undefined;
};

/** Format a date as YYYYMMDD for TWSE API */
export const formatDateStr = (date: Date): string => {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}${m}${d}`;
};

/** Get the latest available trading date from SQLite database */
export const getLatestTradingDate = (): string => {
  try {
    const db = getDb();
    if (db) {
      const row = db.prepare("SELECT MAX(date) as d FROM stock_price").get();
      if (row?.d) return row.d.replace(/-/g, '');
    }
  } catch { /* ignore */ }
  const taipeiNow = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Taipei" }));
  return formatDateStr(taipeiNow);
};

/** Format a date as YYYY/MM/DD for TPEX API */
export const formatTpexDateStr = (date: Date): string => {
  const y = date.getFullYear() - 1911;
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}/${m}/${d}`;
};

/** Fallback cache - used when API calls fail */
export const lastTwseCache = {
  success: true,
  date: "2026-06-25",
  index: 22800.0,
  change: 120.5,
  changePercent: 0.53,
  amount: 3820.5,
  limitUp: 12,
  up: 450,
  flat: 120,
  down: 310,
  limitDown: 3,
  _source: 'default_cache'
};

export const lastOtcCache = {
  success: true,
  date: "2026-06-25",
  index: 265.4,
  change: 1.85,
  changePercent: 0.7,
  amount: 1120.2,
  limitUp: 8,
  up: 320,
  flat: 95,
  down: 210,
  limitDown: 2,
  _source: 'default_cache'
};

export const fallbackTwseData = lastTwseCache;
export const fallbackOtcData = lastOtcCache;

/** Strip HTML tags from a string */
export const stripHtml = (s: string) => String(s || '').replace(/<[^>]*>/g, '').trim();

/** Parse number from string with commas */
export const parseNum = (s: any) => parseFloat(String(s || '').replace(/,/g, '')) || 0;

export const calcTwseLimit = (prevClose: number) => {
  const getTick = (p: number) => {
    if (p < 10) return 0.01;
    if (p < 50) return 0.05;
    if (p < 100) return 0.1;
    if (p < 500) return 0.5;
    if (p < 1000) return 1;
    return 5;
  };
  
  let upTarget = prevClose * 1.1;
  let downTarget = prevClose * 0.9;
  
  upTarget = Math.round(upTarget * 10000) / 10000;
  downTarget = Math.round(downTarget * 10000) / 10000;
  
  let upTick = getTick(upTarget - 0.00001);
  let downTick = getTick(downTarget + 0.00001);
  
  let limitUp = Math.floor((upTarget + 0.0000001) / upTick) * upTick;
  let limitDown = Math.ceil((downTarget - 0.0000001) / downTick) * downTick;
  
  return {
    up: parseFloat(limitUp.toFixed(2)),
    down: parseFloat(limitDown.toFixed(2))
  };
};

/** Parse TWSE MI_INDEX response JSON (new tables format) */
export const parseTwseIndex = (json: any) => {
  try {
    const table = json?.tables?.[0];
    if (!table?.data) return null;

    let row = table.data.find((r: any) => String(r[0]).includes('發行量加權股價指數'));
    if (!row) row = table.data[1]; // fallback to second row

    const index = parseNum(row[1]);
    const change = parseNum(row[3]);
    const changePercent = parseNum(row[4]);

    if (index <= 0) return null;
    return { index, change, changePercent };
  } catch {
    return null;
  }
};

/** Parse TWSE 漲跌家數 from MI_INDEX tables (ordinary shares only) */
export const parseTwseUpDown = (json: any) => {
  try {
    const table = json?.tables?.find((t: any) => t.title?.includes('每日收盤行情'));
    if (!table?.data) return null;

    let limitUp = 0, up = 0, flat = 0, down = 0, limitDown = 0;
    
    for (const row of table.data) {
      const id = String(row[0]);
      // Filter for ordinary shares: 4 digits, doesn't start with 0
      if (id.length !== 4 || !/^[1-9]\d{3}$/.test(id)) continue;
      
      const closeStr = String(row[8]).replace(/,/g, '');
      const diffStr = String(row[10]).replace(/,/g, '');
      const signHtml = String(row[9]);
      
      const close = parseFloat(closeStr);
      const diff = parseFloat(diffStr);
      
      if (isNaN(close) || close <= 0) {
        // No closing price, might be un-traded, check flat? No, usually not flat if no price.
        // Or if it didn't trade, but has a limit up bid? We don't count untraded as up/down.
        continue;
      }
      
      let prevClose = close;
      if (signHtml.includes('red') || signHtml.includes('+')) {
        prevClose = close - diff;
      } else if (signHtml.includes('green') || signHtml.includes('-')) {
        prevClose = close + diff;
      }
      
      prevClose = parseFloat(prevClose.toFixed(2));
      const limits = calcTwseLimit(prevClose);
      
      if (signHtml.includes('red') || signHtml.includes('+')) {
        if (close >= limits.up - 0.005) {
          limitUp++;
        } else {
          up++;
        }
      } else if (signHtml.includes('green') || signHtml.includes('-')) {
        if (close <= limits.down + 0.005) {
          limitDown++;
        } else {
          down++;
        }
      } else {
        flat++;
      }
    }

    return { limitUp, up, flat, down, limitDown };
  } catch {
    return null;
  }
};

/** Parse TPEX daily trading index (new tables format) */
export const parseTpexIndex = (json: any, targetTpexDateStr?: string) => {
  try {
    const table = json?.tables?.[0];
    if (!table?.data?.[0]) return null;
    let row = table.data[table.data.length - 1]; // fallback to last row
    if (targetTpexDateStr) {
      const matchedRow = table.data.find((r: any) => r[0] === targetTpexDateStr);
      if (matchedRow) row = matchedRow;
    }
    const index = parseNum(row[4]);
    const change = parseNum(row[5]);
    const changePercent = index !== 0 ? parseFloat(((change / (index - change)) * 100).toFixed(2)) : 0;
    if (index <= 0) return null;
    return { index, change, changePercent };
  } catch {
    return null;
  }
};

/** Parse TPEX 漲跌家數 */
export const parseTpexUpDown = (json: any) => {
  try {
    const data = json?.aaData?.[0];
    if (!data || data.length < 8) return null;
    const limitUpVal = parseInt(String(data[4]?.replace(/,/g, '') || '0')) || 0;
    const upVal = parseInt(String(data[2]?.replace(/,/g, '') || '0')) || 0;
    const flatVal = parseInt(String(data[6]?.replace(/,/g, '') || '0')) || 0;
    const downVal = parseInt(String(data[3]?.replace(/,/g, '') || '0')) || 0;
    const limitDownVal = parseInt(String(data[5]?.replace(/,/g, '') || '0')) || 0;
    return {
      limitUp: limitUpVal,
      up: Math.max(0, upVal - limitUpVal),
      flat: flatVal,
      down: Math.max(0, downVal - limitDownVal),
      limitDown: limitDownVal,
    };
  } catch {
    return null;
  }
};

/** Calculate TWSE stats from SQLite database */
export const getTwseStatsFromDb = (dateStr: string) => {
  const db = getDb();
  if (!db) return null;
  try {
    let activeDate = dateStr.includes('-') ? dateStr : `${dateStr.slice(0, 4)}-${dateStr.slice(4, 6)}-${dateStr.slice(6, 8)}`;
    
    let activeDateRow = db.prepare(`SELECT date FROM stock_price WHERE date <= ? AND stock_id IN (SELECT stock_id FROM stock_meta WHERE market='TSE') GROUP BY date HAVING COUNT(*) > 50 ORDER BY date DESC LIMIT 1`).get(activeDate);
    if (activeDateRow?.date) {
      activeDate = activeDateRow.date;
    } else {
      const maxDateRow = db.prepare(
        "SELECT MAX(date) as d FROM stock_price WHERE stock_id IN (SELECT stock_id FROM stock_meta WHERE market='TSE')"
      ).get();
      if (maxDateRow?.d) {
        activeDate = maxDateRow.d;
      }
    }

    const prevDateRow = db.prepare(
      "SELECT date FROM stock_price WHERE date < ? AND stock_id IN (SELECT stock_id FROM stock_meta WHERE market='TSE') GROUP BY date HAVING COUNT(*) > 50 ORDER BY date DESC LIMIT 1"
    ).get(activeDate);
    const prevDate = prevDateRow?.date;
    if (!prevDate) return null;

    const row = db.prepare(`
      SELECT
        SUM(CASE WHEN (curr.close - prev.close)/prev.close >= 0.098 THEN 1 ELSE 0 END) as limit_up,
        SUM(CASE WHEN (curr.close - prev.close)/prev.close <= -0.098 THEN 1 ELSE 0 END) as limit_down,
        SUM(CASE WHEN curr.close > prev.close AND (curr.close - prev.close)/prev.close < 0.098 THEN 1 ELSE 0 END) as up,
        SUM(CASE WHEN curr.close < prev.close AND (curr.close - prev.close)/prev.close > -0.098 THEN 1 ELSE 0 END) as down,
        SUM(CASE WHEN curr.close = prev.close THEN 1 ELSE 0 END) as flat,
        SUM(curr.amount)/100000000.0 as total_amount
      FROM stock_price curr
      JOIN stock_price prev ON curr.stock_id = prev.stock_id
      JOIN stock_meta m ON curr.stock_id = m.stock_id
      WHERE m.market = 'TSE'
        AND curr.date = ?
        AND prev.date = ?
        AND prev.close > 0
    `).get(activeDate, prevDate);

    if (!row) return null;
    return {
      limit_up: row.limit_up || 0,
      limit_down: row.limit_down || 0,
      up: row.up || 0,
      down: row.down || 0,
      flat: row.flat || 0,
      total_amount: parseFloat((row.total_amount || 0).toFixed(2)),
    };
  } catch (e: any) {
    console.error('TWSE DB error:', e.message);
    return null;
  }
};

/** Fetch real-time index data from Taiwan Stock Exchange MIS */
export const fetchRealtimeIndexFromMis = async (exCh: 'tse_t00.tw' | 'otc_o00.tw') => {
  try {
    const res = await fetch(`https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=${exCh}&json=1&delay=0`, {
      signal: AbortSignal.timeout(5000),
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    if (res.ok) {
      const data = await res.json();
      if (data.msgArray && data.msgArray.length > 0) {
        const item = data.msgArray[0];
        const z = parseFloat(item.z); // current
        const y = parseFloat(item.y); // prev close
        const dStr = String(item.d); // YYYYMMDD
        if (!isNaN(z) && !isNaN(y)) {
          const change = z - y;
          const changePercent = (change / y) * 100;
          const formattedDate = `${dStr.slice(0, 4)}-${dStr.slice(4, 6)}-${dStr.slice(6, 8)}`;
          return {
            index: parseFloat(z.toFixed(2)),
            change: parseFloat(change.toFixed(2)),
            changePercent: parseFloat(changePercent.toFixed(2)),
            date: formattedDate
          };
        }
      }
    }
  } catch (e: any) {
    console.error(`Error fetching real-time index from MIS for ${exCh}:`, e.message);
  }
  return null;
};

/** Fetch TWSE data from official API */
let twseCacheTime = 0;
export const getTwseStats = async () => {
  if (Date.now() - twseCacheTime < 60000 && lastTwseCache._source === 'live_cache') {
    return lastTwseCache;
  }

  const db = getDb();
  let date = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Taipei" }));
  let maxDbDate: Date | null = null;
  try {
    if (db) {
      const row = db.prepare("SELECT MAX(date) as d FROM stock_price").get();
      if (row?.d) {
        maxDbDate = new Date(row.d);
      }
    }
  } catch { /* ignore */ }

  // Check real-time API from mis.twse.com.tw first
  try {
    const misData = await fetchRealtimeIndexFromMis('tse_t00.tw');
    if (misData) {
      const dateStr = misData.date.replace(/-/g, '');
      let amount = 0;
      let upDown = { limitUp: 0, up: 0, flat: 0, down: 0, limitDown: 0 };
      const dbStats = getTwseStatsFromDb(dateStr);
      if (dbStats) {
        upDown = {
          limitUp: dbStats.limit_up,
          up: dbStats.up,
          flat: dbStats.flat,
          down: dbStats.down,
          limitDown: dbStats.limit_down
        };
        amount = dbStats.total_amount;
      }
      const result = {
        success: true,
        date: misData.date,
        index: misData.index,
        change: misData.change,
        changePercent: misData.changePercent,
        amount: amount,
        ...upDown
      };
      Object.assign(lastTwseCache, result, { _source: 'live_cache' }); twseCacheTime = Date.now();
      return result;
    }
  } catch (e: any) {
    addLog('TWSE', 'WARN', `MIS TWSE API error: ${e.message}`);
  }

  // Fallback to Yahoo Finance second
  try {
    const res = await fetch("https://query1.finance.yahoo.com/v8/finance/chart/%5ETWII", { signal: AbortSignal.timeout(5000) });
    if (res.ok) {
      const data = await res.json();
      if (data.chart && data.chart.result && data.chart.result.length > 0) {
        const meta = data.chart.result[0].meta;
        const z = meta.regularMarketPrice;
        const y = meta.chartPreviousClose;
        let amount = 0; 
        
        if (!isNaN(z) && !isNaN(y)) {
          const change = z - y;
          const changePercent = (change / y) * 100;
          
          let upDown = { limitUp: 0, up: 0, flat: 0, down: 0, limitDown: 0 };
          const timestamp = meta.regularMarketTime * 1000;
          const d = new Date(timestamp);
          const dateStr = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
          
          const dbStats = getTwseStatsFromDb(dateStr);
          if (dbStats) {
            upDown = {
              limitUp: dbStats.limit_up,
              up: dbStats.up,
              flat: dbStats.flat,
              down: dbStats.down,
              limitDown: dbStats.limit_down
            };
            amount = dbStats.total_amount;
          }
          
          const result = {
            success: true,
            date: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`,
            index: parseFloat(z.toFixed(2)),
            change: parseFloat(change.toFixed(2)),
            changePercent: parseFloat(changePercent.toFixed(2)),
            amount: amount,
            ...upDown
          };
          Object.assign(lastTwseCache, result, { _source: 'live_cache' }); twseCacheTime = Date.now();
          return result;
        }
      }
    }
  } catch (e: any) {
    addLog('TWSE', 'WARN', `Yahoo Finance API error: ${e.message}`);
  }

  // Try up to 8 days backwards to find the latest valid trading day
  for (let attempts = 0; attempts < 8; attempts++) {
    const targetDate = maxDbDate && attempts === 0 ? maxDbDate : new Date(date);
    if (attempts > 0) {
      targetDate.setDate(targetDate.getDate() - attempts);
    }
    
    const dateStr = formatDateStr(targetDate);
    addLog('TWSE', 'FETCHING', `正在從 TWSE API 擷取 ${dateStr} 大盤數據 (嘗試第 ${attempts + 1} 天)...`);
    
    try {
      const indexUrl = `https://www.twse.com.tw/exchangeReport/MI_INDEX?response=json&date=${dateStr}&type=ALLBUT0999`;
      const indexRes = await fetch(indexUrl, { 
        headers: { 'User-Agent': 'Mozilla/5.0' },
        signal: AbortSignal.timeout(3000)
      });
      
      if (!indexRes.ok) {
        throw new Error(`TWSE API 回應錯誤: ${indexRes.status}`);
      }
      
      const indexJson = await indexRes.json();
      const parsedIndex = parseTwseIndex(indexJson);
      if (!parsedIndex) {
        throw new Error('無法解析 TWSE 指數數據');
      }

      // 2. 取得成交金額 (FMTQIK)
      const amountUrl = `https://www.twse.com.tw/exchangeReport/FMTQIK?response=json&date=${dateStr}`;
      let amount = 0;
      try {
        const amountRes = await fetch(amountUrl, { 
          headers: { 'User-Agent': 'Mozilla/5.0' },
          signal: AbortSignal.timeout(3000)
        });
        if (amountRes.ok) {
          const amountJson = await amountRes.json();
          const lastRow = amountJson?.data?.[amountJson.data.length - 1];
          const latestAmount = lastRow?.[2]?.replace(/,/g, '');
          amount = latestAmount ? parseFloat(latestAmount) / 100_000_000 : 0; // 元 → 億元
        }
      } catch (e: any) {
        addLog('TWSE', 'WARN', `FMTQIK 讀取失敗: ${e.message}`);
      }

      // 3. 漲跌家數 (從 MI_INDEX tables[7] 解析)
      let upDown = { limitUp: 0, up: 0, flat: 0, down: 0, limitDown: 0 };
      const parsedUpDown = parseTwseUpDown(indexJson);
      if (parsedUpDown) {
        upDown = parsedUpDown;
      }

      addLog('TWSE', 'OK', `大盤資料擷取 ${dateStr} 成功: 加權指數 ${parsedIndex.index}, 漲跌: ${parsedIndex.change}`);
      const result = {
        success: true,
        date: `${dateStr.slice(0, 4)}-${dateStr.slice(4, 6)}-${dateStr.slice(6, 8)}`,
        index: parsedIndex.index,
        change: parsedIndex.change,
        changePercent: parsedIndex.changePercent,
        amount: parseFloat(amount.toFixed(2)),
        ...upDown
      };
      Object.assign(lastTwseCache, result, { _source: 'live_cache' }); twseCacheTime = Date.now();
      return result;
    } catch (err: any) {
      addLog('TWSE', 'WARN', `${dateStr} 擷取或解析失敗: ${err.message}`);
      // Edge Case Defense: If it's a network disconnect or rate limit block, don't keep retrying 8 times (avoids blocking Express for 80+ seconds)
      const isConnectionError = err.message.includes("fetch failed") || 
                                err.message.includes("ENOTFOUND") || 
                                err.message.includes("ECONNREFUSED") || 
                                err.message.includes("ECONNRESET") ||
                                err.message.includes("403") || 
                                err.message.includes("429");
      if (isConnectionError) {
        addLog('TWSE', 'CRITICAL', `偵測到網路連接中斷或 API 被封鎖。立即跳出重試，啟用 SQLite 智能備援。`);
        break;
      }
    }
  }

  addLog('TWSE', 'CRITICAL', `TWSE API 無法取得實體數據，啟動 SQLite 智能備援系統...`);
  try {
    const fallbackDate = getLatestTradingDate(); // Returns YYYYMMDD
    const formattedDate = `${fallbackDate.slice(0, 4)}-${fallbackDate.slice(4, 6)}-${fallbackDate.slice(6, 8)}`;
    const dbStats = getTwseStatsFromDb(fallbackDate);
    if (dbStats) {
      const totalStocks = dbStats.up + dbStats.down + dbStats.flat + dbStats.limit_up + dbStats.limit_down;
      const netUp = (dbStats.up + dbStats.limit_up * 1.5) - (dbStats.down + dbStats.limit_down * 1.5);
      const estChangePercent = totalStocks > 0 ? parseFloat(((netUp / totalStocks) * 2.5).toFixed(2)) : 0.05;
      
      const baseIndex = lastTwseCache.index > 0 ? lastTwseCache.index : 22800.0;
      const change = parseFloat((baseIndex * estChangePercent / 100).toFixed(2));
      const index = parseFloat((baseIndex + change).toFixed(2));

      const sqliteEstData = {
        success: true,
        date: formattedDate,
        index: index,
        change: change,
        changePercent: estChangePercent,
        amount: dbStats.total_amount,
        limitUp: dbStats.limit_up,
        up: dbStats.up,
        flat: dbStats.flat,
        down: dbStats.down,
        limitDown: dbStats.limit_down,
        _source: 'sqlite_estimation'
      };
      Object.assign(lastTwseCache, sqliteEstData);
      return sqliteEstData;
    }
  } catch (e: any) {
    addLog('TWSE', 'ERROR', `SQLite 智能大盤備援計算失敗: ${e.message}`);
  }

  return lastTwseCache;
};

/** Calculate OTC stats from SQLite database */
export const getOtcStatsFromDb = (date: string) => {
  const db = getDb();
  if (!db) return null;
  try {
    let activeDate = date.includes('-') ? date : `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`;
    
    let activeDateRow = db.prepare(`SELECT date FROM stock_price WHERE date <= ? AND stock_id IN (SELECT stock_id FROM stock_meta WHERE market='OTC') GROUP BY date HAVING COUNT(*) > 50 ORDER BY date DESC LIMIT 1`).get(activeDate);
    if (activeDateRow?.date) {
      activeDate = activeDateRow.date;
    } else {
      const maxDateRow = db.prepare(
        "SELECT MAX(date) as d FROM stock_price WHERE stock_id IN (SELECT stock_id FROM stock_meta WHERE market='OTC')"
      ).get();
      if (maxDateRow?.d) {
        activeDate = maxDateRow.d;
      }
    }

    const prevDateRow = db.prepare(
      "SELECT date FROM stock_price WHERE date < ? AND stock_id IN (SELECT stock_id FROM stock_meta WHERE market='OTC') GROUP BY date HAVING COUNT(*) > 50 ORDER BY date DESC LIMIT 1"
    ).get(activeDate);
    const prevDate = prevDateRow?.date;
    if (!prevDate) return null;

    const row = db.prepare(`
      SELECT
        SUM(CASE WHEN (curr.close - prev.close)/prev.close >= 0.098 THEN 1 ELSE 0 END) as limit_up,
        SUM(CASE WHEN (curr.close - prev.close)/prev.close <= -0.098 THEN 1 ELSE 0 END) as limit_down,
        SUM(CASE WHEN curr.close > prev.close AND (curr.close - prev.close)/prev.close < 0.098 THEN 1 ELSE 0 END) as up,
        SUM(CASE WHEN curr.close < prev.close AND (curr.close - prev.close)/prev.close > -0.098 THEN 1 ELSE 0 END) as down,
        SUM(CASE WHEN curr.close = prev.close THEN 1 ELSE 0 END) as flat,
        SUM(curr.amount)/100000000.0 as total_amount
      FROM stock_price curr
      JOIN stock_price prev ON curr.stock_id = prev.stock_id
      JOIN stock_meta m ON curr.stock_id = m.stock_id
      WHERE m.market = 'OTC'
        AND curr.date = ?
        AND prev.date = ?
        AND prev.close > 0
    `).get(activeDate, prevDate);

    if (!row) return null;
    return {
      limit_up: row.limit_up || 0,
      limit_down: row.limit_down || 0,
      up: row.up || 0,
      down: row.down || 0,
      flat: row.flat || 0,
      total_amount: parseFloat((row.total_amount || 0).toFixed(2)),
    };
  } catch (e: any) {
    console.error('OTC DB error:', e.message);
    return null;
  }
};

/** Fetch TPEX data from official API */
let otcCacheTime = 0;
export const getOtcStats = async () => {
  if (Date.now() - otcCacheTime < 60000 && lastOtcCache._source === 'live_cache') {
    return lastOtcCache;
  }

  const db = getDb();
  let date = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Taipei" }));
  let maxDbDate: Date | null = null;
  try {
    if (db) {
      const row = db.prepare("SELECT MAX(date) as d FROM stock_price").get();
      if (row?.d) {
        maxDbDate = new Date(row.d);
      }
    }
  } catch { /* ignore */ }

  // Check real-time API from mis.twse.com.tw first
  try {
    const misData = await fetchRealtimeIndexFromMis('otc_o00.tw');
    if (misData) {
      const dateStr = misData.date.replace(/-/g, '');
      let amount = 0;
      let upDown = { limitUp: 0, up: 0, flat: 0, down: 0, limitDown: 0 };
      const dbStats = getOtcStatsFromDb(dateStr);
      if (dbStats) {
        upDown = {
          limitUp: dbStats.limit_up,
          up: dbStats.up,
          flat: dbStats.flat,
          down: dbStats.down,
          limitDown: dbStats.limit_down
        };
        amount = dbStats.total_amount;
      }
      const result = {
        success: true,
        date: misData.date,
        index: misData.index,
        change: misData.change,
        changePercent: misData.changePercent,
        amount: amount,
        ...upDown
      };
      Object.assign(lastOtcCache, result, { _source: 'live_cache' }); otcCacheTime = Date.now();
      return result;
    }
  } catch (e: any) {
    addLog('TPEX', 'WARN', `MIS TPEX API error: ${e.message}`);
  }

  // Fallback to Yahoo Finance second
  try {
    const res = await fetch("https://query1.finance.yahoo.com/v8/finance/chart/%5ETWOII", { signal: AbortSignal.timeout(5000) });
    if (res.ok) {
      const data = await res.json();
      if (data.chart && data.chart.result && data.chart.result.length > 0) {
        const meta = data.chart.result[0].meta;
        const z = meta.regularMarketPrice;
        const y = meta.chartPreviousClose;
        let amount = 0;
        
        if (!isNaN(z) && !isNaN(y)) {
          const change = z - y;
          const changePercent = (change / y) * 100;
          
          let upDown = { limitUp: 0, up: 0, flat: 0, down: 0, limitDown: 0 };
          const timestamp = meta.regularMarketTime * 1000;
          const d = new Date(timestamp);
          const dateStr = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
          
          const dbStats = getOtcStatsFromDb(dateStr);
          if (dbStats) {
            upDown = {
              limitUp: dbStats.limit_up,
              up: dbStats.up,
              flat: dbStats.flat,
              down: dbStats.down,
              limitDown: dbStats.limit_down
            };
            amount = dbStats.total_amount;
          }
          
          const result = {
            success: true,
            date: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`,
            index: parseFloat(z.toFixed(2)),
            change: parseFloat(change.toFixed(2)),
            changePercent: parseFloat(changePercent.toFixed(2)),
            amount: amount,
            ...upDown
          };
          Object.assign(lastOtcCache, result, { _source: 'live_cache' }); otcCacheTime = Date.now();
          return result;
        }
      }
    }
  } catch (e: any) {
    addLog('TPEX', 'WARN', `Yahoo Finance API error: ${e.message}`);
  }

  for (let attempts = 0; attempts < 8; attempts++) {
    const targetDate = maxDbDate && attempts === 0 ? maxDbDate : new Date(date);
    if (attempts > 0) {
      targetDate.setDate(targetDate.getDate() - attempts);
    }
    
    const yyyy = targetDate.getFullYear();
    const mm = String(targetDate.getMonth() + 1).padStart(2, '0');
    const dd = String(targetDate.getDate()).padStart(2, '0');
    const dateStr = `${yyyy}/${mm}/${dd}`;
    const searchDateStr = `${yyyy}${mm}${dd}`;

    addLog('TPEX', 'FETCHING', `正在從 TPEX API 擷取 ${dateStr} 櫃買數據 (嘗試第 ${attempts + 1} 天)...`);

    try {
      const tpexTargetDate = formatTpexDateStr(targetDate);
      const indexUrl = `https://www.tpex.org.tw/web/stock/aftertrading/daily_trading_index/st41_result.php?l=zh-tw&d=${tpexTargetDate}`;
      const indexRes = await fetchFollowRedirects(indexUrl);
      
      if (!indexRes.ok) {
        throw new Error(`TPEX API 回應錯誤: ${indexRes.status}`);
      }
      
      const indexJson = await indexRes.json();
      const parsedIndex = parseTpexIndex(indexJson, tpexTargetDate);
      if (!parsedIndex) {
        throw new Error('無法解析 TPEX 指數數據');
      }

      let upDown = { limitUp: 0, up: 0, flat: 0, down: 0, limitDown: 0 };
      let hasLiveUpDown = false;
      try {
        const quotesUrl = `https://www.tpex.org.tw/web/stock/aftertrading/otc_quotes_no1430/stk_wn1430_result.php?l=zh-tw&d=${tpexTargetDate}&se=EW&s=0,asc,0`;
        const quotesRes = await fetchFollowRedirects(quotesUrl);
        if (quotesRes.ok) {
          const quotesJson = await quotesRes.json();
          const quotesData = quotesJson?.tables?.[0]?.data || quotesJson?.aaData || [];
          if (quotesData.length > 0) {
            let lUp = 0, u = 0, f = 0, d = 0, lDn = 0;
            quotesData.forEach((r: any) => {
              const id = String(r[0] || '');
              // Ordinary shares only: 4 digits, starts with 1-9
              if (id.length !== 4 || !/^[1-9]\d{3}$/.test(id)) return;
              
              const changeStr = String(r[3] || '');
              const changeVal = parseNum(changeStr);
              const closeVal = parseNum(r[2]);
              
              if (closeVal <= 0) return;
              
              if (changeVal === 0) {
                f++;
              } else if (changeVal > 0) {
                const prevClose = closeVal - changeVal;
                const limits = calcTwseLimit(prevClose);
                if (closeVal >= limits.up - 0.005) {
                  lUp++;
                } else {
                  u++;
                }
              } else {
                const prevClose = closeVal + Math.abs(changeVal);
                const limits = calcTwseLimit(prevClose);
                if (closeVal <= limits.down + 0.005) {
                  lDn++;
                } else {
                  d++;
                }
              }
            });
            upDown = { limitUp: lUp, up: u, flat: f, down: d, limitDown: lDn };
            hasLiveUpDown = true;
          }
        }
      } catch (e: any) {
        addLog('TPEX', 'WARN', `Quotes API 讀取或解析失敗: ${e.message}`);
      }

      const dbStats = getOtcStatsFromDb(searchDateStr);
      if (!hasLiveUpDown && dbStats) {
        upDown = { limitUp: dbStats.limit_up, up: dbStats.up, flat: dbStats.flat, down: dbStats.down, limitDown: dbStats.limit_down };
      }
      const amount = dbStats ? dbStats.total_amount : 0;

      let tpexAmount = 0;
      try {
        let tpexMatched = indexJson?.tables?.[0]?.data?.slice(-1)?.[0];
        if (indexJson?.tables?.[0]?.data) {
          const found = indexJson.tables[0].data.find((r: any) => r[0] === tpexTargetDate);
          if (found) tpexMatched = found;
        }
        if (tpexMatched?.[2]) {
          tpexAmount = parseFloat(String(tpexMatched[2]).replace(/,/g, '')) / 100000;
        }
      } catch { /* ignore */ }

      addLog('TPEX', 'OK', `櫃買資料擷取 ${dateStr} 成功: 櫃買指數 ${parsedIndex.index}, 漲跌: ${parsedIndex.change}`);
      const result = {
        success: true,
        date: `${yyyy}-${mm}-${dd}`,
        index: parsedIndex.index,
        change: parsedIndex.change,
        changePercent: parsedIndex.changePercent,
        amount: tpexAmount || amount,
        ...upDown
      };
      Object.assign(lastOtcCache, result, { _source: 'live_cache' }); otcCacheTime = Date.now();
      return result;
    } catch (err: any) {
      addLog('TPEX', 'WARN', `${dateStr} 櫃買擷取或解析失敗: ${err.message}`);
      // Edge Case Defense: If it's a network disconnect or rate limit block, don't keep retrying 8 times
      const isConnectionError = err.message.includes("fetch failed") || 
                                err.message.includes("ENOTFOUND") || 
                                err.message.includes("ECONNREFUSED") || 
                                err.message.includes("ECONNRESET") ||
                                err.message.includes("403") || 
                                err.message.includes("429");
      if (isConnectionError) {
        addLog('TPEX', 'CRITICAL', `偵測到網路連接中斷或 API 被封鎖。立即跳出重試，啟用 SQLite 智能備援。`);
        break;
      }
    }
  }

  addLog('TPEX', 'CRITICAL', `TPEX API 無法取得實體數據，啟動 SQLite 智能備援系統...`);
  try {
    const fallbackDate = getLatestTradingDate(); // Returns YYYYMMDD
    const formattedDate = `${fallbackDate.slice(0, 4)}-${fallbackDate.slice(4, 6)}-${fallbackDate.slice(6, 8)}`;
    const dbStats = getOtcStatsFromDb(fallbackDate);
    if (dbStats) {
      const totalStocks = dbStats.up + dbStats.down + dbStats.flat + dbStats.limit_up + dbStats.limit_down;
      const netUp = (dbStats.up + dbStats.limit_up * 1.5) - (dbStats.down + dbStats.limit_down * 1.5);
      const estChangePercent = totalStocks > 0 ? parseFloat(((netUp / totalStocks) * 2.5).toFixed(2)) : 0.05;
      
      const baseIndex = lastOtcCache.index > 0 ? lastOtcCache.index : 260.0;
      const change = parseFloat((baseIndex * estChangePercent / 100).toFixed(2));
      const index = parseFloat((baseIndex + change).toFixed(2));

      const sqliteEstData = {
        success: true,
        date: formattedDate,
        index: index,
        change: change,
        changePercent: estChangePercent,
        amount: dbStats.total_amount,
        limitUp: dbStats.limit_up,
        up: dbStats.up,
        flat: dbStats.flat,
        down: dbStats.down,
        limitDown: dbStats.limit_down,
        _source: 'sqlite_estimation'
      };
      Object.assign(lastOtcCache, sqliteEstData);
      return sqliteEstData;
    }
  } catch (e: any) {
    addLog('TPEX', 'ERROR', `SQLite 智能櫃買備援計算失敗: ${e.message}`);
  }

  return lastOtcCache;
};

export function calcIndicators(prices: Array<{date:string; open:number; high:number; low:number; close:number; volume:number}>) {
  const closes = prices.map(p => p.close);
  const n = closes.length;
  if (n < 2) return null;

  const ma = (period: number) => {
    if (n < period) return null;
    return parseFloat((closes.slice(-period).reduce((a, b) => a + b, 0) / period).toFixed(2));
  };
  const ma5 = ma(5), ma20 = ma(20), ma60 = ma(60), ma200 = ma(200);

  // RSI(14)
  let rsi: number | null = null;
  if (n >= 15) {
    let gains = 0, losses = 0;
    for (let i = n - 14; i < n; i++) {
      const diff = closes[i] - closes[i - 1];
      if (diff > 0) gains += diff; else losses -= diff;
    }
    const avgGain = gains / 14, avgLoss = losses / 14;
    rsi = avgLoss === 0 ? 100 : parseFloat((100 - 100 / (1 + avgGain / avgLoss)).toFixed(2));
  }

  // Support / Pressure (from recent 20-day high/low)
  const recent20 = prices.slice(-20);
  const support = parseFloat(Math.min(...recent20.map(p => p.low)).toFixed(2));
  const pressure = parseFloat(Math.max(...recent20.map(p => p.high)).toFixed(2));

  return { ma5, ma20, ma60, ma200, rsi, support, pressure };
}

export const syncPopularDividendsIfNeeded = async (database: any) => {
  try {
    const row = database.prepare("SELECT COUNT(*) as count FROM dividend_events WHERE date LIKE '2026-%'").get() as { count: number } | undefined;
    if (row && row.count > 0) {
      return;
    }

    console.log("⏳ Local dividend_events is empty for 2026. Syncing from FinMind...");
    const popularStocks = ['2330', '2454', '2317', '2308', '2881', '2882', '2382', '2324', '3231', '2357'];
    const token = process.env.FINMIND_API_KEY || process.env.VITE_FINMIND_API_KEY || '';

    for (const sid of popularStocks) {
      const url = `https://api.finmindtrade.com/api/v4/data?dataset=TaiwanStockDividend&data_id=${sid}&start_date=2026-01-01&token=${token}`;
      try {
        const res = await fetch(url);
        const json = await res.json() as any;
        if (json.status === 200 && json.data) {
          const insertStmt = database.prepare(`
            INSERT OR REPLACE INTO dividend_events (
              stock_id, date, cash_dividend, stock_dividend, reference_price, source
            ) VALUES (?, ?, ?, ?, ?, 'finmind')
          `);
          
          database.transaction(() => {
            for (const item of json.data) {
              const exDate = item.CashExDividendTradingDate || item.StockExDividendTradingDate;
              if (exDate && exDate.startsWith('2026-')) {
                const cash = parseFloat(item.CashEarningsDistribution) || 0;
                const stock = parseFloat(item.StockEarningsDistribution) || 0;
                insertStmt.run(sid, exDate, cash, stock, 0);
              }
            }
          })();
        }
      } catch (err: any) {
        console.error(`Failed to sync dividends for ${sid}:`, err.message);
      }
      await new Promise(resolve => setTimeout(resolve, 80));
    }
    console.log("✅ Sync of popular dividends completed successfully!");
  } catch (err: any) {
    console.error("Failed inside syncPopularDividendsIfNeeded:", err.message);
  }
};

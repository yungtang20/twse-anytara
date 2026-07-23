// Pure-Node TDCC open-data downloader.  No Python dependency.
// Weekly CSV source: https://opendata.tdcc.com.tw/getOD.ashx?id=1-5  (~2.3MB)
import { getDb } from "../db";
import { supabase, addLog } from "../services";
import { fetchWithOneRetry } from "./fetchRetry";

export interface TdccRecord {
  stock_id: string;
  date: string;
  total_shares: number;
  whale_ratio: number;
  retail_ratio: number;
}

export interface TdccParseResult {
  records: TdccRecord[];
  date: string;
  parsedRows: number;
}

export interface TdccCloudResult {
  attempted: boolean;
  synced: boolean;
  error?: string;
}

const OPEN_DATA_URL = "https://opendata.tdcc.com.tw/getOD.ashx?id=1-5";

export async function downloadTdccCSV(): Promise<string> {
  const res = await fetchWithOneRetry(OPEN_DATA_URL, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      Accept: "*/*",
    },
  }, undefined, 30_000);
  if (!res.ok) throw new Error(`TDCC open data HTTP ${res.status}`);
  const text = await res.text();
  if (!text || text.length < 100) throw new Error("TDCC response empty");
  return text;
}

// Parse CSV with columns: 資料日期,證券代號,持股分級,人數,股數,占集保庫存數比例%
// Aggregate by (stock_id, date):  total_shares = all-whare (level 17 if present, else sum of 1..17)
// whale_shares = sum of shares where level >= 12 (1000+張大股東 level)
// retail_shares = sum of shares where level <= 6
function normalizeTdccDate(value: string): string | null {
  const raw = value.trim().replace(/^['"]|['"]$/g, "");
  let normalized = "";
  if (/^\d{8}$/.test(raw)) normalized = `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
  if (/^\d{7}$/.test(raw)) {
    const year = Number(raw.slice(0, 3)) + 1911;
    normalized = `${year}-${raw.slice(3, 5)}-${raw.slice(5, 7)}`;
  }
  if (!normalized) normalized = raw.replace(/\//g, "-");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) return null;
  const parsed = new Date(`${normalized}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === normalized ? normalized : null;
}

function splitCsvLine(line: string): string[] {
  const values: string[] = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < line.length; index++) {
    const character = line[index];
    if (character === '"') {
      if (quoted && line[index + 1] === '"') { value += '"'; index++; }
      else quoted = !quoted;
    } else if (character === "," && !quoted) {
      values.push(value.trim());
      value = "";
    } else {
      value += character;
    }
  }
  if (quoted) return [];
  values.push(value.trim());
  return values;
}

export function parseTdccCSV(csvText: string): TdccParseResult {
  const lines = csvText.replace(/^﻿/, "").trim().split(/\r?\n/);
  const levelMap: Record<string, Record<number, number>> = {}; // date -> level -> shares
  let parsedRows = 0;

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.includes("資料日期")) continue;
    const parts = splitCsvLine(line).map((value) => value.replace(/^'|'$/g, ""));
    if (parts.length < 6) continue;
    const date = normalizeTdccDate(parts[0]);
    const stockId = parts[1].toUpperCase();
    const level = parseInt(parts[2], 10);
    const shares = Number(parts[4].replace(/,/g, ""));
    if (!date || !/^[0-9A-Z]{4,10}$/.test(stockId) || !Number.isInteger(level) || level < 1 || level > 17 || !Number.isFinite(shares) || shares < 0) continue;
    const key = `${stockId}_${date}`;
    if (!levelMap[key]) levelMap[key] = {};
    levelMap[key][level] = (levelMap[key][level] || 0) + shares;
    parsedRows++;
  }

  const records: TdccRecord[] = [];
  for (const [key, sharesByLevel] of Object.entries(levelMap)) {
    const stockId = key.split("_")[0];
    const date = key.slice(stockId.length + 1);
    let totalShares = sharesByLevel[17] || 0;
    if (!totalShares) {
      // fallback: sum all levels
      totalShares = Object.values(sharesByLevel).reduce((a, b) => a + b, 0);
    }
    // whale = level 12-16 (大型持碼人 + 1000+張); level 15 in some APIs is 1000+
    let whaleShares = 0;
    let retailShares = 0;
    for (const [lvlStr, shares] of Object.entries(sharesByLevel)) {
      const lvl = parseInt(lvlStr, 10);
      if (lvl >= 12 && lvl <= 16) whaleShares += shares;
      if (lvl >= 1 && lvl <= 6) retailShares += shares;
    }
    if (!totalShares || whaleShares > totalShares || retailShares > totalShares) continue;
    records.push({
      stock_id: stockId,
      date,
      total_shares: Math.round(totalShares),
      whale_ratio: Math.round((whaleShares / totalShares) * 10000) / 100,
      retail_ratio: Math.round((retailShares / totalShares) * 10000) / 100,
    });
  }

  const date = records.map((record) => record.date).sort().at(-1) || "";
  return { records, date, parsedRows };
}

export async function saveTdccToSQLite(records: TdccRecord[], source = "opendata", db = getDb()): Promise<number> {
  const tx = db.transaction((recs: TdccRecord[]) => {
    // one row per (stock_id, date); whale/retail ratio latest per stock
    const seen = new Set<string>();
    let n = 0;
    for (const r of recs) {
      const key = `${r.stock_id}_${r.date}`;
      if (seen.has(key)) continue;
      seen.add(key);
      db.prepare(
        `INSERT INTO tdcc_shareholding
          (stock_id, date, total_shares, whale_ratio, retail_ratio, source, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
         ON CONFLICT(stock_id, date) DO UPDATE SET
           total_shares=excluded.total_shares,
           whale_ratio=excluded.whale_ratio,
           retail_ratio=excluded.retail_ratio,
           source=excluded.source,
           updated_at=excluded.updated_at`
      ).run(r.stock_id, r.date, r.total_shares, r.whale_ratio, r.retail_ratio, source);
      n++;
    }
    return n;
  });
  return tx(records);
}

export async function saveTdccToSupabase(records: TdccRecord[], source = "opendata"): Promise<TdccCloudResult> {
  if (!supabase) return { attempted: false, synced: false };
  try {
    const rows = records.map((r) => ({
      stock_id: r.stock_id,
      date: r.date,
      total_shares: r.total_shares,
      whale_ratio: r.whale_ratio,
      retail_ratio: r.retail_ratio,
      source,
    }));
    const CHUNK = 500;
    for (let i = 0; i < rows.length; i += CHUNK) {
      const { error } = await supabase.from("tdcc_shareholding").upsert(rows.slice(i, i + CHUNK), {
        onConflict: "stock_id,date",
      });
      if (error) throw error;
    }
    addLog("TDCC_SUPABASE", "OK", `synced ${rows.length} TDCC rows`);
    return { attempted: true, synced: true };
  } catch (e: any) {
    console.warn("[tdcc] supabase upsert failed:", e.message);
    return { attempted: true, synced: false, error: e.message?.slice(0, 200) || "unknown" };
  }
}

export function getTdccSqliteStatus(): { latest: string | null; totalDistinctStocks: number; totalRows: number } {
  try {
    const db = getDb();
    const r1 = db.prepare(`SELECT MAX(date) as latest FROM tdcc_shareholding`).get() as any;
    const r2 = db.prepare(`SELECT COUNT(DISTINCT stock_id) as c FROM tdcc_shareholding`).get() as any;
    const r3 = db.prepare(`SELECT COUNT(*) as c FROM tdcc_shareholding`).get() as any;
    return { latest: r1?.latest || null, totalDistinctStocks: r2?.c || 0, totalRows: r3?.c || 0 };
  } catch { return { latest: null, totalDistinctStocks: 0, totalRows: 0 }; }
}

// Master sync flow
export async function ingestTdccCSV(
  csvText: string,
  opts: { toSqlite?: boolean; toSupabase?: boolean; source?: string; log?: (m: string) => void } = {},
): Promise<{ count: number; date: string; parsedRows: number; cloud: TdccCloudResult }> {
  const log = opts.log || ((m: string) => console.log("[tdcc]", m));
  const toSqlite = opts.toSqlite !== false;
  const toSupabase = opts.toSupabase !== false;
  const source = opts.source || "opendata";
  const { records, date, parsedRows } = parseTdccCSV(csvText);
  if (records.length === 0 || !date) throw new Error("TDCC CSV 沒有可用紀錄");
  log(`解析完成 ${records.length} 股 / ${parsedRows} 級距列 (每周基準日 ${date})`);

  let inserted = 0;
  if (toSqlite) {
    inserted = await saveTdccToSQLite(records, source);
    log(`SQLite 入庫 ${inserted} 筆`);
  }
  let cloud: TdccCloudResult = { attempted: false, synced: false };
  if (toSupabase) {
    cloud = await saveTdccToSupabase(records, source);
    log(cloud.synced ? "Supabase 同步完成" : cloud.attempted ? `Supabase 同步失敗: ${cloud.error}` : "Supabase 未設定，略過同步");
  }
  return { count: inserted, date, parsedRows, cloud };
}

type TdccSyncResult = { count: number; date: string; parsedRows: number; cloud: TdccCloudResult };
let syncInFlight: Promise<TdccSyncResult> | null = null;

export async function syncTdcc(opts: { toSqlite?: boolean; toSupabase?: boolean; log?: (m: string) => void } = {}): Promise<TdccSyncResult> {
  const log = opts.log || ((m: string) => console.log("[tdcc]", m));
  if (syncInFlight) {
    log("已有 TDCC 同步進行中，共用現有工作");
    return syncInFlight;
  }
  syncInFlight = (async () => {
    log("下載 TDCC 每周 open data...");
    const csv = await downloadTdccCSV();
    log(`下載完成 (${(csv.length / 1024).toFixed(0)} KB)`);
    return ingestTdccCSV(csv, { ...opts, source: "opendata", log });
  })();
  try {
    return await syncInFlight;
  } finally {
    syncInFlight = null;
  }
}

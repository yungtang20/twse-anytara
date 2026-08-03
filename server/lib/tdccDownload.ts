// Pure-Node TDCC open-data downloader.  No Python dependency.
// Weekly CSV source: https://opendata.tdcc.com.tw/getOD.ashx?id=1-5  (~2.3MB)
import { getDb } from "../db";
import { supabaseAdmin, addLog } from "../services";
import { fetchWithOneRetry } from "./fetchRetry";
import { isOrdinaryStockId, loadEligibleOrdinaryStockIds as loadCanonicalEligibleStockIds } from "./stockUniverse";

export interface TdccRecord {
  stock_id: string;
  date: string;
  total_shares: number;
  whale_ratio: number;
  // NULL when the source cannot supply TDCC levels 1-6 (e.g. goodinfo_tdcc_bootstrap).
  retail_ratio: number | null;
  total_people: number | null;
  whale_shares: number | null;
  whale_people: number | null;
}

export interface TdccParseResult {
  records: TdccRecord[];
  date: string;
  parsedRows: number;
  rawSymbols: string[];
  parsedSymbols: string[];
}

export interface TdccFilterReport {
  rawSymbols: number;
  parsedSymbols: number;
  eligibleSymbols: number;
  matchedSymbols: number;
  excludedSymbols: number;
  eligibleButMissingSymbols: number;
  recordsToWrite: number;
  excludedStockIds: string[];
  eligibleButMissingStockIds: string[];
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
// whale_shares = level 15 (1,000,001 shares and above = 1,000+ lots)
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
  const levelMap: Record<string, Record<number, { shares: number; people: number }>> = {};
  const rawSymbols = new Set<string>();
  const parsedSymbols = new Set<string>();
  let parsedRows = 0;

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.includes("資料日期")) continue;
    const parts = splitCsvLine(line).map((value) => value.replace(/^'|'$/g, ""));
    if (parts.length < 6) continue;
    const date = normalizeTdccDate(parts[0]);
    const stockId = parts[1].toUpperCase();
    if (stockId) rawSymbols.add(stockId);
    const level = parseInt(parts[2], 10);
    const people = Number(parts[3].replace(/,/g, ""));
    const shares = Number(parts[4].replace(/,/g, ""));
    if (!date || !isOrdinaryStockId(stockId) || !Number.isInteger(level) || level < 1 || level > 17
      || !Number.isFinite(people) || people < 0 || !Number.isFinite(shares) || shares < 0) continue;
    parsedSymbols.add(stockId);
    const key = `${stockId}_${date}`;
    if (!levelMap[key]) levelMap[key] = {};
    const previous = levelMap[key][level] || { shares: 0, people: 0 };
    levelMap[key][level] = { shares: previous.shares + shares, people: previous.people + people };
    parsedRows++;
  }

  const records: TdccRecord[] = [];
  for (const [key, sharesByLevel] of Object.entries(levelMap)) {
    const stockId = key.split("_")[0];
    const date = key.slice(stockId.length + 1);
    let totalShares = sharesByLevel[17]?.shares || 0;
    let totalPeople = sharesByLevel[17]?.people || 0;
    if (!totalShares) {
      // fallback: sum all levels
      totalShares = Object.values(sharesByLevel).reduce((sum, row) => sum + row.shares, 0);
      totalPeople = Object.values(sharesByLevel).reduce((sum, row) => sum + row.people, 0);
    }
    // Level 15 is 1,000,001 shares and above. Level 16 is an adjustment row.
    let whaleShares = 0;
    let whalePeople = 0;
    let retailShares = 0;
    for (const [lvlStr, row] of Object.entries(sharesByLevel)) {
      const lvl = parseInt(lvlStr, 10);
      if (lvl === 15) { whaleShares += row.shares; whalePeople += row.people; }
      if (lvl >= 1 && lvl <= 6) retailShares += row.shares;
    }
    if (!totalShares || whaleShares > totalShares || retailShares > totalShares) continue;
    records.push({
      stock_id: stockId,
      date,
      total_shares: Math.round(totalShares),
      whale_ratio: Math.round((whaleShares / totalShares) * 10000) / 100,
      retail_ratio: Math.round((retailShares / totalShares) * 10000) / 100,
      total_people: Math.round(totalPeople),
      whale_shares: Math.round(whaleShares),
      whale_people: Math.round(whalePeople),
    });
  }

  const date = records.map((record) => record.date).sort().at(-1) || "";
  return {
    records,
    date,
    parsedRows,
    rawSymbols: [...rawSymbols].sort(),
    parsedSymbols: [...parsedSymbols].sort(),
  };
}

export function loadEligibleOrdinaryStockIds(db = getDb()): Set<string> {
  return loadCanonicalEligibleStockIds(db);
}

export interface TdccCoverageRow {
  stock_id: string;
  date: string | null;
  total_shares: number | null;
  whale_ratio: number | null;
  retail_ratio: number | null;
  total_people: number | null;
  whale_shares: number | null;
  whale_people: number | null;
}

export interface TdccStockCoverage {
  stockId: string;
  distinctWeeks: number;
  coreCompleteWeeks: number;
  latestDate: string | null;
  detailIncompleteRows: number;
}

export interface TdccCoverageSummary {
  reached52Weeks: number;
  partial: number;
  missing: number;
  coreIncompleteRows: number;
  detailIncompleteRows: number;
  perStock: TdccStockCoverage[];
}

export function selectCoreCompleteTdccDates(
  rows: Array<{ date: string; total_shares: number | null; whale_ratio: number | null }>,
): Set<string> {
  return new Set(rows
    .filter((row) => row.total_shares !== null && row.total_shares !== undefined
      && row.whale_ratio !== null && row.whale_ratio !== undefined)
    .map((row) => row.date));
}

export function selectTdccBackfillCandidates(rows: TdccStockCoverage[]): string[] {
  return rows
    .filter((row) => row.coreCompleteWeeks < 52)
    .sort((left, right) => left.coreCompleteWeeks - right.coreCompleteWeeks
      || left.stockId.localeCompare(right.stockId))
    .map((row) => row.stockId);
}

export function summarizeTdccCoverage(
  eligibleStockIds: ReadonlySet<string>,
  rows: TdccCoverageRow[],
): TdccCoverageSummary {
  const states = new Map<string, {
    dates: Set<string>;
    coreDates: Set<string>;
    latestDate: string | null;
    detailIncompleteKeys: Set<string>;
    coreIncompleteKeys: Set<string>;
  }>();
  for (const stockId of eligibleStockIds) {
    states.set(stockId, {
      dates: new Set(), coreDates: new Set(), latestDate: null,
      detailIncompleteKeys: new Set(), coreIncompleteKeys: new Set(),
    });
  }
  for (const row of rows) {
    const state = states.get(row.stock_id);
    if (!state || !row.date) continue;
    const date = String(row.date);
    state.dates.add(date);
    if (!state.latestDate || date > state.latestDate) state.latestDate = date;
    const coreComplete = row.total_shares !== null && row.total_shares !== undefined
      && row.whale_ratio !== null && row.whale_ratio !== undefined;
    if (coreComplete) state.coreDates.add(date);
    else state.coreIncompleteKeys.add(date);
    const detailComplete = [row.retail_ratio, row.total_people, row.whale_shares, row.whale_people]
      .every((value) => value !== null && value !== undefined);
    if (!detailComplete) state.detailIncompleteKeys.add(date);
  }
  const perStock = [...states.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([stockId, state]) => ({
    stockId,
    distinctWeeks: state.dates.size,
    coreCompleteWeeks: state.coreDates.size,
    latestDate: state.latestDate,
    detailIncompleteRows: state.detailIncompleteKeys.size,
  }));
  return {
    reached52Weeks: perStock.filter((stock) => stock.coreCompleteWeeks >= 52).length,
    partial: perStock.filter((stock) => stock.distinctWeeks > 0 && stock.coreCompleteWeeks < 52).length,
    missing: perStock.filter((stock) => stock.distinctWeeks === 0).length,
    coreIncompleteRows: [...states.values()].reduce((sum, state) => sum + state.coreIncompleteKeys.size, 0),
    detailIncompleteRows: [...states.values()].reduce((sum, state) => sum + state.detailIncompleteKeys.size, 0),
    perStock,
  };
}

export function filterTdccRecordsByEligibleStocks(
  parsed: TdccParseResult,
  eligibleStockIds: ReadonlySet<string>,
): { records: TdccRecord[]; report: TdccFilterReport } {
  const parsedSet = new Set(parsed.parsedSymbols);
  const records = parsed.records.filter((record) => eligibleStockIds.has(record.stock_id));
  const matched = new Set(records.map((record) => record.stock_id));
  const excludedStockIds = [...parsedSet].filter((stockId) => !eligibleStockIds.has(stockId)).sort();
  const eligibleButMissingStockIds = [...eligibleStockIds]
    .filter((stockId) => !parsedSet.has(stockId))
    .sort();
  return {
    records,
    report: {
      rawSymbols: parsed.rawSymbols.length,
      parsedSymbols: parsedSet.size,
      eligibleSymbols: eligibleStockIds.size,
      matchedSymbols: matched.size,
      excludedSymbols: excludedStockIds.length,
      eligibleButMissingSymbols: eligibleButMissingStockIds.length,
      recordsToWrite: records.length,
      excludedStockIds,
      eligibleButMissingStockIds,
    },
  };
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
        `INSERT INTO shareholding_unified
          (stock_id, date, source, total_shares, whale_ratio, retail_ratio,
           total_people, whale_shares, whale_people, updated_at)
         VALUES (?, ?, 'tdcc', ?, ?, ?, ?, ?, ?, datetime('now'))
         ON CONFLICT(stock_id, date) DO UPDATE SET
           source = 'tdcc',
           total_shares = excluded.total_shares,
           whale_ratio = excluded.whale_ratio,
           retail_ratio = COALESCE(excluded.retail_ratio, shareholding_unified.retail_ratio),
           total_people = COALESCE(excluded.total_people, shareholding_unified.total_people),
           whale_shares = COALESCE(excluded.whale_shares, shareholding_unified.whale_shares),
           whale_people = COALESCE(excluded.whale_people, shareholding_unified.whale_people),
           updated_at = excluded.updated_at`,
      ).run(
        r.stock_id, r.date, r.total_shares, r.whale_ratio, r.retail_ratio,
        r.total_people, r.whale_shares, r.whale_people,
      );
      n++;
    }
    return n;
  });
  return tx(records);
}

export async function saveTdccToSupabase(records: TdccRecord[], source = "opendata"): Promise<TdccCloudResult> {
  if (!supabaseAdmin) return { attempted: false, synced: false };
  try {
    const rows = records.map((r) => ({
      stock_id: r.stock_id,
      date: r.date,
      total_shares: r.total_shares,
      whale_ratio: r.whale_ratio,
      retail_ratio: r.retail_ratio ?? null,
      total_people: r.total_people ?? null,
      whale_shares: r.whale_shares ?? null,
      whale_people: r.whale_people ?? null,
      source,
    }));
    const CHUNK = 500;
    for (let i = 0; i < rows.length; i += CHUNK) {
      const { error } = await supabaseAdmin.from("tdcc_shareholding").upsert(rows.slice(i, i + CHUNK), {
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
    const eligible = `m.status = 'active' AND m.type IN ('COMMON', 'stock')
      AND m.market IN ('TSE', 'OTC')`;
    const fromEligible = `FROM shareholding_unified s JOIN stock_meta m ON m.stock_id = s.stock_id
      WHERE s.source = 'tdcc' AND ${eligible}`;
    const r1 = db.prepare(`SELECT MAX(s.date) as latest ${fromEligible}`).get() as any;
    const r2 = db.prepare(`SELECT COUNT(DISTINCT s.stock_id) as c ${fromEligible}`).get() as any;
    const r3 = db.prepare(`SELECT COUNT(*) as c ${fromEligible}`).get() as any;
    return { latest: r1?.latest || null, totalDistinctStocks: r2?.c || 0, totalRows: r3?.c || 0 };
  } catch { return { latest: null, totalDistinctStocks: 0, totalRows: 0 }; }
}

export interface TdccUniverseStatus {
  latest: string | null;
  totalRows: number;
  eligibleOrdinaryStocks: number;
  reached52Weeks: number;
  partial: number;
  missing: number;
  excludedNonOrdinary: number;
  missingStockMeta: number;
  confirmedNonOrdinary: number;
  inactiveStockMeta: number;
  metadataMismatch: number;
  unsupportedMarket: number;
  backfillCandidates: number;
  remainingBatches: number;
  batchSize: number;
  incompleteFieldRows: number;
  coreIncompleteRows: number;
  latestByStock: Array<{ stockId: string; latestDate: string | null }>;
  latestDateDistribution: Array<{ date: string | null; stocks: number }>;
  updatedToLatestCount: number;
  excludedRows: number;
  latestSyncMode: "tdcc_open_data_1_5_single_market_download";
  historyMode: "tdcc_history_page_per_stock_per_week_local_only_manual_approval";
}

async function readAllCloudRows(table: "stock_meta" | "tdcc_shareholding", columns: string) {
  const rows: Record<string, unknown>[] = [];
  for (let offset = 0; ; offset += 1_000) {
    const { data, error } = await supabaseAdmin!.from(table).select(columns).range(offset, offset + 999);
    if (error) throw new Error(`Cannot read ${table}: ${error.message}`);
    rows.push(...((data || []) as unknown as Record<string, unknown>[]));
    if (!data || data.length < 1_000) break;
  }
  return rows;
}

export async function getTdccUniverseStatus(batchSize = 50): Promise<TdccUniverseStatus> {
  if (!supabaseAdmin) throw new Error("Supabase service role is unavailable");
  const tdccRows = await readAllCloudRows(
    "tdcc_shareholding",
    "stock_id,date,total_shares,whale_ratio,retail_ratio,total_people,whale_shares,whale_people",
  );
  const cloudMeta = await readAllCloudRows(
    "stock_meta",
    "stock_id,status,type,market,source,last_trade_date",
  ) as unknown as TdccCleanupMetaRow[];
  const localMeta = getDb().prepare(
    "SELECT stock_id,status,type,market,source,last_trade_date FROM stock_meta",
  ).all() as TdccCleanupMetaRow[];
  const eligible = loadEligibleOrdinaryStockIds();
  let latest: string | null = null;
  let eligibleRows = 0;
  let excludedRows = 0;
  const eligibleTdccRows: TdccCoverageRow[] = [];
  for (const row of tdccRows) {
    const stockId = String(row.stock_id);
    const date = String(row.date);
    if (!eligible.has(stockId)) {
      excludedRows += 1;
      continue;
    }
    eligibleRows += 1;
    eligibleTdccRows.push(row as unknown as TdccCoverageRow);
    if (!latest || date > latest) latest = date;
  }
  const summary = summarizeTdccCoverage(eligible, eligibleTdccRows);
  const exclusions = summarizeTdccExclusionCounts(classifyTdccCleanupCandidates(
    tdccRows.map((row) => ({ stock_id: String(row.stock_id) })),
    localMeta,
    cloudMeta,
    eligible,
  ));
  const latestByStock = summary.perStock.map(({ stockId, latestDate }) => ({ stockId, latestDate }));
  const distribution = new Map<string | null, number>();
  for (const row of latestByStock) distribution.set(row.latestDate, (distribution.get(row.latestDate) || 0) + 1);
  return {
    latest, totalRows: eligibleRows, eligibleOrdinaryStocks: eligible.size,
    reached52Weeks: summary.reached52Weeks, partial: summary.partial, missing: summary.missing,
    excludedNonOrdinary: exclusions.excludedNonOrdinary,
    missingStockMeta: exclusions.missingStockMeta,
    confirmedNonOrdinary: exclusions.excludedNonOrdinary,
    inactiveStockMeta: exclusions.inactive,
    metadataMismatch: exclusions.metadataMismatch,
    unsupportedMarket: exclusions.unsupportedMarket,
    backfillCandidates: summary.partial + summary.missing,
    remainingBatches: Math.ceil((summary.partial + summary.missing) / batchSize), batchSize,
    incompleteFieldRows: summary.detailIncompleteRows, coreIncompleteRows: summary.coreIncompleteRows,
    latestByStock,
    latestDateDistribution: [...distribution.entries()]
      .sort(([left], [right]) => String(left).localeCompare(String(right)))
      .map(([date, stocks]) => ({ date, stocks })),
    updatedToLatestCount: latest ? latestByStock.filter((row) => row.latestDate === latest).length : 0,
    excludedRows,
    latestSyncMode: "tdcc_open_data_1_5_single_market_download",
    historyMode: "tdcc_history_page_per_stock_per_week_local_only_manual_approval",
  };
}

export interface TdccCleanupDryRunReport {
  dryRun: true;
  projectedDeleteSymbols: number;
  projectedDeleteRows: number;
  first100StockIds: string[];
  categories: Record<TdccCleanupCategory, TdccCleanupCategoryReport>;
}

export type TdccCleanupCategory =
  | "confirmed_nonordinary"
  | "inactive"
  | "missing_meta"
  | "local_cloud_mismatch"
  | "unsupported_market";

export interface TdccCleanupMetaRow {
  stock_id: string;
  status: string | null;
  type: string | null;
  market: string | null;
  source: string | null;
  last_trade_date: string | null;
}

export interface TdccCleanupCategoryReport {
  symbols: number;
  rows: number;
  first100StockIds: string[];
  stockIds: string[];
}

export interface TdccExclusionCounts {
  missingStockMeta: number;
  excludedNonOrdinary: number;
  inactive: number;
  metadataMismatch: number;
  unsupportedMarket: number;
}

export function summarizeTdccExclusionCounts(report: TdccCleanupDryRunReport): TdccExclusionCounts {
  return {
    missingStockMeta: report.categories.missing_meta.symbols,
    excludedNonOrdinary: report.categories.confirmed_nonordinary.symbols,
    inactive: report.categories.inactive.symbols,
    metadataMismatch: report.categories.local_cloud_mismatch.symbols,
    unsupportedMarket: report.categories.unsupported_market.symbols,
  };
}

const CLEANUP_CATEGORIES: TdccCleanupCategory[] = [
  "confirmed_nonordinary", "inactive", "missing_meta",
  "local_cloud_mismatch", "unsupported_market",
];

function isSameOfficialMetadata(local: TdccCleanupMetaRow, cloud: TdccCleanupMetaRow): boolean {
  const officialSource = /^(TWSE|TPEx)$/i;
  return officialSource.test(local.source || "")
    && local.source?.toLowerCase() === cloud.source?.toLowerCase()
    && Boolean(local.last_trade_date)
    && local.last_trade_date === cloud.last_trade_date
    && local.status === cloud.status
    && local.type === cloud.type
    && local.market === cloud.market;
}

export function classifyTdccCleanupCandidates(
  tdccRows: Array<{ stock_id: string }>,
  localMetaRows: TdccCleanupMetaRow[],
  cloudMetaRows: TdccCleanupMetaRow[],
  eligibleStockIds: ReadonlySet<string> = new Set(),
): TdccCleanupDryRunReport {
  const localMeta = new Map(localMetaRows.map((row) => [row.stock_id, row]));
  const cloudMeta = new Map(cloudMetaRows.map((row) => [row.stock_id, row]));
  const rowCounts = new Map<string, number>();
  for (const row of tdccRows) rowCounts.set(row.stock_id, (rowCounts.get(row.stock_id) || 0) + 1);
  const classified = new Map<TdccCleanupCategory, string[]>(CLEANUP_CATEGORIES.map((category) => [category, []]));

  for (const stockId of [...rowCounts.keys()].sort()) {
    if (eligibleStockIds.has(stockId)) continue;
    const local = localMeta.get(stockId);
    const cloud = cloudMeta.get(stockId);
    let category: TdccCleanupCategory | null = null;
    if (!local || !cloud) category = "missing_meta";
    else if (local.status !== "active" || cloud.status !== "active") category = "inactive";
    else if (!isSameOfficialMetadata(local, cloud)) category = "local_cloud_mismatch";
    else if (local.market !== "TSE" && local.market !== "OTC") category = "unsupported_market";
    else if ((local.type !== "COMMON" && local.type !== "stock") || !isOrdinaryStockId(stockId)) {
      category = "confirmed_nonordinary";
    }
    if (category) classified.get(category)!.push(stockId);
  }

  const categories = Object.fromEntries(CLEANUP_CATEGORIES.map((category) => {
    const stockIds = classified.get(category)!;
    return [category, {
      symbols: stockIds.length,
      rows: stockIds.reduce((sum, stockId) => sum + (rowCounts.get(stockId) || 0), 0),
      first100StockIds: stockIds.slice(0, 100),
      stockIds,
    }];
  })) as Record<TdccCleanupCategory, TdccCleanupCategoryReport>;
  const confirmed = categories.confirmed_nonordinary;
  return {
    dryRun: true,
    projectedDeleteSymbols: confirmed.symbols,
    projectedDeleteRows: confirmed.rows,
    first100StockIds: confirmed.first100StockIds,
    categories,
  };
}

export async function getTdccCleanupDryRun(): Promise<TdccCleanupDryRunReport> {
  if (!supabaseAdmin) throw new Error("Supabase service role is unavailable");
  const rows = await readAllCloudRows("tdcc_shareholding", "stock_id");
  const cloudMeta = await readAllCloudRows(
    "stock_meta",
    "stock_id,status,type,market,source,last_trade_date",
  ) as unknown as TdccCleanupMetaRow[];
  const localMeta = getDb().prepare(
    "SELECT stock_id,status,type,market,source,last_trade_date FROM stock_meta",
  ).all() as TdccCleanupMetaRow[];
  const eligible = loadEligibleOrdinaryStockIds();
  return classifyTdccCleanupCandidates(
    rows.map((row) => ({ stock_id: String(row.stock_id) })),
    localMeta,
    cloudMeta,
    eligible,
  );
}

// Master sync flow
export async function ingestTdccCSV(
  csvText: string,
  opts: {
    toSqlite?: boolean;
    toSupabase?: boolean;
    source?: string;
    log?: (m: string) => void;
    eligibleStockIds?: ReadonlySet<string>;
    writeLocal?: (records: TdccRecord[], source: string) => Promise<number>;
    writeCloud?: (records: TdccRecord[], source: string) => Promise<TdccCloudResult>;
  } = {},
): Promise<{
  count: number;
  date: string;
  parsedRows: number;
  cloud: TdccCloudResult;
  report: TdccFilterReport;
}> {
  const log = opts.log || ((m: string) => console.log("[tdcc]", m));
  const toSqlite = opts.toSqlite !== false;
  const toSupabase = opts.toSupabase !== false;
  const source = opts.source || "opendata";
  if (toSupabase && !toSqlite) throw new Error("TDCC Supabase 同步不得跳過本地 SQLite 寫入");
  const parsed = parseTdccCSV(csvText);
  if (parsed.records.length === 0 || !parsed.date) throw new Error("TDCC CSV 沒有可用紀錄");
  const eligibleStockIds = opts.eligibleStockIds || loadEligibleOrdinaryStockIds();
  if (eligibleStockIds.size === 0) throw new Error("本地 stock_meta 沒有有效普通股白名單");
  const { records, report } = filterTdccRecordsByEligibleStocks(parsed, eligibleStockIds);
  if (records.length === 0) throw new Error("TDCC CSV 與本地有效普通股白名單沒有交集");
  for (const key of [
    "rawSymbols", "parsedSymbols", "eligibleSymbols", "matchedSymbols",
    "excludedSymbols", "eligibleButMissingSymbols", "recordsToWrite",
  ] as const) log(`${key}=${report[key]}`);
  log(`解析完成 ${records.length} 筆 / ${parsed.parsedRows} 級距列 (最新週基準日 ${parsed.date})`);

  let inserted = 0;
  if (toSqlite) {
    inserted = await (opts.writeLocal || saveTdccToSQLite)(records, source);
    log(`SQLite 入庫 ${inserted} 筆`);
  }
  let cloud: TdccCloudResult = { attempted: false, synced: false };
  if (toSupabase) {
    cloud = await (opts.writeCloud || saveTdccToSupabase)(records, source);
    log(cloud.synced ? "Supabase 同步完成" : cloud.attempted ? `Supabase 同步失敗: ${cloud.error}` : "Supabase 未設定，略過同步");
  }
  return { count: inserted, date: parsed.date, parsedRows: parsed.parsedRows, cloud, report };
}

type TdccSyncResult = {
  count: number;
  date: string;
  parsedRows: number;
  cloud: TdccCloudResult;
  report: TdccFilterReport;
};
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

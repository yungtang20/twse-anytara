import { supabase, supabaseAdmin } from "./runtimeState";
import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { isEligibleOrdinaryStock, isOrdinaryStockId, type StockMetaUniverseRow } from "./stockUniverse";

export type TradeRiskType =
  | "attention" | "disposition" | "trading_halt" | "margin_restricted"
  | "short_sale_restricted" | "daytrade_restricted";
export type RiskLevel = "none" | "medium" | "high" | "critical";
export const TRADE_RISK_POLICY_ERROR = "交易風險資料無法取得，策略掃描已停止，避免回傳未經風險過濾的股票";
export const TRADE_RISK_CAPABILITIES = {
  margin_restricted: {
    supported: false,
    reason: "官方公開欄位不足以可靠拆分停止融資",
  },
} as const;

export interface StoredTradeRisk {
  id: number;
  stock_id: string;
  market: "TWSE" | "TPEx";
  risk_type: TradeRiskType;
  risk_level: Exclude<RiskLevel, "none">;
  reason: string;
  restrictions: string;
  announced_date: string | null;
  start_date: string;
  end_date: string | null;
  source: string;
  source_url: string;
  source_updated_at: string | null;
  fetched_at: string;
  is_active: boolean | number;
  raw_data?: unknown;
  record_key?: string;
}

export interface TradeRiskView {
  id: number;
  market: "TWSE" | "TPEx";
  type: TradeRiskType;
  level: Exclude<RiskLevel, "none">;
  reason: string;
  restrictions: string;
  announcedDate: string | null;
  startDate: string;
  endDate: string | null;
  isActive: boolean;
  daysUntilStart: number;
  daysUntilEnd: number | null;
  dataDate: string | null;
  source: string;
  sourceUrl: string;
  fetchedAt: string;
}

export interface RiskFlag {
  type: TradeRiskType;
  level: Exclude<RiskLevel, "none">;
  action: "exclude" | "warn";
  reason: string;
}

const LEVEL_ORDER: Record<RiskLevel, number> = { none: 0, medium: 1, high: 2, critical: 3 };
const MAX_DATA_AGE_MS = Math.max(1, Number(process.env.TRADE_RISK_MAX_AGE_HOURS || 72)) * 3_600_000;

export function taipeiDate(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
}

function calendarDays(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

export function isTradeRiskActive(row: StoredTradeRisk, today = taipeiDate()): boolean {
  if (!Boolean(row.is_active) || row.start_date > today) return false;
  if (!row.end_date) return true;
  return row.risk_type === "trading_halt" ? row.end_date > today : row.end_date >= today;
}

function normalize(row: StoredTradeRisk, today = taipeiDate()): TradeRiskView {
  const isActive = isTradeRiskActive(row, today);
  return {
    id: row.id, market: row.market, type: row.risk_type, level: row.risk_level,
    reason: row.reason, restrictions: row.restrictions,
    announcedDate: row.announced_date, startDate: row.start_date, endDate: row.end_date,
    isActive, daysUntilStart: calendarDays(today, row.start_date),
    daysUntilEnd: row.end_date ? calendarDays(today, row.end_date) : null,
    dataDate: row.source_updated_at?.slice(0, 10) || row.announced_date,
    source: row.source, sourceUrl: row.source_url, fetchedAt: row.fetched_at,
  };
}

function sortRisks(rows: TradeRiskView[]): TradeRiskView[] {
  return rows.sort((a, b) => LEVEL_ORDER[b.level] - LEVEL_ORDER[a.level]
    || a.startDate.localeCompare(b.startDate) || a.type.localeCompare(b.type));
}

async function cloudRows(stockId?: string, type?: TradeRiskType, activeOnly = false): Promise<StoredTradeRisk[]> {
  if (!supabase) throw new Error("Supabase 尚未設定");
  const today = taipeiDate();
  let query = supabase.from("stock_trade_risk").select("*");
  if (stockId) query = query.eq("stock_id", stockId);
  if (type) query = query.eq("risk_type", type);
  if (activeOnly) query = query.eq("is_active", true).lte("start_date", today).or(`end_date.is.null,end_date.gte.${today}`);
  else query = query.or(`end_date.is.null,end_date.gte.${today}`);
  const { data, error } = await query.order("start_date", { ascending: true });
  if (error) throw new Error(`Supabase 交易風險查詢失敗: ${error.message}`);
  const rows = (data || []) as StoredTradeRisk[];
  return activeOnly ? rows.filter((row) => isTradeRiskActive(row, today)) : rows;
}

function localRows(stockId?: string, type?: TradeRiskType, activeOnly = false): StoredTradeRisk[] {
  const today = taipeiDate();
  const clauses = ["(end_date IS NULL OR end_date >= ?)"];
  const params: Array<string> = [today];
  if (activeOnly) { clauses.push("is_active = 1", "start_date <= ?"); params.push(today); }
  if (stockId) { clauses.push("stock_id = ?"); params.push(stockId); }
  if (type) { clauses.push("risk_type = ?"); params.push(type); }
  const rows = readLocal(`SELECT * FROM stock_trade_risk WHERE ${clauses.join(" AND ")}`, params) as StoredTradeRisk[];
  return activeOnly ? rows.filter((row) => isTradeRiskActive(row, today)) : rows;
}

function localRiskPath(): string {
  const configuredPath = process.env.TRADE_RISK_SQLITE_PATH?.trim();
  if (!configuredPath) {
    throw new Error("TRADE_RISK_SQLITE_PATH is required for local trade-risk reads");
  }
  const candidate = path.resolve(process.cwd(), configuredPath);
  if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) {
    throw new Error(`Trade-risk SQLite path must be an existing file: ${candidate}`);
  }
  return candidate;
}

function readLocal(sql: string, params: string[] = []): unknown[] {
  const riskPath = localRiskPath();
  const database = new Database(riskPath, { readonly: true, fileMustExist: true });
  try { return database.prepare(sql).all(...params); }
  finally { database.close(); }
}

async function readRows(
  stockId?: string, type?: TradeRiskType, activeOnly = false, allowLocal = false,
): Promise<{ rows: StoredTradeRisk[]; source: "supabase" | "sqlite" }> {
  try {
    return { rows: await cloudRows(stockId, type, activeOnly), source: "supabase" };
  } catch (error) {
    if (!allowLocal) throw error;
    return { rows: localRows(stockId, type, activeOnly), source: "sqlite" };
  }
}

export async function getStockTradeRisks(stockId: string, allowLocal = false) {
  const today = taipeiDate();
  const result = await readRows(stockId, undefined, false, allowLocal);
  return buildStockTradeRiskResponse(stockId, result.rows, result.source, today);
}

export function buildStockTradeRiskResponse(
  stockId: string, rows: StoredTradeRisk[], source: "supabase" | "sqlite", today = taipeiDate(),
) {
  const risks = sortRisks(rows.map((row) => normalize(row, today)));
  const active = risks.filter((risk) => risk.isActive);
  const highest = active.reduce<RiskLevel>(
    (level, risk) => LEVEL_ORDER[risk.level] > LEVEL_ORDER[level] ? risk.level : level, "none",
  );
  return {
    stockId, asOf: today, hasActiveRisk: active.length > 0, highestLevel: highest,
    risks, source, capabilities: TRADE_RISK_CAPABILITIES,
  };
}

export async function getMarketTradeRisks(
  options: { active?: boolean; type?: TradeRiskType; allowLocal?: boolean } = {},
) {
  const result = await readRows(undefined, options.type, options.active, options.allowLocal);
  return { asOf: taipeiDate(), risks: sortRisks(result.rows.map((row) => normalize(row))), source: result.source, capabilities: TRADE_RISK_CAPABILITIES };
}

export function tradeRiskRecordKey(row: Pick<StoredTradeRisk, "stock_id" | "market" | "risk_type" | "source" | "start_date">): string {
  return [row.stock_id, row.market, row.risk_type, row.source, row.start_date].join("|");
}

function canonicalLocalRows(): StoredTradeRisk[] {
  const rows = readLocal("SELECT * FROM stock_trade_risk ORDER BY id") as StoredTradeRisk[];
  const canonical = new Map<string, StoredTradeRisk>();
  for (const row of rows) {
    const key = tradeRiskRecordKey(row);
    const previous = canonical.get(key);
    if (!previous || (!previous.end_date && row.end_date) || row.fetched_at > previous.fetched_at) canonical.set(key, row);
  }
  return [...canonical.values()];
}

function parseRawData(value: unknown): unknown {
  if (typeof value !== "string") return value || {};
  try { return JSON.parse(value); }
  catch { return { unparsed: value }; }
}

function localOrdinaryStockIds(): Set<string> {
  const columns = new Set((readLocal("PRAGMA table_info(stock_meta)") as Array<{ name: string }>).map((row) => row.name));
  const status = columns.has("status") ? " AND status = 'active'" : "";
  const rows = readLocal(`SELECT stock_id FROM stock_meta WHERE type='COMMON' AND market IN ('TSE','OTC')${status}`) as Array<{ stock_id: string }>;
  return new Set(rows.map((row) => row.stock_id).filter(isOrdinaryStockId));
}

async function cloudRiskRows(admin = false): Promise<StoredTradeRisk[]> {
  const client = admin ? supabaseAdmin : supabase;
  if (!client) throw new Error(admin ? "Supabase service role 尚未設定" : "Supabase 尚未設定");
  const rows: StoredTradeRisk[] = [];
  for (let offset = 0; ; offset += 1_000) {
    const { data, error } = await client.from("stock_trade_risk").select("*").order("record_key").range(offset, offset + 999);
    if (error) throw new Error(error.message);
    rows.push(...((data || []) as StoredTradeRisk[]));
    if (!data || data.length < 1_000) break;
  }
  return rows;
}

async function removeObsoleteCloudRows(localKeys: Set<string>): Promise<number> {
  const cloud = await cloudRiskRows(true);
  const obsolete = cloud.map((row) => row.record_key || tradeRiskRecordKey(row)).filter((key) => !localKeys.has(key));
  for (let index = 0; index < obsolete.length; index += 200) {
    const { error } = await supabaseAdmin!.from("stock_trade_risk").delete().in("record_key", obsolete.slice(index, index + 200));
    if (error) throw new Error(`Supabase 過期交易風險刪除失敗: ${error.message}`);
  }
  return obsolete.length;
}

export async function syncTradeRisksToSupabase(): Promise<{ pushed: number; removed: number; active: number; syncedAt: string }> {
  if (!supabaseAdmin) throw new Error("Supabase 寫入需要伺服器端 SUPABASE_SERVICE_ROLE_KEY");
  const allowed = localOrdinaryStockIds();
  const rows = canonicalLocalRows();
  if (rows.some((row) => !allowed.has(row.stock_id))) throw new Error("SQLite 交易風險包含非 active COMMON 普通股，拒絕同步");
  let pushed = 0;
  for (let index = 0; index < rows.length; index += 500) {
    const batch = rows.slice(index, index + 500).map(({ id: _id, record_key: _recordKey, ...row }) => ({
      ...row, record_key: tradeRiskRecordKey(row), is_active: Boolean(row.is_active),
      raw_data: parseRawData(row.raw_data),
    }));
    const { error } = await supabaseAdmin.from("stock_trade_risk").upsert(batch, { onConflict: "record_key" });
    if (error) throw new Error(`Supabase 交易風險同步失敗: ${error.message}`);
    pushed += batch.length;
  }
  const localKeys = new Set(rows.map(tradeRiskRecordKey));
  const removed = await removeObsoleteCloudRows(localKeys);
  const cloud = await cloudRiskRows(true);
  const cloudKeys = new Set(cloud.map((row) => row.record_key || tradeRiskRecordKey(row)));
  if (cloud.length !== rows.length || cloudKeys.size !== localKeys.size || [...localKeys].some((key) => !cloudKeys.has(key))) {
    throw new Error("Supabase 同步後筆數或 record_key 與 SQLite 不一致");
  }
  const today = taipeiDate();
  const active = rows.filter((row) => isTradeRiskActive(row, today)).length;
  const syncedAt = new Date().toISOString();
  const latest = rows.map((row) => row.fetched_at).sort().at(-1) || null;
  const { error } = await supabaseAdmin.from("trade_risk_sync_status").upsert({
    id: true, status: "success", local_total: rows.length, cloud_total: cloud.length,
    active, latest_source_fetched_at: latest, synced_at: syncedAt, attempted_at: syncedAt, error: null,
    summary: { pushed, removed, record_keys: localKeys.size },
  }, { onConflict: "id" });
  if (error) throw new Error(`Supabase 同步狀態寫入失敗: ${error.message}`);
  return { pushed, removed, active, syncedAt };
}

export async function markTradeRiskSyncDegraded(message = "official_source_update_failed"): Promise<void> {
  if (!supabaseAdmin) throw new Error("Supabase 寫入需要伺服器端 SUPABASE_SERVICE_ROLE_KEY");
  const attemptedAt = new Date().toISOString();
  const { data, error: readError } = await supabaseAdmin.from("trade_risk_sync_status").select("*").eq("id", true).maybeSingle();
  if (readError) throw new Error(`Supabase 同步狀態查詢失敗: ${readError.message}`);
  const payload = data
    ? { ...data, status: "degraded", attempted_at: attemptedAt, error: message.slice(0, 500) }
    : { id: true, status: "degraded", local_total: 0, cloud_total: 0, active: 0, synced_at: null,
      latest_source_fetched_at: null, attempted_at: attemptedAt, error: message.slice(0, 500), summary: {} };
  const { error } = await supabaseAdmin.from("trade_risk_sync_status").upsert(payload, { onConflict: "id" });
  if (error) throw new Error(`Supabase degraded 狀態寫入失敗: ${error.message}`);
}

interface RiskSideStatus {
  available: boolean;
  total: number | null;
  active: number | null;
  storedActive: number | null;
  latestFetchedAt: string | null;
  duplicateRecordKeys: number | null;
  ordinaryStockOnly: boolean | null;
}

function summarizeRows(rows: StoredTradeRisk[], allowed: Set<string>, today: string): RiskSideStatus {
  const keys = rows.map((row) => row.record_key || tradeRiskRecordKey(row));
  return {
    available: true, total: rows.length,
    active: rows.filter((row) => isTradeRiskActive(row, today)).length,
    storedActive: rows.filter((row) => Boolean(row.is_active)).length,
    latestFetchedAt: rows.map((row) => row.fetched_at).sort().at(-1) || null,
    duplicateRecordKeys: keys.length - new Set(keys).size,
    ordinaryStockOnly: rows.every((row) => allowed.has(row.stock_id)),
  };
}

async function cloudOrdinaryStockIds(): Promise<Set<string>> {
  if (!supabase) throw new Error("Supabase 尚未設定");
  const result = new Set<string>();
  for (let offset = 0; ; offset += 1_000) {
    const { data, error } = await supabase.from("stock_meta").select("stock_id,status,type,market")
      .eq("status", "active").in("market", ["TSE", "OTC"]).range(offset, offset + 999);
    if (error) throw new Error(error.message);
    for (const row of data || []) {
      if (isEligibleOrdinaryStock(row as StockMetaUniverseRow)) result.add(row.stock_id);
    }
    if (!data || data.length < 1_000) break;
  }
  return result;
}

function unavailableSide(): RiskSideStatus {
  return { available: false, total: null, active: null, storedActive: null, latestFetchedAt: null, duplicateRecordKeys: null, ordinaryStockOnly: null };
}

function cloudFailureKind(message: string): "table_missing" | "query_failed" {
  return /42P01|PGRST205|relation .* does not exist|schema cache/i.test(message) ? "table_missing" : "query_failed";
}

export async function getTradeRiskStatus(_allowLocal = false) {
  if (!supabase && !_allowLocal) throw new Error("Supabase 尚未設定");
  const today = taipeiDate();
  let local = unavailableSide();
  let localRows: StoredTradeRisk[] = [];
  if (_allowLocal) {
    try {
      localRows = canonicalLocalRows();
      local = summarizeRows(localRows, localOrdinaryStockIds(), today);
    } catch { /* reported as unavailable */ }
  }
  let cloud = unavailableSide();
  let cloudRowsForStatus: StoredTradeRisk[] = [];
  let error: string | null = null;
  let unavailableReason: "table_missing" | "query_failed" | null = null;
  let syncState: { status: string; synced_at: string | null; attempted_at: string | null; error: string | null } | null = null;
  try {
    cloudRowsForStatus = await cloudRiskRows();
    cloud = summarizeRows(cloudRowsForStatus, await cloudOrdinaryStockIds(), today);
    const syncResult = await supabase!.from("trade_risk_sync_status")
      .select("status,synced_at,attempted_at,error").eq("id", true).maybeSingle();
    if (syncResult.error) throw new Error(syncResult.error.message);
    syncState = syncResult.data;
  }
  catch (reason) {
    error = reason instanceof Error ? reason.message : String(reason);
    unavailableReason = cloudFailureKind(error);
  }
  if (!_allowLocal && error) throw new Error(`Supabase 交易風險狀態查詢失敗: ${error}`);
  const localKeys = new Set(localRows.map(tradeRiskRecordKey));
  let cloudKeys = new Set<string>();
  if (cloud.available) cloudKeys = new Set(cloudRowsForStatus.map((row) => row.record_key || tradeRiskRecordKey(row)));
  const recordKeysMatch = cloud.available && local.available && localKeys.size === cloudKeys.size && [...localKeys].every((key) => cloudKeys.has(key));
  const countsMatch = cloud.available && local.available && local.total === cloud.total && local.active === cloud.active;
  const stale = cloud.available && isStaleTimestamp(cloud.latestFetchedAt);
  const localComparisonFailed = _allowLocal && local.available && (!countsMatch || !recordKeysMatch);
  const degraded = cloud.available && (syncState?.status !== "success" || localComparisonFailed
    || !cloud.ordinaryStockOnly || cloud.duplicateRecordKeys !== 0 || cloud.active !== cloud.storedActive);
  const status = unavailableReason || (stale ? "stale" : degraded ? "degraded" : cloud.total === 0 ? "empty" : "healthy");
  const localTime = local.latestFetchedAt ? Date.parse(local.latestFetchedAt) : Number.NaN;
  const cloudTime = cloud.latestFetchedAt ? Date.parse(cloud.latestFetchedAt) : Number.NaN;
  return {
    asOf: today, available: cloud.available, status, error,
    total: cloud.total, active: cloud.active, sqlite: local, supabase: cloud, sync: syncState,
    comparison: {
      totalMatch: countsMatch, recordKeysMatch,
      syncLagSeconds: Number.isFinite(localTime) && Number.isFinite(cloudTime) ? Math.round((cloudTime - localTime) / 1000) : null,
    },
    capabilities: TRADE_RISK_CAPABILITIES,
  };
}

export interface TradeRiskPolicyDataset {
  rows: StoredTradeRisk[];
  asOf: string;
  source: "supabase";
}

export interface TradeRiskPolicyResult<T> {
  items: Array<T & { riskFlags: RiskFlag[] }>;
  riskPolicy: "applied" | "disabled";
  riskDataAsOf: string | null;
  riskDataSource: "supabase" | null;
}

type TradeRiskPolicyLoader = () => Promise<TradeRiskPolicyDataset>;

function isStaleTimestamp(value: string | null | undefined): boolean {
  const timestamp = value ? Date.parse(value) : Number.NaN;
  return !Number.isFinite(timestamp) || Date.now() - timestamp > MAX_DATA_AGE_MS;
}

export async function loadTradeRiskPolicyDataset(): Promise<TradeRiskPolicyDataset> {
  if (!supabase) throw new Error("Supabase 尚未設定");
  const { data, error } = await supabase.from("trade_risk_sync_status")
    .select("synced_at,latest_source_fetched_at,status").eq("id", true).maybeSingle();
  if (error) throw new Error(`Supabase 交易風險同步狀態查詢失敗: ${error.message}`);
  if (!data || data.status !== "success") throw new Error("Supabase 交易風險尚未完成成功同步");
  const freshness = data.latest_source_fetched_at || data.synced_at;
  if (isStaleTimestamp(freshness)) throw new Error("Supabase 交易風險資料已過期");
  return { rows: await cloudRows(undefined, undefined, true), asOf: String(freshness).slice(0, 10), source: "supabase" };
}

export async function applyTradeRiskPolicy<T extends { stock_id: string }>(
  items: T[], includeDisposition = false, loader: TradeRiskPolicyLoader = loadTradeRiskPolicyDataset,
): Promise<TradeRiskPolicyResult<T>> {
  if (process.env.TRADE_RISK_FILTER_ENABLED === "false") {
    return { items: items.map((item) => ({ ...item, riskFlags: [] })), riskPolicy: "disabled", riskDataAsOf: null, riskDataSource: null };
  }
  try {
    const dataset = await loader();
    return {
      items: applyTradeRiskPolicyRows(items, dataset.rows, includeDisposition),
      riskPolicy: "applied", riskDataAsOf: dataset.asOf, riskDataSource: dataset.source,
    };
  } catch (error) {
    throw new Error(TRADE_RISK_POLICY_ERROR, { cause: error });
  }
}

export function applyTradeRiskPolicyRows<T extends { stock_id: string }>(
  items: T[], rows: StoredTradeRisk[], includeDisposition = false, today = taipeiDate(),
): Array<T & { riskFlags: RiskFlag[] }> {
  const grouped = new Map<string, RiskFlag[]>();
  for (const row of rows) {
    if (!isTradeRiskActive(row, today)) continue;
    const action = row.risk_type === "trading_halt" || (row.risk_type === "disposition" && !includeDisposition)
      ? "exclude" : "warn";
    grouped.set(row.stock_id, [...(grouped.get(row.stock_id) || []), {
      type: row.risk_type, level: row.risk_level, action, reason: row.reason,
    }]);
  }
  return items.flatMap((item) => {
    const riskFlags = grouped.get(item.stock_id) || [];
    return riskFlags.some((flag) => flag.action === "exclude") ? [] : [{ ...item, riskFlags }];
  });
}

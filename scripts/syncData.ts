import { createSupabaseAdminClient } from "./lib/supabaseAdmin";
import { listPendingCalendarDates } from "./lib/syncDates";
import { isOrdinaryStockId } from "../server/lib/stockUniverse";
import {
  parseTpexInstitutionalRow,
  parseTwseInstitutionalRow,
  type InstitutionalRecord,
} from "../server/lib/institutionalFlow";

const supabase = createSupabaseAdminClient();
const UPSERT_BATCH = 500;
const PRICE_RETENTION = 512;
const INSTITUTIONAL_RETENTION = 512;
const TDCC_RETENTION = 512;
const INITIAL_INSTITUTIONAL_DATES = 60;
const HARD_BUDGET_BYTES = 500 * 1024 * 1024;
const WRITE_CEILING_BYTES = 450 * 1024 * 1024;
const DRY_RUN = process.argv.includes("--dry-run");
const SYNC_SCOPE = process.env.SYNC_SCOPE || "all";

if (!["all", "market"].includes(SYNC_SCOPE)) {
  throw new Error(`Unsupported SYNC_SCOPE: ${SYNC_SCOPE}`);
}

interface MarketTable {
  title?: string;
  data?: unknown[][];
}

interface MarketResponse {
  stat?: string;
  date?: string;
  data?: unknown[][];
  tables?: MarketTable[];
}

interface PriceRecord {
  stock_id: string;
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  amount: number;
  trade_count: number;
  spread: number;
}

interface MetaRecord {
  stock_id: string;
  stock_name: string;
  market: "TSE" | "OTC";
  type: "stock";
  status: "active";
  industry_category?: string | null;
  source: string;
  last_trade_date: string | null;
  updated_at: string;
}

interface FinMindInfoRow {
  stock_id: string;
  stock_name: string;
  industry_category: string;
  type: "twse" | "tpex" | "emerging";
}

interface StorageStatus {
  database_bytes: number;
  public_tables_bytes: number;
  budget_bytes: number;
}

interface RetentionStatus {
  price_dates: number;
  price_min_date: string | null;
}

interface DailyRecords {
  prices: PriceRecord[];
  meta: MetaRecord[];
  institutional: InstitutionalRecord[];
}

interface DividendRecord {
  stock_id: string;
  date: string;
  cash_dividend: number;
  stock_dividend: number;
  source: string;
}

function taipeiToday(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function syncTargetDate(): string {
  const value = process.env.SYNC_TARGET_DATE || taipeiToday();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error("Invalid SYNC_TARGET_DATE");
  const parsed = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new Error("Invalid SYNC_TARGET_DATE");
  }
  return value;
}

function parseNumber(value: unknown): number {
  const parsed = Number.parseFloat(String(value ?? "").replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseSpread(value: unknown): number {
  const text = String(value ?? "");
  const sign = text.includes("green") || text.includes("-") ? -1 : 1;
  return parseNumber(text.replace(/<[^>]*>?/gm, "")) * sign;
}

function compactDate(isoDate: string): string {
  return isoDate.replace(/-/g, "");
}

function rocDate(isoDate: string): string {
  const [year, month, day] = isoDate.split("-");
  return `${Number(year) - 1911}/${month}/${day}`;
}

function normalizeRocDate(value: unknown): string | null {
  const compact = String(value ?? "").replace(/\//g, "");
  if (!/^\d{7}$/.test(compact)) return null;
  const year = Number(compact.slice(0, 3)) + 1911;
  const normalized = `${year}-${compact.slice(3, 5)}-${compact.slice(5, 7)}`;
  const parsed = new Date(`${normalized}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === normalized
    ? normalized
    : null;
}

function makeMeta(
  stockId: string,
  stockName: unknown,
  market: "TSE" | "OTC",
  date: string,
): MetaRecord {
  return {
    stock_id: stockId,
    stock_name: String(stockName ?? "").trim() || stockId,
    market,
    type: "stock",
    status: "active",
    source: market === "TSE" ? "twse" : "tpex",
    last_trade_date: date,
    updated_at: new Date().toISOString(),
  };
}

function parseTwsePrice(row: unknown[], date: string): PriceRecord | null {
  const stockId = String(row[0] ?? "").trim();
  const close = parseNumber(row[8]);
  const volume = Math.min(parseNumber(row[2]), 9_999_999_999);
  if (!isOrdinaryStockId(stockId) || close <= 0 || volume <= 0) return null;
  return {
    stock_id: stockId,
    date,
    open: parseNumber(row[5]),
    high: parseNumber(row[6]),
    low: parseNumber(row[7]),
    close,
    volume,
    amount: Math.min(parseNumber(row[4]), 9_999_999_999),
    trade_count: parseNumber(row[3]),
    spread: parseSpread(`${row[9] ?? ""}${row[10] ?? ""}`),
  };
}

function parseTpexPrice(row: unknown[], date: string): PriceRecord | null {
  const stockId = String(row[0] ?? "").trim();
  const close = parseNumber(row[2]);
  const volume = Math.min(parseNumber(row[7]), 9_999_999_999);
  if (!isOrdinaryStockId(stockId) || close <= 0 || volume <= 0) return null;
  return {
    stock_id: stockId,
    date,
    open: parseNumber(row[4]),
    high: parseNumber(row[5]),
    low: parseNumber(row[6]),
    close,
    volume,
    amount: Math.min(parseNumber(row[8]), 9_999_999_999),
    trade_count: parseNumber(row[9]),
    spread: parseSpread(row[3]),
  };
}

async function fetchJson(url: string): Promise<MarketResponse> {
  const response = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.json() as Promise<MarketResponse>;
}

async function fetchTwsePrice(date: string): Promise<{ prices: PriceRecord[]; meta: MetaRecord[] }> {
  const url = `https://www.twse.com.tw/exchangeReport/MI_INDEX?response=json&date=${compactDate(date)}&type=ALLBUT0999`;
  const response = await fetchJson(url);
  if (response.stat !== "OK") return { prices: [], meta: [] };
  const rows = response.tables?.find((table) => table.title?.includes("行情"))?.data || [];
  return {
    prices: rows.map((row) => parseTwsePrice(row, date)).filter((row): row is PriceRecord => row !== null),
    meta: rows
      .filter((row) => isOrdinaryStockId(String(row[0] ?? "").trim()))
      .map((row) => makeMeta(String(row[0]).trim(), row[1], "TSE", date)),
  };
}

async function fetchTpexPrice(date: string): Promise<{ prices: PriceRecord[]; meta: MetaRecord[] }> {
  const url = `https://www.tpex.org.tw/web/stock/aftertrading/otc_quotes_no1430/stk_wn1430_result.php?l=zh-tw&d=${rocDate(date)}&se=EW`;
  const response = await fetchJson(url);
  const rows = response.tables?.[0]?.data || [];
  return {
    prices: rows.map((row) => parseTpexPrice(row, date)).filter((row): row is PriceRecord => row !== null),
    meta: rows
      .filter((row) => isOrdinaryStockId(String(row[0] ?? "").trim()))
      .map((row) => makeMeta(String(row[0]).trim(), row[1], "OTC", date)),
  };
}

async function fetchTwseInstitutional(date: string): Promise<InstitutionalRecord[]> {
  const url = `https://www.twse.com.tw/fund/T86?response=json&date=${compactDate(date)}&selectType=ALLBUT0999`;
  const response = await fetchJson(url);
  if (response.stat !== "OK") return [];
  return (response.data || [])
    .map((row) => parseTwseInstitutionalRow(row, date))
    .filter((row): row is InstitutionalRecord => row !== null);
}

async function fetchTpexInstitutional(date: string): Promise<InstitutionalRecord[]> {
  const url = `https://www.tpex.org.tw/web/stock/3insti/daily_trade/3itrade_hedge_result.php?l=zh-tw&o=json&d=${rocDate(date)}&se=EW&t=D`;
  const response = await fetchJson(url);
  const rows = response.tables?.[0]?.data || [];
  return rows
    .map((row) => parseTpexInstitutionalRow(row, date))
    .filter((row): row is InstitutionalRecord => row !== null);
}

async function getLatestCloudDate(): Promise<string | null> {
  const { data, error } = await supabase
    .from("stock_price")
    .select("date")
    .order("date", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`Cannot read Supabase latest date: ${error.message}`);
  return data?.date || null;
}

async function getStorageStatus(): Promise<StorageStatus> {
  const { data, error } = await supabase.rpc("cloud_storage_status");
  if (error) throw new Error(`Cannot read Supabase storage status: ${error.message}`);
  const result = Array.isArray(data) ? data[0] : data;
  return {
    database_bytes: Number(result?.database_bytes || 0),
    public_tables_bytes: Number(result?.public_tables_bytes || 0),
    budget_bytes: Number(result?.budget_bytes || HARD_BUDGET_BYTES),
  };
}

async function getRetentionStatus(): Promise<RetentionStatus> {
  const { data, error } = await supabase.rpc("market_retention_status");
  if (error) throw new Error(`Cannot read market retention status: ${error.message}`);
  const result = Array.isArray(data) ? data[0] : data;
  return {
    price_dates: Number(result?.price_dates || 0),
    price_min_date: result?.price_min_date || null,
  };
}

async function upsertRows(table: string, rows: object[]): Promise<void> {
  for (let offset = 0; offset < rows.length; offset += UPSERT_BATCH) {
    const { error } = await supabase
      .from(table)
      .upsert(rows.slice(offset, offset + UPSERT_BATCH), { onConflict: "stock_id,date" });
    if (error) throw new Error(`${table} upsert failed: ${error.message}`);
  }
}

async function upsertMeta(rows: MetaRecord[]): Promise<void> {
  for (let offset = 0; offset < rows.length; offset += UPSERT_BATCH) {
    const { error } = await supabase
      .from("stock_meta")
      .upsert(rows.slice(offset, offset + UPSERT_BATCH), { onConflict: "stock_id" });
    if (error) throw new Error(`stock_meta upsert failed: ${error.message}`);
  }
}

function preferIndustry(current: string | undefined, candidate: string): string {
  if (!current) return candidate;
  const generic = /^(其他|電子工業|一般業|ETF)$/;
  if (generic.test(current) && !generic.test(candidate)) return candidate;
  return candidate.length > current.length ? candidate : current;
}

async function readCloudMeta(): Promise<MetaRecord[]> {
  const rows: MetaRecord[] = [];
  for (let offset = 0; ; offset += 1_000) {
    const { data, error } = await supabase
      .from("stock_meta")
      .select("stock_id,stock_name,market,type,status,industry_category,source,last_trade_date,updated_at")
      .order("stock_id")
      .range(offset, offset + 999);
    if (error) throw new Error(`Cannot read cloud metadata: ${error.message}`);
    rows.push(...((data || []) as MetaRecord[]));
    if (!data || data.length < 1_000) break;
  }
  return rows;
}

async function syncFinMindMetadata(): Promise<number> {
  const query = new URLSearchParams({ dataset: "TaiwanStockInfo" });
  const response = await fetch(`https://api.finmindtrade.com/api/v4/data?${query}`, {
    headers: { "User-Agent": "TWSE-AnyTara/1.0" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`FinMind TaiwanStockInfo HTTP ${response.status}`);
  const payload = await response.json() as {
    status?: number;
    msg?: string;
    data?: FinMindInfoRow[];
  };
  if (payload.status !== 200 || !Array.isArray(payload.data)) {
    throw new Error(`FinMind TaiwanStockInfo: ${payload.msg || "invalid response"}`);
  }
  const industries = new Map<string, string>();
  for (const row of payload.data) {
    if (!isOrdinaryStockId(row.stock_id) || !["twse", "tpex"].includes(row.type)) continue;
    const industry = String(row.industry_category || "").trim();
    if (!industry) continue;
    industries.set(
      row.stock_id,
      preferIndustry(industries.get(row.stock_id), industry),
    );
  }
  const now = new Date().toISOString();
  const updates = (await readCloudMeta())
    .filter((row) => industries.has(row.stock_id) && row.industry_category !== industries.get(row.stock_id))
    .map((row) => ({ ...row, industry_category: industries.get(row.stock_id), updated_at: now }));
  if (!DRY_RUN && updates.length > 0) await upsertMeta(updates);
  console.log(`[Sync] FinMind metadata: ${DRY_RUN ? "validated" : "updated"} ${updates.length} stocks.`);
  return updates.length;
}

async function fetchDailyRecords(date: string): Promise<DailyRecords> {
  const [twsePrice, tpexPrice, twseInstitutional, tpexInstitutional] = await Promise.all([
    fetchTwsePrice(date),
    fetchTpexPrice(date),
    fetchTwseInstitutional(date),
    fetchTpexInstitutional(date),
  ]);
  return {
    prices: [...new Map([...twsePrice.prices, ...tpexPrice.prices].map((row) => [row.stock_id, row])).values()],
    meta: [...new Map([...twsePrice.meta, ...tpexPrice.meta].map((row) => [row.stock_id, row])).values()],
    institutional: [...new Map([...twseInstitutional, ...tpexInstitutional].map((row) => [row.stock_id, row])).values()],
  };
}

async function syncDate(date: string): Promise<DailyRecords> {
  const records = await fetchDailyRecords(date);
  if (records.prices.length === 0) {
    console.log(`[Sync] ${date}: no official market file available; skipped.`);
    return records;
  }
  if (!DRY_RUN) {
    await upsertMeta(records.meta);
    await upsertRows("stock_price", records.prices);
    await upsertRows("stock_institutional", records.institutional);
    const { error } = await supabase
      .from("trading_calendar")
      .upsert({ date, is_open: true, source: "twse_tpex" }, { onConflict: "date" });
    if (error) throw new Error(`trading_calendar upsert failed: ${error.message}`);
  }
  console.log(
    `[Sync] ${date}: ${DRY_RUN ? "validated" : "uploaded"} ` +
    `${records.prices.length} prices, ${records.institutional.length} institutional, ${records.meta.length} meta.`,
  );
  return records;
}

function previousIsoDate(date: string): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() - 1);
  return value.toISOString().slice(0, 10);
}

async function syncPriceDate(date: string): Promise<{ prices: number; meta: number }> {
  const [twse, tpex] = await Promise.all([fetchTwsePrice(date), fetchTpexPrice(date)]);
  const prices = [...new Map([...twse.prices, ...tpex.prices].map((row) => [row.stock_id, row])).values()];
  const meta = [...new Map([...twse.meta, ...tpex.meta].map((row) => [row.stock_id, row])).values()];
  if (prices.length === 0) return { prices: 0, meta: 0 };
  if (!DRY_RUN) {
    await upsertMeta(meta);
    await upsertRows("stock_price", prices);
    const { error } = await supabase
      .from("trading_calendar")
      .upsert({ date, is_open: true, source: "twse_tpex" }, { onConflict: "date" });
    if (error) throw new Error(`trading_calendar upsert failed: ${error.message}`);
  }
  console.log(`[Sync] Price backfill ${date}: ${DRY_RUN ? "validated" : "uploaded"} ${prices.length} rows.`);
  return { prices: prices.length, meta: meta.length };
}

async function backfillPriceHistory(): Promise<{ prices: number; meta: number }> {
  const status = await getRetentionStatus();
  let missingDates = Math.max(0, PRICE_RETENTION - status.price_dates);
  if (missingDates === 0) return { prices: 0, meta: 0 };
  if (!status.price_min_date) throw new Error("Cannot backfill prices without an existing minimum date");
  console.log(`[Sync] Price history has ${status.price_dates} dates; backfilling ${missingDates} to reach 512.`);
  let candidate = previousIsoDate(status.price_min_date);
  let attemptsRemaining = missingDates * 3 + 14;
  const totals = { prices: 0, meta: 0 };
  while (missingDates > 0 && attemptsRemaining > 0) {
    const records = await syncPriceDate(candidate);
    if (records.prices > 0) {
      totals.prices += records.prices;
      totals.meta += records.meta;
      missingDates -= 1;
    }
    candidate = previousIsoDate(candidate);
    attemptsRemaining -= 1;
  }
  if (missingDates > 0) {
    throw new Error(`Price backfill stopped before reaching 512 trading dates; ${missingDates} still missing`);
  }
  return totals;
}

async function enforceRetention(): Promise<number> {
  if (DRY_RUN) return 0;
  const { data, error } = await supabase.rpc("enforce_cloud_retention", {
    price_rows: PRICE_RETENTION,
    institutional_rows: INSTITUTIONAL_RETENTION,
    tdcc_rows: TDCC_RETENTION,
    execute_delete: true,
  });
  if (error) throw new Error(`Retention RPC failed: ${error.message}`);
  const result = Array.isArray(data) ? data[0] : data;
  return Number(result?.deleted_rows || 0);
}

async function getMissingInstitutionalDates(): Promise<string[]> {
  const { data, error } = await supabase.rpc("market_missing_institutional_dates", {
    target_dates: INITIAL_INSTITUTIONAL_DATES,
  });
  if (error) throw new Error(`Cannot find institutional backfill dates: ${error.message}`);
  return (data || []).map((row: { date: string }) => row.date);
}

async function syncInstitutionalDate(date: string): Promise<number> {
  const [twse, tpex] = await Promise.all([
    fetchTwseInstitutional(date),
    fetchTpexInstitutional(date),
  ]);
  const records = [...new Map([...twse, ...tpex].map((row) => [row.stock_id, row])).values()];
  if (records.length === 0) {
    console.log(`[Sync] Institutional ${date}: no official market file available; skipped.`);
    return 0;
  }
  if (!DRY_RUN) await upsertRows("stock_institutional", records);
  console.log(
    `[Sync] Institutional ${date}: ${DRY_RUN ? "validated" : "uploaded"} ${records.length} rows.`,
  );
  return records.length;
}

async function backfillInstitutionalHistory(): Promise<number> {
  const dates = await getMissingInstitutionalDates();
  if (dates.length === 0) return 0;
  console.log(`[Sync] Backfilling ${dates.length} institutional trading dates (target ${INITIAL_INSTITUTIONAL_DATES}).`);
  let uploaded = 0;
  for (let index = 0; index < dates.length; index += 1) {
    if (!DRY_RUN && index % 5 === 0) {
      const storage = await getStorageStatus();
      if (storage.database_bytes >= WRITE_CEILING_BYTES) {
        throw new Error("Supabase reached the 450 MiB write ceiling during institutional backfill");
      }
    }
    uploaded += await syncInstitutionalDate(dates[index]);
  }
  return uploaded;
}

async function fetchTwseDividends(): Promise<DividendRecord[]> {
  const response = await fetch("https://openapi.twse.com.tw/v1/exchangeReport/TWT48U_ALL", {
    headers: { "User-Agent": "Mozilla/5.0" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`TWSE dividends: ${response.status}`);
  const rows = await response.json() as Array<Record<string, unknown>>;
  return rows.flatMap((row) => {
    const stockId = String(row.Code ?? "").trim();
    const date = normalizeRocDate(row.Date);
    if (!isOrdinaryStockId(stockId) || !date) return [];
    return [{
      stock_id: stockId,
      date,
      cash_dividend: parseNumber(row.CashDividend),
      stock_dividend: parseNumber(row.StockDividendRatio),
      source: "twse_openapi",
    }];
  });
}

async function fetchTpexDividends(): Promise<DividendRecord[]> {
  const response = await fetch("https://www.tpex.org.tw/www/zh-tw/bulletin/prePost", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "Mozilla/5.0",
    },
    body: "",
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`TPEX dividends: ${response.status}`);
  const payload = await response.json() as MarketResponse;
  const rows = payload.tables?.[0]?.data || [];
  return rows.flatMap((row) => {
    const stockId = String(row[1] ?? "").trim();
    const date = normalizeRocDate(row[0]);
    if (!isOrdinaryStockId(stockId) || !date) return [];
    return [{
      stock_id: stockId,
      date,
      cash_dividend: parseNumber(row[7]),
      stock_dividend: parseNumber(row[4]),
      source: "tpex",
    }];
  });
}

async function syncDividendsCloud(): Promise<number> {
  const [twse, tpex] = await Promise.all([fetchTwseDividends(), fetchTpexDividends()]);
  const records = [...new Map([...twse, ...tpex].map((row) => [`${row.stock_id}:${row.date}`, row])).values()];
  if (!DRY_RUN) await upsertRows("dividend_events", records);
  console.log(`[Sync] Dividends: ${DRY_RUN ? "validated" : "uploaded"} ${records.length} rows.`);
  return records.length;
}

async function createSyncRun(): Promise<number | null> {
  if (DRY_RUN) return null;
  const { data, error } = await supabase
    .from("sync_runs")
    .insert({ status: "running" })
    .select("id")
    .single();
  if (error) throw new Error(`Cannot create sync run: ${error.message}`);
  return Number(data.id);
}

async function finishSyncRun(
  id: number | null,
  status: "success" | "failed",
  totals: { prices: number; institutional: number; meta: number },
  message: string,
): Promise<void> {
  if (id === null) return;
  let storage: StorageStatus | null = null;
  try {
    storage = await getStorageStatus();
  } catch {
    // Preserve the original sync result even if the diagnostic RPC is unavailable.
  }
  await supabase.from("sync_runs").update({
    status,
    finished_at: new Date().toISOString(),
    latest_market_date: await getLatestCloudDate(),
    price_rows: totals.prices,
    institutional_rows: totals.institutional,
    meta_rows: totals.meta,
    database_bytes: storage?.database_bytes ?? null,
    message: message.slice(0, 1000),
  }).eq("id", id);
}

async function prepareCloudWrite(): Promise<void> {
  if (DRY_RUN) return;
  const deletedRows = await enforceRetention();
  const storage = await getStorageStatus();
  console.log(
    `[Sync] Pre-sync retention deleted ${deletedRows} rows; database size ` +
    `${(storage.database_bytes / 1024 / 1024).toFixed(1)} MiB.`,
  );
  if (storage.database_bytes >= WRITE_CEILING_BYTES) {
    throw new Error("Supabase is at or above the 450 MiB write ceiling; prune before uploading");
  }
}

async function verifyCloudBudget(): Promise<number> {
  const deletedRows = await enforceRetention();
  if (DRY_RUN) return deletedRows;
  const storage = await getStorageStatus();
  if (storage.database_bytes >= HARD_BUDGET_BYTES) {
    throw new Error(`Supabase exceeded 500 MiB after retention: ${storage.database_bytes} bytes`);
  }
  console.log(
    `[Sync] Retention deleted ${deletedRows} rows; database size ` +
    `${(storage.database_bytes / 1024 / 1024).toFixed(1)} MiB.`,
  );
  return deletedRows;
}

async function syncMarketScope(
  totals: { prices: number; institutional: number; meta: number },
): Promise<void> {
  const latestBefore = await getLatestCloudDate();
  const maxDays = Number.parseInt(process.env.SUPABASE_SYNC_MAX_DAYS || "14", 10);
  const dates = listPendingCalendarDates(latestBefore, syncTargetDate(), maxDays);
  console.log(`[Sync] Supabase latest date before sync: ${latestBefore || "none"}`);
  for (const date of dates) {
    const records = await syncDate(date);
    totals.prices += records.prices.length;
    totals.institutional += records.institutional.length;
    totals.meta += records.meta.length;
  }
  const priceBackfill = await backfillPriceHistory();
  totals.prices += priceBackfill.prices;
  totals.meta += priceBackfill.meta;
  totals.meta += await syncFinMindMetadata();
  totals.institutional += await backfillInstitutionalHistory();
  await syncDividendsCloud();
}

async function run(): Promise<void> {
  await prepareCloudWrite();
  const runId = await createSyncRun();
  const totals = { prices: 0, institutional: 0, meta: 0 };
  try {
    await syncMarketScope(totals);
    await verifyCloudBudget();
    await finishSyncRun(runId, "success", totals, `Cloud ${SYNC_SCOPE} sync completed`);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    await finishSyncRun(runId, "failed", totals, message);
    throw error;
  }
  const latestAfter = await getLatestCloudDate();
  console.log(
    `[Sync] ${SYNC_SCOPE} ${DRY_RUN ? "validated" : "uploaded"} ${totals.prices} prices and ` +
    `${totals.institutional} institutional rows; latest date ${latestAfter || "none"}.`,
  );
}

run().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[Sync] Failed: ${message}`);
  process.exitCode = 1;
});

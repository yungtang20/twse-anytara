import { createSupabaseAdminClient } from "./lib/supabaseAdmin";
import { listPendingCalendarDates } from "./lib/syncDates";
import { downloadTdccCSV, parseTdccCSV } from "../server/lib/tdccDownload";

const supabase = createSupabaseAdminClient();
const UPSERT_BATCH = 500;
const PRICE_RETENTION = 512;
const INSTITUTIONAL_RETENTION = 90;
const TDCC_RETENTION = 104;
const HARD_BUDGET_BYTES = 500 * 1024 * 1024;
const WRITE_CEILING_BYTES = 450 * 1024 * 1024;
const DRY_RUN = process.argv.includes("--dry-run");

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
  source: string;
  last_trade_date: string;
  updated_at: string;
}

interface InstitutionalRecord {
  stock_id: string;
  date: string;
  foreign_net: number;
  trust_net: number;
  dealer_net: number;
  foreign_buy: number;
  foreign_sell: number;
  trust_buy: number;
  trust_sell: number;
  dealer_buy: number;
  dealer_sell: number;
  institutional_net: number;
  source: string;
}

interface StorageStatus {
  database_bytes: number;
  public_tables_bytes: number;
  budget_bytes: number;
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

function isCommonStock(stockId: string): boolean {
  return /^\d{4}$/.test(stockId);
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
  if (!isCommonStock(stockId) || close <= 0 || volume <= 0) return null;
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
  if (!isCommonStock(stockId) || close <= 0 || volume <= 0) return null;
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

function parseTwseInstitutional(row: unknown[], date: string): InstitutionalRecord | null {
  const stockId = String(row[0] ?? "").trim();
  if (!isCommonStock(stockId)) return null;
  const foreignBuy = parseNumber(row[2]);
  const foreignSell = parseNumber(row[3]);
  const trustBuy = parseNumber(row[8]);
  const trustSell = parseNumber(row[9]);
  const dealerBuy = parseNumber(row[12]) + parseNumber(row[15]);
  const dealerSell = parseNumber(row[13]) + parseNumber(row[16]);
  return {
    stock_id: stockId,
    date,
    foreign_net: foreignBuy - foreignSell,
    trust_net: trustBuy - trustSell,
    dealer_net: dealerBuy - dealerSell,
    foreign_buy: foreignBuy,
    foreign_sell: foreignSell,
    trust_buy: trustBuy,
    trust_sell: trustSell,
    dealer_buy: dealerBuy,
    dealer_sell: dealerSell,
    institutional_net: parseNumber(row[18]),
    source: "twse",
  };
}

function parseTpexInstitutional(row: unknown[], date: string): InstitutionalRecord | null {
  const stockId = String(row[0] ?? "").trim();
  if (!isCommonStock(stockId)) return null;
  const foreignBuy = parseNumber(row[8]);
  const foreignSell = parseNumber(row[9]);
  const trustBuy = parseNumber(row[11]);
  const trustSell = parseNumber(row[12]);
  const dealerBuy = parseNumber(row[20]);
  const dealerSell = parseNumber(row[21]);
  return {
    stock_id: stockId,
    date,
    foreign_net: parseNumber(row[10]),
    trust_net: parseNumber(row[13]),
    dealer_net: parseNumber(row[22]),
    foreign_buy: foreignBuy,
    foreign_sell: foreignSell,
    trust_buy: trustBuy,
    trust_sell: trustSell,
    dealer_buy: dealerBuy,
    dealer_sell: dealerSell,
    institutional_net: parseNumber(row[24]),
    source: "tpex",
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
      .filter((row) => isCommonStock(String(row[0] ?? "").trim()))
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
      .filter((row) => isCommonStock(String(row[0] ?? "").trim()))
      .map((row) => makeMeta(String(row[0]).trim(), row[1], "OTC", date)),
  };
}

async function fetchTwseInstitutional(date: string): Promise<InstitutionalRecord[]> {
  const url = `https://www.twse.com.tw/fund/T86?response=json&date=${compactDate(date)}&selectType=ALLBUT0999`;
  const response = await fetchJson(url);
  if (response.stat !== "OK") return [];
  return (response.data || [])
    .map((row) => parseTwseInstitutional(row, date))
    .filter((row): row is InstitutionalRecord => row !== null);
}

async function fetchTpexInstitutional(date: string): Promise<InstitutionalRecord[]> {
  const url = `https://www.tpex.org.tw/web/stock/3insti/daily_trade/3itrade_hedge_result.php?l=zh-tw&o=json&d=${rocDate(date)}&se=EW&t=D`;
  const response = await fetchJson(url);
  const rows = response.tables?.[0]?.data || [];
  return rows
    .map((row) => parseTpexInstitutional(row, date))
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

async function syncTdccCloud(): Promise<number> {
  const { records, date } = parseTdccCSV(await downloadTdccCSV());
  if (!date || records.length === 0) throw new Error("TDCC open-data file contained no usable records");
  if (!DRY_RUN) {
    await upsertRows("tdcc_shareholding", records.map((record) => ({
      ...record,
      source: "tdcc_opendata",
    })));
  }
  console.log(`[Sync] TDCC ${date}: ${DRY_RUN ? "validated" : "uploaded"} ${records.length} rows.`);
  return records.length;
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
    if (!isCommonStock(stockId) || !date) return [];
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
    if (!isCommonStock(stockId) || !date) return [];
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

async function run(): Promise<void> {
  const latestBefore = await getLatestCloudDate();
  const maxDays = Number.parseInt(process.env.SUPABASE_SYNC_MAX_DAYS || "14", 10);
  const dates = listPendingCalendarDates(latestBefore, taipeiToday(), maxDays);
  console.log(`[Sync] Supabase latest date before sync: ${latestBefore || "none"}`);

  if (!DRY_RUN) {
    const before = await getStorageStatus();
    console.log(`[Sync] Database size before sync: ${(before.database_bytes / 1024 / 1024).toFixed(1)} MiB.`);
    if (before.database_bytes >= WRITE_CEILING_BYTES) {
      throw new Error("Supabase is at or above the 450 MiB write ceiling; prune before uploading");
    }
  }

  const runId = await createSyncRun();
  const totals = { prices: 0, institutional: 0, meta: 0 };
  try {
    for (const date of dates) {
      const records = await syncDate(date);
      totals.prices += records.prices.length;
      totals.institutional += records.institutional.length;
      totals.meta += records.meta.length;
    }
    await syncTdccCloud();
    await syncDividendsCloud();
    const deletedRows = await enforceRetention();
    if (!DRY_RUN) {
      const after = await getStorageStatus();
      if (after.database_bytes >= HARD_BUDGET_BYTES) {
        throw new Error(`Supabase exceeded 500 MiB after retention: ${after.database_bytes} bytes`);
      }
      console.log(
        `[Sync] Retention deleted ${deletedRows} rows; database size ` +
        `${(after.database_bytes / 1024 / 1024).toFixed(1)} MiB.`,
      );
    }
    await finishSyncRun(runId, "success", totals, "Official TWSE/TPEX cloud sync completed");
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    await finishSyncRun(runId, "failed", totals, message);
    throw error;
  }

  const latestAfter = await getLatestCloudDate();
  console.log(
    `[Sync] ${DRY_RUN ? "Validated" : "Uploaded"} ${totals.prices} prices and ` +
    `${totals.institutional} institutional rows; latest date ${latestAfter || "none"}.`,
  );
}

run().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[Sync] Failed: ${message}`);
  process.exitCode = 1;
});

import { createSupabaseAdminClient } from "./lib/supabaseAdmin";
import { parseTpexInstitutionalRow, type InstitutionalRecord } from "../server/lib/institutionalFlow";

const supabase = createSupabaseAdminClient();
const BATCH_SIZE = 500;
const TARGET_TRADING_DAYS = 61;

function rocDate(date: string): string {
  const [year, month, day] = date.split("-").map(Number);
  return `${year - 1911}/${String(month).padStart(2, "0")}/${String(day).padStart(2, "0")}`;
}

async function latestTradingDates(): Promise<string[]> {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei" }).format(new Date());
  const { data, error } = await supabase
    .from("trading_calendar")
    .select("date")
    .eq("is_open", true)
    .lte("date", today)
    .order("date", { ascending: false })
    .limit(TARGET_TRADING_DAYS);
  if (error) throw new Error(`Cannot read trading calendar: ${error.message}`);
  const dates = (data || []).map((row) => String(row.date));
  if (dates.length !== TARGET_TRADING_DAYS) {
    throw new Error(`Expected ${TARGET_TRADING_DAYS} trading dates, received ${dates.length}`);
  }
  return dates;
}

async function fetchTpexDate(date: string): Promise<InstitutionalRecord[]> {
  const query = new URLSearchParams({ l: "zh-tw", o: "json", d: rocDate(date), se: "EW", t: "D" });
  const response = await fetch(
    `https://www.tpex.org.tw/web/stock/3insti/daily_trade/3itrade_hedge_result.php?${query}`,
    { headers: { "User-Agent": "TWSE-AnyTara/1.0" }, signal: AbortSignal.timeout(30_000) },
  );
  if (!response.ok) throw new Error(`TPEx ${date} HTTP ${response.status}`);
  const payload = await response.json() as { tables?: Array<{ data?: unknown[][] }> };
  const rows = payload.tables?.[0]?.data || [];
  const parsed = rows
    .map((row) => parseTpexInstitutionalRow(row, date))
    .filter((row): row is InstitutionalRecord => row !== null);
  if (parsed.length === 0) throw new Error(`TPEx ${date} returned no ordinary-stock institutional rows`);
  return parsed;
}

async function upsertOfficialRows(rows: InstitutionalRecord[]): Promise<void> {
  for (let offset = 0; offset < rows.length; offset += BATCH_SIZE) {
    const { error } = await supabase
      .from("stock_institutional")
      .upsert(rows.slice(offset, offset + BATCH_SIZE), { onConflict: "stock_id,date" });
    if (error) throw new Error(`TPEx institutional upsert failed: ${error.message}`);
  }
}

async function readAllRows(table: "stock_meta" | "stock_institutional", columns: string) {
  const rows: Record<string, unknown>[] = [];
  for (let offset = 0; ; offset += 1_000) {
    const { data, error } = await supabase.from(table).select(columns).range(offset, offset + 999);
    if (error) throw new Error(`Cannot validate ${table}: ${error.message}`);
    rows.push(...((data || []) as unknown as Record<string, unknown>[]));
    if (!data || data.length < 1_000) break;
  }
  return rows;
}

async function readInstitutionalRange(startDate: string, endDate: string) {
  const rows: Record<string, unknown>[] = [];
  for (let offset = 0; ; offset += 1_000) {
    const { data, error } = await supabase
      .from("stock_institutional")
      .select("stock_id,date,foreign_net,trust_net,dealer_net,institutional_net")
      .gte("date", startDate)
      .lte("date", endDate)
      .order("date")
      .order("stock_id")
      .range(offset, offset + 999);
    if (error) throw new Error(`Cannot validate stock_institutional: ${error.message}`);
    rows.push(...((data || []) as Record<string, unknown>[]));
    if (!data || data.length < 1_000) break;
  }
  return rows;
}

async function validationCounts(dates: string[]) {
  const [metaRows, allInstitutional] = await Promise.all([
    readAllRows("stock_meta", "stock_id,market"),
    readInstitutionalRange([...dates].sort()[0], [...dates].sort().at(-1)!),
  ]);
  const markets = new Map(metaRows.map((row) => [String(row.stock_id), String(row.market)]));
  const targetDates = new Set(dates);
  const errors = { TSE: 0, OTC: 0 };
  for (const row of allInstitutional) {
    if (!targetDates.has(String(row.date))) continue;
    const market = markets.get(String(row.stock_id));
    if (market !== "TSE" && market !== "OTC") continue;
    const expected = Number(row.foreign_net || 0) + Number(row.trust_net || 0) + Number(row.dealer_net || 0);
    if (Number(row.institutional_net || 0) !== expected) errors[market] += 1;
  }
  return errors;
}

async function run() {
  const dates = await latestTradingDates();
  let uploaded = 0;
  for (const [index, date] of [...dates].reverse().entries()) {
    const rows = await fetchTpexDate(date);
    await upsertOfficialRows(rows);
    uploaded += rows.length;
    console.log(`[TPEx] ${index + 1}/${dates.length} ${date}: ${rows.length} rows`);
  }
  const errors = await validationCounts(dates);
  console.log(JSON.stringify({ tradingDays: dates.length, uploaded, totalMismatchErrors: errors }));
  if (errors.TSE !== 0 || errors.OTC !== 0) {
    throw new Error(`Institutional total validation failed: TSE=${errors.TSE}, OTC=${errors.OTC}`);
  }
}

run().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

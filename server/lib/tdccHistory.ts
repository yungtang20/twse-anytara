import { supabaseAdmin } from "./runtimeState";
import type { TdccRecord } from "./tdccDownload";
import { isOrdinaryStockId } from "./stockUniverse";

const TDCC_HISTORY_URL = "https://www.tdcc.com.tw/portal/zh/smWeb/qryStock";
const USER_AGENT = "Mozilla/5.0 (compatible; TWSE-AnyTara/1.0; +local-data-sync)";

interface TdccSession {
  cookie: string;
  token: string;
  dates: string[];
}

export interface TdccHistoryResult {
  stockId: string;
  availableWeeks: number;
  requestedWeeks: number;
  insertedWeeks: number;
  skippedWeeks: number;
}

export interface TdccHistoryOptions {
  maxWeeks?: number;
  requestDelayMs?: number;
}

function hiddenValue(html: string, name: string): string {
  const pattern = new RegExp(`name=["']${name}["'][^>]+value=["']([^"']+)`, "i");
  return html.match(pattern)?.[1] || "";
}

function availableDates(html: string): string[] {
  return [...new Set(
    [...html.matchAll(/<option[^>]+value=["'](\d{8})["']/gi)].map((match) => match[1]),
  )];
}

function isoDate(compact: string): string {
  return `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}`;
}

function parseInteger(value: string): number {
  const parsed = Number(value.replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function tableRows(html: string): string[][] {
  return [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map((row) =>
    [...row[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((cell) =>
      cell[1]
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/g, " ")
        .replace(/\s+/g, " ")
        .trim(),
    ),
  );
}

function parseHistoryRecord(html: string, stockId: string, date: string): TdccRecord | null {
  const rows = tableRows(html).filter((row) => /^\d+$/.test(row[0] || ""));
  const totalShares = parseInteger(rows.find((row) => row[1]?.includes("合"))?.[3] || "0");
  const whaleShares = parseInteger(rows.find((row) => row[0] === "15")?.[3] || "0");
  const retailShares = rows
    .filter((row) => Number(row[0]) >= 1 && Number(row[0]) <= 6)
    .reduce((sum, row) => sum + parseInteger(row[3] || "0"), 0);
  if (totalShares <= 0 || whaleShares > totalShares || retailShares > totalShares) return null;
  return {
    stock_id: stockId,
    date: isoDate(date),
    total_shares: totalShares,
    whale_ratio: Math.round((whaleShares / totalShares) * 10_000) / 100,
    retail_ratio: Math.round((retailShares / totalShares) * 10_000) / 100,
  };
}

async function openSession(): Promise<TdccSession> {
  const response = await fetch(TDCC_HISTORY_URL, {
    headers: { "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`TDCC history page HTTP ${response.status}`);
  const html = await response.text();
  const token = hiddenValue(html, "SYNCHRONIZER_TOKEN");
  if (!token) throw new Error("TDCC history page did not provide a synchronizer token");
  return {
    cookie: response.headers.get("set-cookie")?.split(";")[0] || "",
    token,
    dates: availableDates(html),
  };
}

async function fetchHistoryWeek(
  session: TdccSession,
  stockId: string,
  date: string,
): Promise<TdccRecord | null> {
  const body = new URLSearchParams({
    SYNCHRONIZER_TOKEN: session.token,
    SYNCHRONIZER_URI: "/portal/zh/smWeb/qryStock",
    method: "submit",
    firDate: date,
    scaDate: date,
    sqlMethod: "StockNo",
    stockNo: stockId,
    stockName: "",
  });
  const response = await fetch(TDCC_HISTORY_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: session.cookie,
      Referer: TDCC_HISTORY_URL,
      "User-Agent": USER_AGENT,
    },
    body,
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`TDCC history query HTTP ${response.status}`);
  const html = await response.text();
  session.token = hiddenValue(html, "SYNCHRONIZER_TOKEN");
  if (!session.token) throw new Error("TDCC history session token expired");
  return parseHistoryRecord(html, stockId, date);
}

export async function backfillTdccHistory(
  stockId: string,
  options: number | TdccHistoryOptions = 52,
): Promise<TdccHistoryResult> {
  if (!isOrdinaryStockId(stockId)) throw new Error("TDCC history only supports ordinary stocks");
  if (!supabaseAdmin) throw new Error("Supabase service role is not configured");
  const maxWeeks = typeof options === "number" ? options : options.maxWeeks ?? 52;
  const requestDelayMs = typeof options === "number" ? 500 : options.requestDelayMs ?? 500;
  const session = await openSession();
  const dates = session.dates.slice(0, Math.min(Math.max(maxWeeks, 1), 52));
  const { data: existing, error } = await supabaseAdmin
    .from("tdcc_shareholding")
    .select("date")
    .eq("stock_id", stockId)
    .in("date", dates.map(isoDate));
  if (error) throw new Error(`Cannot read TDCC cloud history: ${error.message}`);
  const existingDates = new Set((existing || []).map((row) => row.date));
  const missingDates = dates.filter((date) => !existingDates.has(isoDate(date)));
  let insertedWeeks = 0;
  for (const date of missingDates) {
    const record = await fetchHistoryWeek(session, stockId, date);
    if (record) {
      const { error: upsertError } = await supabaseAdmin
        .from("tdcc_shareholding")
        .upsert({ ...record, source: "tdcc_history_web" }, {
          onConflict: "stock_id,date",
        });
      if (upsertError) throw new Error(`TDCC history upsert failed: ${upsertError.message}`);
      insertedWeeks += 1;
    }
    if (requestDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, requestDelayMs));
    }
  }
  return {
    stockId,
    availableWeeks: session.dates.length,
    requestedWeeks: dates.length,
    insertedWeeks,
    skippedWeeks: dates.length - missingDates.length,
  };
}

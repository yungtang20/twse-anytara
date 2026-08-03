import {
  calcTwseLimit,
  fetchFollowRedirects,
  parseNum,
  parseTwseUpDown,
} from "./marketParsers";

type Market = "TWSE" | "TPEX";

interface RealtimeIndex {
  success?: true;
  index: number;
  change: number;
  changePercent: number;
  date: string;
}

interface MarketBreadth {
  limitUp: number;
  up: number;
  flat: number;
  down: number;
  limitDown: number;
}

export interface MarketStats extends RealtimeIndex, MarketBreadth {
  success: true;
  amount: number;
}

interface MarketSupplement extends MarketBreadth {
  amount: number;
}

interface EnrichmentDependencies {
  fetchJson?: (url: string) => Promise<unknown>;
  loadFallback?: () => MarketSupplement | null;
}

const emptySupplement = (): MarketSupplement => ({
  amount: 0,
  limitUp: 0,
  up: 0,
  flat: 0,
  down: 0,
  limitDown: 0,
});

export async function enrichRealtimeMarketStats(
  market: Market,
  realtime: RealtimeIndex,
  dependencies: EnrichmentDependencies = {},
): Promise<MarketStats> {
  const fetchJson = dependencies.fetchJson ?? fetchOfficialJson;
  const official = await loadOfficialSupplement(market, realtime.date, fetchJson);
  const supplement = official ?? dependencies.loadFallback?.() ?? emptySupplement();
  return { ...realtime, success: true, ...supplement };
}

async function loadOfficialSupplement(
  market: Market,
  date: string,
  fetchJson: (url: string) => Promise<unknown>,
): Promise<MarketSupplement | null> {
  try {
    return market === "TWSE"
      ? await loadTwseSupplement(date, fetchJson)
      : await loadTpexSupplement(date, fetchJson);
  } catch {
    return null;
  }
}

async function loadTwseSupplement(
  date: string,
  fetchJson: (url: string) => Promise<unknown>,
): Promise<MarketSupplement | null> {
  const compactDate = date.replaceAll("-", "");
  const [indexJson, amountJson] = await Promise.all([
    fetchJson(`https://www.twse.com.tw/exchangeReport/MI_INDEX?response=json&date=${compactDate}&type=ALLBUT0999`),
    fetchJson(`https://www.twse.com.tw/exchangeReport/FMTQIK?response=json&date=${compactDate}`),
  ]);
  const breadth = parseTwseUpDown(indexJson);
  const amount = parseTwseAmount(amountJson, date);
  return breadth && amount !== null ? { amount, ...breadth } : null;
}

async function loadTpexSupplement(
  date: string,
  fetchJson: (url: string) => Promise<unknown>,
): Promise<MarketSupplement | null> {
  const rocDate = toRocDate(date);
  const [indexJson, quotesJson] = await Promise.all([
    fetchJson(`https://www.tpex.org.tw/web/stock/aftertrading/daily_trading_index/st41_result.php?l=zh-tw&d=${rocDate}`),
    fetchJson(`https://www.tpex.org.tw/web/stock/aftertrading/otc_quotes_no1430/stk_wn1430_result.php?l=zh-tw&d=${rocDate}&se=EW&s=0,asc,0`),
  ]);
  const amount = parseTpexAmount(indexJson, rocDate);
  const breadth = parseTpexQuotes(quotesJson);
  return breadth && amount !== null ? { amount, ...breadth } : null;
}

function parseTwseAmount(value: unknown, date: string): number | null {
  const rows = getRows(value, "data");
  const rocDate = toRocDate(date);
  const row = rows.find((item) => item[0] === rocDate) ?? rows.at(-1);
  return row?.[2] == null ? null : Number((parseNum(row[2]) / 100_000_000).toFixed(2));
}

function parseTpexAmount(value: unknown, rocDate: string): number | null {
  const rows = getTableRows(value);
  const row = rows.find((item) => item[0] === rocDate) ?? rows.at(-1);
  return row?.[2] == null ? null : Number((parseNum(row[2]) / 100_000).toFixed(2));
}

function parseTpexQuotes(value: unknown): MarketBreadth | null {
  const rows = getTableRows(value);
  if (rows.length === 0) return null;
  const counts = emptySupplement();
  for (const row of rows) countTpexQuote(row, counts);
  const { amount: _amount, ...breadth } = counts;
  return breadth;
}

function countTpexQuote(row: unknown[], counts: MarketBreadth): void {
  const id = String(row[0] ?? "");
  if (!/^[1-9]\d{3}$/.test(id)) return;
  const close = parseNum(row[2]);
  const change = parseNum(row[3]);
  if (close <= 0) return;
  if (change === 0) { counts.flat++; return; }
  const previous = close - change;
  const limits = calcTwseLimit(previous);
  if (change > 0) counts[close >= limits.up - 0.005 ? "limitUp" : "up"]++;
  else counts[close <= limits.down + 0.005 ? "limitDown" : "down"]++;
}

function getRows(value: unknown, key: string): unknown[][] {
  if (!value || typeof value !== "object") return [];
  const rows = (value as Record<string, unknown>)[key];
  return Array.isArray(rows) ? rows.filter(Array.isArray) : [];
}

function getTableRows(value: unknown): unknown[][] {
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  if (Array.isArray(record.aaData)) return record.aaData.filter(Array.isArray);
  if (!Array.isArray(record.tables)) return [];
  const table = record.tables[0];
  return getRows(table, "data");
}

function toRocDate(date: string): string {
  const [year, month, day] = date.split("-");
  return `${Number(year) - 1911}/${month}/${day}`;
}

async function fetchOfficialJson(url: string): Promise<unknown> {
  const response = url.includes("tpex.org.tw")
    ? await fetchFollowRedirects(url)
    : await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`market_supplement_http_${response.status}`);
  return response.json();
}

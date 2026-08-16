import { supabase } from "./runtimeState";

export interface CloudPriceRow {
  stock_id: string;
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  amount?: number | null;
}

export interface CloudInstitutionalRow {
  stock_id: string;
  date: string;
  foreign_net: number;
  trust_net: number;
  dealer_net: number;
  institutional_net: number;
}

export interface CloudShareholdingRow {
  stock_id: string;
  date: string;
  source?: string | null;
  total_shares: number;
  whale_ratio: number;
  // retail_ratio uses TDCC levels 1-6 (holding <= 30,000 shares). Sources that
  // cannot supply that exact bracket (e.g. goodinfo_tdcc_bootstrap) store NULL.
  retail_ratio: number | null;
  total_people: number | null;
  whale_shares: number | null;
  whale_people: number | null;
  updated_at?: string | null;
}

export interface CloudMetaRow {
  stock_id: string;
  stock_name: string;
  market: string;
  industry_category: string | null;
  status: string;
  type: string;
}

function client() {
  if (!supabase) throw new Error("Supabase is not configured");
  return supabase;
}

function boundedStockIds(stockIds: string[]): string[] {
  const unique = [...new Set(stockIds.filter((stockId) => /^\d{4,6}$/.test(stockId)))];
  if (unique.length > 250) throw new RangeError("A bulk cloud history request supports at most 250 stock IDs");
  return unique;
}

export function normalizeCloudHistoryLimit(value: number, maximum: number): number {
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw new RangeError(`history limit must be an integer between 1 and ${maximum}`);
  }
  return value;
}

function decodeHistoryMap<T>(
  payload: unknown,
  field: "prices" | "rows",
): Map<string, T[]> {
  const result = new Map<string, T[]>();
  if (!Array.isArray(payload)) throw new Error("Supabase bulk history response is not an array");
  for (const entry of payload) {
    if (!entry || typeof entry !== "object") throw new Error("Supabase bulk history entry is invalid");
    const record = entry as Record<string, unknown>;
    if (typeof record.stock_id !== "string" || !Array.isArray(record[field])) {
      throw new Error("Supabase bulk history entry has an invalid contract");
    }
    result.set(record.stock_id, record[field] as T[]);
  }
  return result;
}

export async function fetchCloudPriceHistories(
  stockIds: string[],
  limit = 512,
): Promise<Map<string, CloudPriceRow[]>> {
  const ids = boundedStockIds(stockIds);
  if (ids.length === 0) return new Map();
  const historyLimit = normalizeCloudHistoryLimit(limit, 512);
  const { data, error } = await client().rpc("stock_price_histories", {
    stock_ids: ids,
    history_limit: historyLimit,
  });
  if (error) throw new Error(error.message);
  return decodeHistoryMap<CloudPriceRow>(data, "prices");
}

export async function fetchCloudInstitutionalHistories(
  stockIds: string[],
  limit = 30,
): Promise<Map<string, CloudInstitutionalRow[]>> {
  const ids = boundedStockIds(stockIds);
  if (ids.length === 0) return new Map();
  const historyLimit = normalizeCloudHistoryLimit(limit, 120);
  const { data, error } = await client().rpc("stock_institutional_histories", {
    stock_ids: ids,
    history_limit: historyLimit,
  });
  if (error) throw new Error(error.message);
  return decodeHistoryMap<CloudInstitutionalRow>(data, "rows");
}

export async function fetchCloudShareholdingHistories(
  stockIds: string[],
  limit = 12,
): Promise<Map<string, CloudShareholdingRow[]>> {
  const ids = boundedStockIds(stockIds);
  if (ids.length === 0) return new Map();
  const historyLimit = normalizeCloudHistoryLimit(limit, 52);
  const { data, error } = await client().rpc("tdcc_shareholding_histories", {
    stock_ids: ids,
    history_limit: historyLimit,
  });
  if (error) throw new Error(error.message);
  return decodeHistoryMap<CloudShareholdingRow>(data, "rows");
}

export async function fetchCloudPrices(stockId: string, limit = 512): Promise<CloudPriceRow[]> {
  const { data, error } = await client()
    .from("stock_price")
    .select("stock_id,date,open,high,low,close,volume,amount")
    .eq("stock_id", stockId)
    .order("date", { ascending: false })
    .limit(Math.min(limit, 512));
  if (error) throw new Error(error.message);
  return [...(data || [])].reverse() as CloudPriceRow[];
}

export async function fetchCloudInstitutional(
  stockId: string,
  limit = 512,
): Promise<CloudInstitutionalRow[]> {
  const { data, error } = await client()
    .from("stock_institutional")
    .select("stock_id,date,foreign_net,trust_net,dealer_net,institutional_net")
    .eq("stock_id", stockId)
    .order("date", { ascending: false })
    .limit(Math.min(limit, 512));
  if (error) throw new Error(error.message);
  return (data || []) as CloudInstitutionalRow[];
}

export async function fetchCloudShareholding(stockId: string, limit = 512) {
  const { data, error } = await client()
    .from("tdcc_shareholding")
    .select("stock_id,date,source,total_shares,whale_ratio,retail_ratio,total_people,whale_shares,whale_people,updated_at")
    .eq("stock_id", stockId)
    .order("date", { ascending: false })
    .limit(Math.min(limit, 512));
  if (error) throw new Error(error.message);
  return (data || []) as CloudShareholdingRow[];
}

export async function fetchCloudMeta(stockId: string): Promise<CloudMetaRow | null> {
  const { data, error } = await client()
    .from("stock_meta")
    .select("stock_id,stock_name,market,industry_category,status,type")
    .eq("stock_id", stockId)
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data as CloudMetaRow | null;
}

export async function fetchCloudTradingCalendar(asOfDate: string, limit = 512): Promise<string[]> {
  const { data, error } = await client()
    .from("trading_calendar")
    .select("date")
    .eq("is_open", true)
    .lte("date", asOfDate)
    .order("date", { ascending: false })
    .limit(Math.min(limit, 512));
  if (error) throw new Error(error.message);
  return (data || []).map((row) => row.date).reverse();
}

export async function latestCloudDate(table: "stock_price" | "stock_institutional"): Promise<string | null> {
  const { data, error } = await client()
    .from(table)
    .select("date")
    .order("date", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data?.date || null;
}

export async function fetchCloudCandidates(
  date: string,
  minVolume: number,
  limit = 300,
): Promise<Array<CloudPriceRow & { stock_name: string }>> {
  const { data: prices, error: priceError } = await client()
    .from("stock_price")
    .select("stock_id,date,open,high,low,close,volume,amount")
    .eq("date", date)
    .gte("volume", minVolume * 1000)
    .order("volume", { ascending: false })
    .limit(limit);
  if (priceError) throw new Error(priceError.message);

  const ids = (prices || []).map((row) => row.stock_id);
  if (ids.length === 0) return [];
  const { data: metadata, error: metaError } = await client()
    .from("stock_meta")
    .select("stock_id,stock_name")
    .in("stock_id", ids);
  if (metaError) throw new Error(metaError.message);
  const names = new Map((metadata || []).map((row) => [row.stock_id, row.stock_name]));
  return (prices || []).map((row) => ({
    ...(row as CloudPriceRow),
    stock_name: names.get(row.stock_id) || row.stock_id,
  }));
}

export async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(values.length);
  let cursor = 0;
  async function worker() {
    while (cursor < values.length) {
      const index = cursor++;
      results[index] = await mapper(values[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, worker));
  return results;
}

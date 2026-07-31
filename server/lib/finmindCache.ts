import { supabaseAdmin } from "./runtimeState";
import type { SnapshotRow } from "./stockSnapshot";
import { isOrdinaryStockId } from "./stockUniverse";

const CACHE_WRITE_CEILING = 400 * 1024 * 1024;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const BATCH_SIZE = 300;

const DATASET_NAMES: Record<string, string> = {
  TaiwanStockPER: "valuation",
  TaiwanStockMonthRevenue: "monthly_revenue",
  TaiwanStockFinancialStatements: "financial_statements",
  TaiwanStockBalanceSheet: "balance_sheet",
  TaiwanStockCashFlowsStatement: "cash_flow",
  TaiwanStockInstitutionalInvestorsBuySell: "institutional",
  TaiwanStockMarginPurchaseShortSale: "margin",
  TaiwanStockDividend: "dividend",
  TaiwanStockShareholding: "foreign_shareholding",
};

export async function readFinMindCache(
  stockId: string,
  finmindDataset: string,
  startDate: string,
  endDate: string,
): Promise<SnapshotRow[] | null> {
  const dataset = DATASET_NAMES[finmindDataset];
  if (!supabaseAdmin || !dataset || !isOrdinaryStockId(stockId)) return null;
  const { data, error } = await supabaseAdmin
    .from("stock_dataset_cache")
    .select("payload,cached_at")
    .eq("stock_id", stockId)
    .eq("dataset", dataset)
    .gte("period_date", startDate)
    .lte("period_date", endDate)
    .order("period_date", { ascending: true })
    .limit(2000);
  if (error || !data || data.length === 0) return null;
  const newestCacheTime = Math.max(...data.map((row) => new Date(row.cached_at).getTime()));
  if (!Number.isFinite(newestCacheTime) || Date.now() - newestCacheTime > CACHE_TTL_MS) return null;
  return data.flatMap((row) => (
    Array.isArray(row.payload)
      ? row.payload as SnapshotRow[]
      : [row.payload as SnapshotRow]
  ));
}

async function cacheWritesAllowed(): Promise<boolean> {
  if (!supabaseAdmin) return false;
  const { data, error } = await supabaseAdmin.rpc("cloud_storage_status");
  if (error) return false;
  const status = Array.isArray(data) ? data[0] : data;
  return Number(status?.database_bytes || 0) < CACHE_WRITE_CEILING;
}

export async function writeFinMindCache(
  stockId: string,
  finmindDataset: string,
  rows: SnapshotRow[],
): Promise<void> {
  const dataset = DATASET_NAMES[finmindDataset];
  if (
    !supabaseAdmin
    || !dataset
    || !isOrdinaryStockId(stockId)
    || rows.length === 0
    || !(await cacheWritesAllowed())
  ) return;
  const now = new Date().toISOString();
  const grouped = new Map<string, SnapshotRow[]>();
  for (const payload of rows) {
    const periodDate = String(payload.date || "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(periodDate)) continue;
    const values = grouped.get(periodDate) || [];
    values.push(payload);
    grouped.set(periodDate, values);
  }
  const records = [...grouped.entries()].map(([periodDate, payload]) => ({
      stock_id: stockId,
      dataset,
      period_date: periodDate,
      payload,
      source: "finmind",
      cached_at: now,
      last_accessed_at: now,
  }));
  for (let offset = 0; offset < records.length; offset += BATCH_SIZE) {
    const { error } = await supabaseAdmin
      .from("stock_dataset_cache")
      .upsert(records.slice(offset, offset + BATCH_SIZE), {
        onConflict: "stock_id,dataset,period_date",
      });
    if (error) {
      console.warn(`[FinMind cache] ${finmindDataset} write skipped: ${error.message}`);
      return;
    }
  }
}

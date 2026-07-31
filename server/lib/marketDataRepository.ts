import { getDb } from "../db";
import { isOrdinaryStockId } from "./stockUniverse";

export interface StockMetaRow {
  stock_id: string;
  stock_name: string;
  market: string | null;
  industry_category?: string | null;
}

export interface PriceRow {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface InstitutionalRow {
  date: string;
  foreign_net: number;
  trust_net: number;
  dealer_net?: number;
  institutional_net?: number;
}

export interface LocalStockData {
  meta: StockMetaRow;
  prices: PriceRow[];
  institutional: InstitutionalRow[];
  shareholding: Record<string, unknown> | null;
}

function fallbackMeta(stockId: string): StockMetaRow {
  return { stock_id: stockId, stock_name: stockId, market: "", industry_category: null };
}

export function searchLocalStocks(query: string, limit = 30): StockMetaRow[] {
  const db = getDb();
  const pattern = `%${query}%`;
  const rows = db.prepare(`
    SELECT stock_id, stock_name, market, industry_category
    FROM stock_meta
    WHERE (stock_id LIKE ? OR stock_name LIKE ?)
      AND length(stock_id) = 4
      AND stock_id NOT GLOB '*[A-Z]*'
    LIMIT ?
  `).all(pattern, pattern, limit) as StockMetaRow[];
  return rows.filter((row) => isOrdinaryStockId(row.stock_id));
}

export function readLocalStockData(stockId: string, priceLimit = 1_000): LocalStockData {
  const db = getDb();
  const meta = (db.prepare(`
    SELECT stock_id, stock_name, market, industry_category
    FROM stock_meta WHERE stock_id = ?
  `).get(stockId) as StockMetaRow | undefined) || fallbackMeta(stockId);
  const prices = db.prepare(`
    SELECT date, open, high, low, close, volume
    FROM stock_history
    WHERE stock_id = ?
    ORDER BY date DESC
    LIMIT ?
  `).all(stockId, priceLimit) as PriceRow[];
  const institutional = db.prepare(`
    SELECT date, foreign_net, trust_net, dealer_net, institutional_net
    FROM institutional_data
    WHERE stock_id = ?
    ORDER BY date DESC
    LIMIT 1000
  `).all(stockId) as InstitutionalRow[];
  const shareholding = db.prepare(`
    SELECT date, whale_ratio, retail_ratio
    FROM tdcc_shareholding
    WHERE stock_id = ?
    ORDER BY date DESC
    LIMIT 1
  `).get(stockId) as Record<string, unknown> | undefined;
  return { meta, prices, institutional, shareholding: shareholding || null };
}

export function readLocalPriceRows(stockId: string, limit = 4_000): PriceRow[] {
  return getDb().prepare(`
    SELECT date, open, high, low, close, volume
    FROM stock_history
    WHERE stock_id = ?
    ORDER BY date DESC
    LIMIT ?
  `).all(stockId, limit) as PriceRow[];
}

export function readLocalMeta(stockId: string): StockMetaRow {
  return (getDb().prepare(`
    SELECT stock_id, stock_name, market, industry_category
    FROM stock_meta WHERE stock_id = ?
  `).get(stockId) as StockMetaRow | undefined) || fallbackMeta(stockId);
}

export function readLocalInstitutionalRows(stockId: string, limit = 1_000): InstitutionalRow[] {
  return getDb().prepare(`
    SELECT date, foreign_net, trust_net, dealer_net, institutional_net
    FROM institutional_data
    WHERE stock_id = ?
    ORDER BY date DESC
    LIMIT ?
  `).all(stockId, limit) as InstitutionalRow[];
}

export function hasUsableLocalPriceRows(
  rows: PriceRow[],
  now = Date.now(),
  maxAgeDays = 7,
): boolean {
  if (rows.length < 30) return false;
  const latestDate = rows.reduce(
    (latest, row) => row.date > latest ? row.date : latest,
    "",
  );
  const latest = new Date(`${latestDate}T23:59:59+08:00`).getTime();
  return Number.isFinite(latest) && now - latest <= maxAgeDays * 86_400_000;
}

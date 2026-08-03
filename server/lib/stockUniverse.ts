// Taiwan ordinary shares use four numeric digits. Exchange-traded products use
// leading-zero codes, while 91xx is reserved for Taiwan depositary receipts.
const ORDINARY_STOCK_ID = /^(?:[1-8]\d{3}|9[02-9]\d{2})$/;

export function isOrdinaryStockId(stockId: string): boolean {
  return ORDINARY_STOCK_ID.test(stockId.trim());
}

export interface StockMetaUniverseRow {
  stock_id: string;
  status: string | null;
  type: string | null;
  market: string | null;
}

export function isEligibleOrdinaryStock(row: StockMetaUniverseRow): boolean {
  // SQLite uses COMMON while the existing Supabase stock_meta sync uses stock.
  // Both represent the same common-share asset class; the code/market guards
  // still exclude ETFs, ETNs, warrants, TDRs and preferred shares.
  return row.status === "active"
    && (row.type === "COMMON" || row.type === "stock")
    && (row.market === "TSE" || row.market === "OTC")
    && isOrdinaryStockId(row.stock_id);
}

interface StockUniverseDatabase {
  prepare(sql: string): { all(): unknown[] };
}

export function loadEligibleOrdinaryStockIds(db: StockUniverseDatabase): Set<string> {
  const rows = db.prepare(
    "SELECT stock_id, status, type, market FROM stock_meta WHERE status = 'active'",
  ).all() as StockMetaUniverseRow[];
  return new Set(rows.filter(isEligibleOrdinaryStock).map((row) => row.stock_id));
}

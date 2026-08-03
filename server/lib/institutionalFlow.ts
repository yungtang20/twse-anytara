import { isOrdinaryStockId } from "./stockUniverse";

export const INSTITUTIONAL_SELECT_COLUMNS =
  "date, foreign_net, trust_net, dealer_net, institutional_net";

export interface InstitutionalRecord {
  stock_id: string;
  date: string;
  foreign_net: number;
  trust_net: number;
  dealer_net: number;
  institutional_net: number;
  source: "twse" | "tpex";
}

function officialNumber(value: unknown): number {
  const parsed = Number(String(value ?? "").replace(/[,+]/g, "").trim());
  return Number.isFinite(parsed) ? Math.round(parsed) : 0;
}

function verifiedTotal(
  market: "TWSE" | "TPEx",
  foreignNet: number,
  trustNet: number,
  dealerNet: number,
  reportedTotal: unknown,
): number {
  const calculated = foreignNet + trustNet + dealerNet;
  const reported = officialNumber(reportedTotal);
  if (reported !== calculated) {
    throw new Error(`${market} institutional total mismatch: reported=${reported}, calculated=${calculated}`);
  }
  return calculated;
}

export function parseTwseInstitutionalRow(row: unknown[], date: string): InstitutionalRecord | null {
  const stockId = String(row[0] ?? "").trim();
  if (!isOrdinaryStockId(stockId)) return null;
  const foreignNet = officialNumber(row[2]) - officialNumber(row[3]);
  const trustNet = officialNumber(row[8]) - officialNumber(row[9]);
  const dealerNet = officialNumber(row[12]) + officialNumber(row[15])
    - officialNumber(row[13]) - officialNumber(row[16]);
  return {
    stock_id: stockId,
    date,
    foreign_net: foreignNet,
    trust_net: trustNet,
    dealer_net: dealerNet,
    institutional_net: verifiedTotal("TWSE", foreignNet, trustNet, dealerNet, row[18]),
    source: "twse",
  };
}

export function parseTpexInstitutionalRow(row: unknown[], date: string): InstitutionalRecord | null {
  const stockId = String(row[0] ?? "").trim();
  if (!isOrdinaryStockId(stockId)) return null;
  const foreignNet = officialNumber(row[10]);
  const trustNet = officialNumber(row[13]);
  const dealerNet = officialNumber(row[22]);
  return {
    stock_id: stockId,
    date,
    foreign_net: foreignNet,
    trust_net: trustNet,
    dealer_net: dealerNet,
    institutional_net: verifiedTotal("TPEx", foreignNet, trustNet, dealerNet, row[23]),
    source: "tpex",
  };
}

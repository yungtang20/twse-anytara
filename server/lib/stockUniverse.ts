// Taiwan ordinary shares use four numeric digits. Exchange-traded products use
// leading-zero codes, while 91xx is reserved for Taiwan depositary receipts.
const ORDINARY_STOCK_ID = /^(?:[1-8]\d{3}|9[02-9]\d{2})$/;

export function isOrdinaryStockId(stockId: string): boolean {
  return ORDINARY_STOCK_ID.test(stockId.trim());
}

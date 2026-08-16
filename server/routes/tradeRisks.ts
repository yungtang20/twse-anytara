import { Router, type Response } from "express";
import { isAuthorizedAdminRequest } from "../lib/security";
import {
  getMarketTradeRisks, getStockTradeRisks, getTradeRiskStatus,
  type TradeRiskType,
} from "../lib/tradeRisks";

const router = Router();
const allowTestSqlite = (req: Parameters<typeof isAuthorizedAdminRequest>[0]) =>
  process.env.MARKET_DATA_MODE === "test" && isAuthorizedAdminRequest(req);
const TYPES = new Set<TradeRiskType>([
  "attention", "disposition", "trading_halt", "margin_restricted",
  "short_sale_restricted", "daytrade_restricted",
]);

function failure(res: Response, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return res.status(503).json({ success: false, error: message });
}

router.get("/api/stock/:id/trade-risks", async (req, res) => {
  try {
    return res.json({ success: true, data: await getStockTradeRisks(req.params.id, allowTestSqlite(req)) });
  } catch (error) { return failure(res, error); }
});

router.get("/api/market/trade-risks", async (req, res) => {
  try {
    const requested = String(req.query.type || "") as TradeRiskType;
    if (requested && !TYPES.has(requested)) return res.status(400).json({ success: false, error: "不支援的風險類型" });
    const data = await getMarketTradeRisks({
      active: String(req.query.active || "false") === "true",
      type: requested || undefined,
      allowLocal: allowTestSqlite(req),
    });
    return res.json({ success: true, data });
  } catch (error) { return failure(res, error); }
});

router.get("/api/status/trade-risk", async (req, res) => {
  try { return res.json({ success: true, data: await getTradeRiskStatus(allowTestSqlite(req)) }); }
  catch (error) { return failure(res, error); }
});

router.post("/api/trade-risks/sync", async (req, res) => {
  return res.status(410).json({
    success: false,
    error: "HTML server 的交易風險同步已停用；同步權責屬於 Python twstock",
  });
});

export default router;

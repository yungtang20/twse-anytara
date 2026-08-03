import { Router, type Request, type Response } from "express";
import { getDb } from "../db";
import { checkSupabaseReachability } from "../lib/cloudHealth";
import { debugState, getOtcStats, getTwseStats } from "../services";

const router = Router();
const useTestSqlite = process.env.MARKET_DATA_MODE === "test";

// ── Existing TWSE/TPEX Routes
router.get("/api/health", async (_req: Request, res: Response) => {
  if (!useTestSqlite) {
    const health = await checkSupabaseReachability();
    if (!health.success) {
      res.status(503).json(health);
      return;
    }
  }
  res.json({
    success: true,
    sqlite: useTestSqlite ? !!getDb() : false,
    time: new Date().toISOString()
  });
});

router.get("/api/twse-stats", async (_req: Request, res: Response) => {
  const data = await getTwseStats();
  if (data.success === false && "error" in data) {
    res.status(503).json({ success: false, error: data.error });
    return;
  }
  res.json(data);
});

router.get("/api/otc-stats", async (_req: Request, res: Response) => {
  const data = await getOtcStats();
  if (data.success === false && "error" in data) {
    res.status(503).json({ success: false, error: data.error });
    return;
  }
  res.json(data);
});

router.get("/api/debug-status", (_req: Request, res: Response) => {
  res.json({
    time: new Date().toLocaleString("en-US", { timeZone: "Asia/Taipei" }),
    logs: debugState.debugLogs,
    dbConnected: useTestSqlite ? !!getDb() : false
  });
});

export default router;

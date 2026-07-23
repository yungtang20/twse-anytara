import { Router, type Request, type Response } from "express";
import { getDb } from "../db";
import { debugState, getOtcStats, getTwseStats } from "../services";

const router = Router();

// ── Existing TWSE/TPEX Routes
router.get("/api/health", (_req: Request, res: Response) => {
  res.json({
    success: true,
    sqlite: !!getDb(),
    time: new Date().toISOString()
  });
});

router.get("/api/twse-stats", async (_req: Request, res: Response) => {
  const data = await getTwseStats();
  res.json(data);
});

router.get("/api/otc-stats", async (_req: Request, res: Response) => {
  const data = await getOtcStats();
  res.json(data);
});

router.get("/api/debug-status", (_req: Request, res: Response) => {
  res.json({
    time: new Date().toLocaleString("en-US", { timeZone: "Asia/Taipei" }),
    logs: debugState.debugLogs,
    dbConnected: !!getDb()
  });
});

export default router;

import { Router, json, type NextFunction, type Request, type Response } from "express";
import {
  mvpMcpHandler,
  jobBatchHandler,
  jobGetHandler,
  jobDeleteHandler,
  jobDeleteAllHandler,
  jobCancelHandler,
  jobListHandler,
  tdccSyncHandler,
  tdccStatusHandler,
} from "../mvpMcpRoutes";
import { isLoopbackRequest } from "../lib/security";
import { ingestTdccCSV, syncTdcc } from "../lib/tdccDownload";
import { getBridgeStatus, pushTdccToSupabase } from "../lib/syncBridge";
import { addLog } from "../services";

const router = Router();

router.use((req: Request, res: Response, next: NextFunction) => {
  if (!isLoopbackRequest(req)) return res.status(403).json({ success: false, error: "AI 與同步功能只能從本機使用" });
  next();
});

router.post("/api/ai-analysis", (_req, res) => res.status(410).json({
  success: false,
  error: "此舊版分析管線已停用，請改用 /api/job/batch",
  dataQuality: { isMock: false, warnings: ["legacy_pipeline_retired"] },
}));
router.post("/api/analysis-mvp", json(), mvpMcpHandler);
router.post("/api/job/batch", json(), jobBatchHandler);
router.post("/api/job/:id/cancel", jobCancelHandler);
router.delete("/api/job/:id", jobDeleteHandler);
router.delete("/api/jobs", jobDeleteAllHandler);
router.get("/api/job/:id", jobGetHandler);
router.get("/api/job", jobListHandler);

router.post("/api/upload-tdcc", json({ limit: "50mb" }), async (req: Request, res: Response) => {
  const csvText = typeof req.body?.csvText === "string" ? req.body.csvText : "";
  if (!csvText) return res.status(400).json({ success: false, error: "缺少 csvText 檔案內容" });
  try {
    const result = await ingestTdccCSV(csvText, {
      source: "upload",
      toSqlite: true,
      toSupabase: true,
      log: (message) => addLog("TDCC_UPLOAD", "INFO", message),
    });
    addLog("TDCC_UPLOAD", "OK", `parsed ${result.parsedRows} rows, stored ${result.count} records`);
    res.json({
      success: true,
      message: `成功解析 ${result.parsedRows} 條級距資料，建立或更新 ${result.count} 筆集保紀錄。`,
      parsedCount: result.parsedRows,
      insertedRecords: result.count,
      tdccDate: result.date,
      supabaseSynced: result.cloud.synced,
      warning: result.cloud.error || null,
    });
  } catch (error: any) {
    addLog("TDCC_UPLOAD", "ERROR", error.message?.slice(0, 200) || "unknown");
    res.status(400).json({ success: false, error: error.message });
  }
});

router.post("/api/auto-download-tdcc", async (_req: Request, res: Response) => {
  try {
    const result = await syncTdcc({
      toSqlite: true,
      toSupabase: true,
      log: (message) => addLog("TDCC_AUTO_FETCH", "INFO", message),
    });
    addLog("TDCC_AUTO_FETCH", "OK", `stored ${result.count} records for ${result.date}`);
    res.json({
      success: true,
      message: `成功同步 TDCC ${result.date}，建立或更新 ${result.count} 筆集保紀錄。`,
      parsedCount: result.parsedRows,
      insertedRecords: result.count,
      tdccDate: result.date,
      supabaseSynced: result.cloud.synced,
      warning: result.cloud.error || null,
    });
  } catch (error: any) {
    addLog("TDCC_AUTO_FETCH", "ERROR", error.message?.slice(0, 200) || "unknown");
    res.status(502).json({ success: false, error: error.message });
  }
});

router.post("/api/tdcc/sync", json(), tdccSyncHandler);
router.get("/api/tdcc/status", tdccStatusHandler);
router.get("/api/bridge/status", (_req, res) => res.json({ success: true, bridge: getBridgeStatus() }));
router.post("/api/bridge/push-tdcc", async (_req, res) => {
  try {
    const result = await pushTdccToSupabase();
    res.json({ success: true, pushed: result.pushed });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message?.slice(0, 200) });
  }
});

export default router;

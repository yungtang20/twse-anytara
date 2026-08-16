// MVP HTTP routes for the legacy test-mode analysis queue and TDCC operations.
import type { Request, Response } from "express";
import { startJob, getJob, listJobs, cancelJob, deleteJob, deleteAllJobs } from "./lib/jobQueue";
import { syncTdcc, getTdccSqliteStatus, getTdccUniverseStatus } from "./lib/tdccDownload";
import { resolveRuntimeMode } from "./lib/runtimeMode";
import { isOrdinaryStockId } from "./lib/stockUniverse";
import { hasNvidiaApiKey } from "./lib/nvidiaAi";
import { isLegacyFrameworkId } from "./lib/legacyFrameworkAnalysis";


function rejectCloudLocalOperation(res: Response): boolean {
  if (resolveRuntimeMode() !== "cloud") return false;
  res.status(410).json({
    success: false,
    error: "Cloud mode does not run local job queue or TDCC operations",
  });
  return true;
}

// POST /api/job/batch  — create + fire-forget, returns job_id immediately
export async function jobBatchHandler(req: Request, res: Response) {
  if (rejectCloudLocalOperation(res)) return;
  const stockId = String(req.body?.stock_id || "").trim();
  const requestedFrameworks: string[] = Array.isArray(req.body?.frameworks) ? req.body.frameworks : [];
  if (!isOrdinaryStockId(stockId)) return res.status(400).json({ success: false, error: "只支援普通股代號" });

  if (!hasNvidiaApiKey()) return res.status(500).json({ success: false, error: "未偵測到 NVIDIA API 金鑰，請先到設定頁配置。" });

  const frameworks = requestedFrameworks.filter(isLegacyFrameworkId);
  const finalFrameworks = frameworks.length ? frameworks : ["goldman"];

  const job = await startJob(stockId, finalFrameworks);
  res.json({
    success: true,
    job_id: job.id,
    status: job.status,
    frameworkIds: job.frameworkIds,
    per_framework: job.perFramework,
  });
}

// GET /api/job/:id  — poll status + reports
export async function jobGetHandler(req: Request, res: Response) {
  if (rejectCloudLocalOperation(res)) return;
  const id = req.params.id;
  const job = getJob(id);
  if (!job) return res.status(404).json({ success: false, error: "job 不存在" });
  res.json({ success: true, job });
}

export async function jobCancelHandler(req: Request, res: Response) {
  if (rejectCloudLocalOperation(res)) return;
  const job = cancelJob(req.params.id);
  if (!job) return res.status(404).json({ success: false, error: "job 不存在" });
  res.json({ success: true, job });
}

// GET /api/jobs?limit=20
export async function jobListHandler(_req: Request, res: Response) {
  if (rejectCloudLocalOperation(res)) return;
  const limit = Math.min(Number((_req as any).query?.limit) || 20, 100);
  res.json({ success: true, jobs: listJobs(limit) });
}

export async function jobDeleteHandler(req: Request, res: Response) {
  if (rejectCloudLocalOperation(res)) return;
  const ok = deleteJob(req.params.id);
  if (!ok) return res.status(404).json({ success: false, error: "job not found" });
  res.json({ success: true });
}

export async function jobDeleteAllHandler(_req: Request, res: Response) {
  if (rejectCloudLocalOperation(res)) return;
  const deleted = deleteAllJobs();
  res.json({ success: true, deleted });
}

// POST /api/tdcc/sync  — manual TDCC fetch (best-effort Supabase)
export async function tdccSyncHandler(req: Request, res: Response) {
  if (rejectCloudLocalOperation(res)) return;
  try {
    const r = await syncTdcc({ toSqlite: true, toSupabase: true, log: (m) => console.log("[tdcc-api]", m) });
    res.json({
      success: true,
      count: r.count,
      parsedCount: r.parsedRows,
      date: r.date,
      supabaseSynced: r.cloud.synced,
      warning: r.cloud.error || null,
      filterReport: r.report,
    });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e.message?.slice(0, 200) });
  }
}

// GET /api/tdcc/status  — per-stock latest TDCC date / total in SQLite
export async function tdccStatusHandler(_req: Request, res: Response) {
  if (rejectCloudLocalOperation(res)) return;
  try {
    res.json({ success: true, status: await getTdccUniverseStatus() });
  } catch (error) {
    res.status(503).json({ success: false, error: error instanceof Error ? error.message : String(error) });
  }
}

// 向後相容: POST /api/analysis-mvp (舊 single-framework 叫用 => 改 golden batch)
export async function mvpMcpHandler(req: Request, res: Response) {
  if (rejectCloudLocalOperation(res)) return;
  (req.body as any).frameworks = (req.body as any).frameworks || ["goldman"];
  return jobBatchHandler(req, res);
}

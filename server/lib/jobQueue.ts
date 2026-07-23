// SQLite-backed multi-framework analysis job queue
// Solves: user switching browser tabs stops the old serial for-loop analysis.
//   Long-running work runs in a detached async IIFE; state is persisted to SQLite.
//   Polling reads the same state.  Server restart resumes interrupted jobs.
import { getDb } from "../db";
import { supabase } from "../services";
import { fetchAnalysisSnapshot, runFrameworkAnalysis } from "../mvpMcpRoutes";
import type { AnalysisSnapshot } from "../mvpMcpRoutes";
import type { EvidenceSummary, ReportClaim } from "./evidenceReport";
import { fetchWithOneRetry } from "./fetchRetry";

export type JobStatus = "pending" | "running" | "done" | "error" | "cancelled";
export type FrameworkStatus = "pending" | "running" | "done" | "error" | "cancelled";

export interface FrameworkProgress {
  status: FrameworkStatus;
  report?: string;
  claims?: ReportClaim[];
  evidenceSummary?: EvidenceSummary;
  error?: string;
  startedAt?: number;
  endedAt?: number;
}

export async function mapWithConcurrency<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let nextIndex = 0;
  const workerCount = Math.min(items.length, Math.max(1, Math.floor(limit)));
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const item = items[nextIndex++];
      await worker(item);
    }
  }));
}

function frameworkConcurrency(): number {
  const configured = Number(process.env.LONGCAT_CONCURRENCY || 3);
  return Number.isFinite(configured) ? Math.min(6, Math.max(1, Math.floor(configured))) : 3;
}

export interface Job {
  id: string;
  stockId: string;
  stockName?: string;
  frameworkIds: string[];
  status: JobStatus;
  perFramework: Record<string, FrameworkProgress>;
  error?: string;
  startedAt: number;
  updatedAt: number;
  dedupeKey?: string;
}

const WORKER_ID = `worker_${process.pid}_${Math.random().toString(36).slice(2, 9)}`;
const LEASE_MS = 3 * 60_000;
let shuttingDown = false;
const FINMIND_DATA_INFO_URL = "https://api.finmindtrade.com/api/v4/data";

const normalizeStockName = (value: unknown): string => {
  if (typeof value !== "string") return "";
  return value.trim();
};

const pickCandidateName = (row: Record<string, unknown>): string => {
  const candidates = ["stock_name", "name", "StockName", "company_name", "security_name"];
  for (const key of candidates) {
    const next = normalizeStockName(row[key]);
    if (next) return next;
  }
  return "";
};

async function resolveStockNameFromFinmind(stockId: string): Promise<string> {
  const finmindApiKey = process.env.FINMIND_API_KEY || process.env.VITE_FINMIND_API_KEY || "";
  if (!finmindApiKey) return "";

  try {
    const query = new URLSearchParams({
      dataset: "TaiwanStockInfo",
      data_id: stockId,
    });
    const r = await fetchWithOneRetry(
      `${FINMIND_DATA_INFO_URL}?${query}`,
      {
        headers: { Authorization: `Bearer ${finmindApiKey}` },
      },
      undefined,
      15_000
    );
    if (!r.ok) return "";
    const j = await r.json() as { data?: Array<Record<string, unknown>> };
    const rows = Array.isArray(j?.data) ? j.data : [];
    const row = rows.find((r0) => {
      if (!r0 || typeof r0 !== "object") return false;
      const candidateId = normalizeStockName(r0.stock_id || r0.code);
      return candidateId === stockId;
    }) || rows[0];
    if (!row || typeof row !== "object") return "";
    return pickCandidateName(row) || "";
  } catch {
    return "";
  }
}

function upsertStockMeta(stockId: string, stockName: string, market = "", industry = "") {
  const db = getDb();
  if (!db || !stockId || !stockName) return;
  try {
    const exists = db.prepare("SELECT stock_id, stock_name FROM stock_meta WHERE stock_id = ?").get(stockId) as any;
    if (exists?.stock_name && exists.stock_name !== stockId && exists.stock_name !== stockName) return;
    db.prepare(
      `INSERT INTO stock_meta (stock_id, stock_name, market, industry_category, source)
       VALUES (?, ?, ?, ?, 'finmind')
       ON CONFLICT(stock_id) DO UPDATE SET
         stock_name = excluded.stock_name,
         market = COALESCE(NULLIF(excluded.market, ''), market),
         industry_category = COALESCE(NULLIF(excluded.industry_category, ''), industry_category),
         source = excluded.source,
         updated_at = datetime('now', 'localtime')`
    ).run(stockId, stockName, market || null, industry || null);
  } catch (e) {
    console.warn("[jobQueue] failed to upsert stock_meta", e);
  }
}

async function resolveStockName(stockId: string): Promise<string> {
  const db = getDb();
  if (!db) return "";
  try {
    const meta = db.prepare("SELECT stock_name, market, industry_category FROM stock_meta WHERE stock_id = ?").get(stockId) as any;
    if (meta?.stock_name) return meta.stock_name;
  } catch {
    /* metadata optional */
  }

  if (supabase) {
    try {
      const { data, error } = await supabase.from("stock_meta")
        .select("stock_id, stock_name, market, industry_category")
        .eq("stock_id", stockId)
        .limit(1);
      if (!error && data?.[0]?.stock_name) {
        const remote = data[0];
        const name = normalizeStockName(remote.stock_name);
        if (name) {
          upsertStockMeta(stockId, name, remote.market || "", remote.industry_category || "");
          return name;
        }
      }
    } catch { /* ignore */ }
  }

  const finmindName = await resolveStockNameFromFinmind(stockId);
  if (finmindName) {
    upsertStockMeta(stockId, finmindName);
    return finmindName;
  }
  return "";
}

export function createJobDedupeKey(stockId: string, frameworkIds: string[]): string {
  return `${stockId}:${[...new Set(frameworkIds)].sort().join(",")}`;
}

const TABLE_SQL = `
CREATE TABLE IF NOT EXISTS analysis_jobs (
  id TEXT PRIMARY KEY,
  stock_id TEXT NOT NULL,
  stock_name TEXT,
  framework_ids TEXT NOT NULL,
  framework_count INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  per_framework TEXT NOT NULL DEFAULT '{}',
  error TEXT,
  started_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_analysis_jobs_status ON analysis_jobs(status);
CREATE INDEX IF NOT EXISTS idx_analysis_jobs_updated ON analysis_jobs(updated_at DESC);
`;

let initialized = false;
function ensureTable() {
  if (initialized) return;
  const db = getDb();
  db.exec(TABLE_SQL);
  const columns = new Set((db.prepare(`PRAGMA table_info(analysis_jobs)`).all() as any[]).map((column) => column.name));
  if (!columns.has("stock_name")) db.exec(`ALTER TABLE analysis_jobs ADD COLUMN stock_name TEXT;`);
  if (!columns.has("error")) db.exec(`ALTER TABLE analysis_jobs ADD COLUMN error TEXT;`);
  // Auto-cleanup jobs older than 24 hours
  try {
    const cutoff = Date.now() - 86400000;
    db.prepare(`DELETE FROM analysis_job_reports WHERE job_id IN (SELECT id FROM analysis_jobs WHERE updated_at < ?)`).run(cutoff);
    db.prepare(`DELETE FROM analysis_snapshots WHERE job_id IN (SELECT id FROM analysis_jobs WHERE updated_at < ?)`).run(cutoff);
    db.prepare(`DELETE FROM analysis_jobs WHERE updated_at < ?`).run(cutoff);
  } catch(e) {}
  initialized = true;
}

function nowMs(): number { return Date.now(); }

function mapRowToJob(row: any): Job {
  return {
    id: row.id,
    stockId: row.stock_id,
    stockName: row.stock_name || "",
    frameworkIds: JSON.parse(row.framework_ids),
    status: row.status as JobStatus,
    perFramework: JSON.parse(row.per_framework),
    error: row.error,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    dedupeKey: row.dedupe_key || undefined,
  };
}

function hydrateReports(jobs: Job[]): Job[] {
  if (jobs.length === 0) return jobs;
  const placeholders = jobs.map(() => "?").join(",");
  const reportRows = getDb().prepare(
    `SELECT job_id, framework_id, report_markdown, claims_json, evidence_json FROM analysis_job_reports WHERE job_id IN (${placeholders})`
  ).all(...jobs.map((job) => job.id)) as any[];
  const byJob = new Map(jobs.map((job) => [job.id, job]));
  for (const row of reportRows) {
    const progress = byJob.get(row.job_id)?.perFramework[row.framework_id];
    if (!progress) continue;
    if (row.report_markdown) progress.report = row.report_markdown;
    try { progress.claims = JSON.parse(row.claims_json || "[]"); } catch { progress.claims = []; }
    try { progress.evidenceSummary = JSON.parse(row.evidence_json || "{}").summary; } catch { /* legacy row */ }
  }
  return jobs;
}

export function listJobs(limit = 20): Job[] {
  ensureTable();
  const rows = getDb().prepare(`SELECT * FROM analysis_jobs ORDER BY updated_at DESC LIMIT ?`).all(limit);
  return hydrateReports(rows.map(mapRowToJob));
}

export function getJob(id: string): Job | null {
  ensureTable();
  const row = getDb().prepare(`SELECT * FROM analysis_jobs WHERE id = ?`).get(id);
  return row ? hydrateReports([mapRowToJob(row)])[0] : null;
}

function saveFrameworkProgress(jobId: string, frameworkId: string, progress: FrameworkProgress, evidence: Record<string, unknown> = {}) {
  getDb().prepare(`
    INSERT INTO analysis_job_reports
      (job_id, framework_id, status, report_markdown, claims_json, evidence_json, error, started_at, ended_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(job_id, framework_id) DO UPDATE SET
      status=excluded.status,
      report_markdown=COALESCE(excluded.report_markdown, analysis_job_reports.report_markdown),
      claims_json=excluded.claims_json,
      evidence_json=excluded.evidence_json,
      error=excluded.error,
      started_at=COALESCE(excluded.started_at, analysis_job_reports.started_at),
      ended_at=excluded.ended_at
  `).run(
    jobId,
    frameworkId,
    progress.status,
    progress.report || null,
    JSON.stringify(progress.claims || []),
    JSON.stringify({ references: evidence, summary: progress.evidenceSummary || null }),
    progress.error || null,
    progress.startedAt || null,
    progress.endedAt || null,
  );
}

function saveSnapshot(jobId: string, snapshot: AnalysisSnapshot): void {
  const { dataBlock: _dataBlock, datasetRows: _datasetRows, ...canonical } = snapshot;
  getDb().prepare(`
    INSERT INTO analysis_snapshots (id, job_id, stock_id, as_of, retrieved_at, snapshot_json, quality_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(job_id) DO UPDATE SET
      as_of=excluded.as_of,
      retrieved_at=excluded.retrieved_at,
      snapshot_json=excluded.snapshot_json,
      quality_json=excluded.quality_json
  `).run(
    `snapshot_${jobId}`,
    jobId,
    snapshot.stockId,
    snapshot.asOf,
    snapshot.retrievedAt,
    JSON.stringify(canonical),
    JSON.stringify(snapshot.quality),
  );
}

function upsertJob(job: Job) {
  const progressSummary = Object.fromEntries(Object.entries(job.perFramework).map(([frameworkId, progress]) => [frameworkId, {
    status: progress.status,
    error: progress.error,
    startedAt: progress.startedAt,
    endedAt: progress.endedAt,
    evidenceSummary: progress.evidenceSummary,
  }]));
  getDb()
    .prepare(
      `INSERT INTO analysis_jobs
        (id, stock_id, stock_name, framework_ids, framework_count, status, per_framework, error, started_at, updated_at, dedupe_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         stock_name=excluded.stock_name,
         status=excluded.status,
         per_framework=excluded.per_framework,
         error=excluded.error,
         updated_at=excluded.updated_at`
    )
    .run(
      job.id,
      job.stockId,
      job.stockName || null,
      JSON.stringify(job.frameworkIds),
      job.frameworkIds.length,
      job.status,
      JSON.stringify(progressSummary),
      job.error || null,
      job.startedAt,
      job.updatedAt,
      job.dedupeKey || null,
    );
}

function claimLease(jobId: string): boolean {
  const now = Date.now();
  const result = getDb().prepare(`
    UPDATE analysis_jobs
    SET worker_id = ?, lease_until = ?, attempt_count = attempt_count + 1
    WHERE id = ? AND status = 'running'
      AND (worker_id = ? OR lease_until IS NULL OR lease_until < ?)
  `).run(WORKER_ID, now + LEASE_MS, jobId, WORKER_ID, now) as { changes: number };
  return result.changes === 1;
}

function renewLease(jobId: string): void {
  getDb().prepare("UPDATE analysis_jobs SET lease_until = ? WHERE id = ? AND worker_id = ? AND status = 'running'")
    .run(Date.now() + LEASE_MS, jobId, WORKER_ID);
}

function releaseLease(jobId: string): void {
  getDb().prepare("UPDATE analysis_jobs SET worker_id = NULL, lease_until = NULL WHERE id = ? AND worker_id = ?")
    .run(jobId, WORKER_ID);
}

const controllers = new Map<string, AbortController>();
let queueTail: Promise<void> = Promise.resolve();

function markCancelled(job: Job): void {
  for (const fwId of job.frameworkIds) {
    const progress = job.perFramework[fwId];
    if (!progress || progress.status === "pending" || progress.status === "running") {
      job.perFramework[fwId] = {
        ...progress,
        status: "cancelled",
        endedAt: Date.now(),
      };
      saveFrameworkProgress(job.id, fwId, job.perFramework[fwId]);
    }
  }
  job.status = "cancelled";
  job.updatedAt = Date.now();
  upsertJob(job);
}

async function runJob(job: Job, frameworkIds: string[], controller: AbortController): Promise<void> {
  if (!claimLease(job.id)) return;
  let hasError = false;
  try {
    if (controller.signal.aborted) {
      if (!shuttingDown) markCancelled(job);
      return;
    }
    let snapshot;
    try {
      snapshot = await fetchAnalysisSnapshot(job.stockId, controller.signal, frameworkIds);
      saveSnapshot(job.id, snapshot);
      renewLease(job.id);
    } catch (e: any) {
      if (controller.signal.aborted || e?.name === "AbortError") {
        if (!shuttingDown) markCancelled(job);
        return;
      }
      const error = e.message?.slice(0, 200) || "snapshot_failed";
      for (const fwId of frameworkIds) {
        job.perFramework[fwId] = { status: "error", error, endedAt: Date.now() };
        saveFrameworkProgress(job.id, fwId, job.perFramework[fwId]);
      }
      job.status = "error";
      job.error = error;
      job.updatedAt = Date.now();
      upsertJob(job);
      return;
    }
    await mapWithConcurrency(frameworkIds, frameworkConcurrency(), async (fwId) => {
      if (controller.signal.aborted) {
        return;
      }
      try {
        job.perFramework[fwId] = { status: "running", startedAt: Date.now() };
        saveFrameworkProgress(job.id, fwId, job.perFramework[fwId]);
        job.updatedAt = Date.now();
        upsertJob(job);

        const analysis = await runFrameworkAnalysis(job.stockId, fwId, controller.signal, snapshot);
        controller.signal.throwIfAborted();
        job.perFramework[fwId] = {
          status: "done",
          report: analysis.report,
          claims: analysis.claims,
          evidenceSummary: analysis.evidenceSummary,
          endedAt: Date.now(),
          startedAt: job.perFramework[fwId].startedAt,
        };
        saveFrameworkProgress(job.id, fwId, job.perFramework[fwId], analysis.evidence);
        renewLease(job.id);
      } catch (e: any) {
        if (controller.signal.aborted || e?.name === "AbortError") {
          return;
        }
        console.error(`[jobQueue] Error analyzing ${fwId}:`, e);
        job.perFramework[fwId] = {
          status: "error",
          error: e.message?.slice(0, 200) || "unknown",
          endedAt: Date.now(),
          startedAt: job.perFramework[fwId]?.startedAt,
        };
        saveFrameworkProgress(job.id, fwId, job.perFramework[fwId]);
        hasError = true;
      }
      job.updatedAt = Date.now();
      upsertJob(job);
    });
    if (controller.signal.aborted) {
      if (!shuttingDown) markCancelled(job);
      return;
    }
    job.status = hasError ? "error" : "done";
    job.updatedAt = Date.now();
    upsertJob(job);
  } finally {
    releaseLease(job.id);
    if (controllers.get(job.id) === controller) controllers.delete(job.id);
  }
}

function enqueueJob(job: Job, frameworkIds: string[]): void {
  const controller = new AbortController();
  controllers.set(job.id, controller);
  const execute = () => runJob(job, frameworkIds, controller);
  // ponytail: one process-wide lane avoids provider bursts; replace with a durable worker when multi-instance deployment is needed.
  queueTail = queueTail.then(execute, execute).catch((e) => {
    console.error("[jobQueue] top-level error", e);
    job.status = "error";
    job.error = e?.message?.slice(0, 200) || "unknown";
    job.updatedAt = Date.now();
    upsertJob(job);
  });
}

export function cancelJob(id: string): Job | null {
  const job = getJob(id);
  if (!job) return null;
  if (job.status === "done" || job.status === "error" || job.status === "cancelled") return job;
  controllers.get(id)?.abort();
  markCancelled(job);
  return job;
}

export function deleteJob(id: string): boolean {
  const db = getDb();
  const job = getJob(id);
  if (!job) return false;

  controllers.get(id)?.abort();
  controllers.delete(id);
  releaseLease(id);

  db.transaction(() => {
    db.prepare("DELETE FROM analysis_job_reports WHERE job_id = ?").run(id);
    db.prepare("DELETE FROM analysis_snapshots WHERE job_id = ?").run(id);
    db.prepare("DELETE FROM analysis_jobs WHERE id = ?").run(id);
  })();
  return true;
}

export function deleteAllJobs(): number {
  const db = getDb();
  ensureTable();

  const jobIds = db.prepare("SELECT id FROM analysis_jobs").all() as Array<{ id: string }>;
  if (jobIds.length === 0) return 0;

  for (const { id } of jobIds) {
    controllers.get(id)?.abort();
    controllers.delete(id);
    releaseLease(id);
  }
  controllers.clear();

  return db.transaction(() => {
    db.prepare("DELETE FROM analysis_job_reports").run();
    db.prepare("DELETE FROM analysis_snapshots").run();
    const result = db.prepare("DELETE FROM analysis_jobs").run();
    return result.changes;
  })();
}

// Fire-and-forget: enqueue the job and return immediately for polling.
export async function startJob(stockId: string, frameworkIds: string[]): Promise<Job> {
  ensureTable();
  const normalizedFrameworkIds = [...new Set(frameworkIds)].sort();
  const dedupeKey = createJobDedupeKey(stockId, normalizedFrameworkIds);
  const existing = getDb().prepare(
    "SELECT * FROM analysis_jobs WHERE dedupe_key = ? AND status IN ('pending', 'running') ORDER BY started_at DESC LIMIT 1"
  ).get(dedupeKey);
  if (existing) return hydrateReports([mapRowToJob(existing)])[0];
  const t = nowMs();
  const perFramework: Record<string, FrameworkProgress> = {};
  for (const f of normalizedFrameworkIds) perFramework[f] = { status: "pending" };

  const stockName = await resolveStockName(stockId);

  const job: Job = {
    id: `job_${t}_${Math.random().toString(36).slice(2, 9)}`,
    stockId,
    stockName,
    frameworkIds: normalizedFrameworkIds,
    status: "running",
    perFramework,
    startedAt: t,
    updatedAt: t,
    dedupeKey,
  };
  try {
    upsertJob(job);
  } catch (error: any) {
    if (!String(error?.message || "").includes("UNIQUE")) throw error;
    const raced = getDb().prepare("SELECT * FROM analysis_jobs WHERE dedupe_key = ? AND status IN ('pending', 'running') LIMIT 1").get(dedupeKey);
    if (!raced) throw error;
    return hydrateReports([mapRowToJob(raced)])[0];
  }
  enqueueJob(job, normalizedFrameworkIds);

  return job;
}

// Resume jobs marked 'running' interrupted by server restart.
export function resumeInterruptedJobs(): void {
  ensureTable();
  const rows = getDb()
    .prepare(`SELECT * FROM analysis_jobs WHERE status = 'running' AND (lease_until IS NULL OR lease_until < ?) ORDER BY updated_at DESC`)
    .all(Date.now());
  for (const row of rows) {
    const job = mapRowToJob(row);
    const nonDone = job.frameworkIds.filter(
      (f) => job.perFramework[f]?.status !== "done"
    );
    if (nonDone.length === 0) {
      // everything actually finished — reconcile status
      job.status = Object.values(job.perFramework).every((p) => p.status === "done")
        ? "done" : "error";
      job.updatedAt = Date.now();
      upsertJob(job);
      continue;
    }
    console.log(`[jobQueue] resume job ${job.id} (${job.stockId}), ${nonDone.length} frameworks remaining`);
    enqueueJob(job, nonDone);
  }
}

export async function shutdownJobQueue(timeoutMs = 5_000): Promise<void> {
  shuttingDown = true;
  for (const controller of controllers.values()) controller.abort();
  await Promise.race([
    queueTail,
    new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
  for (const jobId of controllers.keys()) releaseLease(jobId);
}

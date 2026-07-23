import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import dotenv from "dotenv";
import type { ChildProcess } from "child_process";
import { initDb, closeDb } from "./server/db";
import { initMcp } from "./server/lib/mcpClient";
import { resumeInterruptedJobs, shutdownJobQueue } from "./server/lib/jobQueue";
import { startTdccScheduler, stopTdccScheduler } from "./server/lib/tdccScheduler";
import apiRouter from "./server/routes";
import { debugState, addLog, pushSyncLog } from "./server/services";

// Load environment variables from .env
dotenv.config();

let syncChild: ChildProcess | null = null;

function getLatestTradingDayInTaipei(): string {
  // Get current date/time in Taipei
  const taipeiTimeStr = new Date().toLocaleString("en-US", { timeZone: "Asia/Taipei" });
  const taipeiDate = new Date(taipeiTimeStr);
  
  const y = taipeiDate.getFullYear();
  const m = String(taipeiDate.getMonth() + 1).padStart(2, '0');
  const d = String(taipeiDate.getDate()).padStart(2, '0');
  const todayStr = `${y}-${m}-${d}`;

  // Check day of week (0 = Sunday, 1 = Monday, ..., 6 = Saturday)
  const dayOfWeek = taipeiDate.getDay();
  const hour = taipeiDate.getHours();
  const minute = taipeiDate.getMinutes();

  // If weekday and after 14:30 (when TWSE/TPEX are guaranteed to be fully processed),
  // latest trading day should be today.
  // Otherwise, it should be the most recent weekday before today.
  if (dayOfWeek >= 1 && dayOfWeek <= 5) {
    if (hour > 14 || (hour === 14 && minute >= 30)) {
      return todayStr;
    }
  }

  // Find the previous weekday
  const tempDate = new Date(taipeiDate);
  do {
    tempDate.setDate(tempDate.getDate() - 1);
  } while (tempDate.getDay() === 0 || tempDate.getDay() === 6);

  const py = tempDate.getFullYear();
  const pm = String(tempDate.getMonth() + 1).padStart(2, '0');
  const pd = String(tempDate.getDate()).padStart(2, '0');
  return `${py}-${pm}-${pd}`;
}

async function startServer() {
  const app = express();
  const PORT = Number(process.env.PORT) || 3000;
  const HOST = process.env.HOST || "127.0.0.1";

  // Initialize SQLite Database
  const db = initDb();

  // Trigger background sync if DB lacks historical data or is stale
  if (db) {
    try {
      const row = db.prepare("SELECT COUNT(DISTINCT date) as c FROM stock_price").get() as { c: number };
      const latestDbRow = db.prepare("SELECT MAX(date) as max_date FROM stock_price").get() as { max_date: string | null };
      const latestDbDate = latestDbRow?.max_date || "";
      const expectedLatestDate = getLatestTradingDayInTaipei();

      const isDBCriticalEmpty = row.c < 10;
      const isDBStale = !latestDbDate || latestDbDate < expectedLatestDate;

      if ((isDBCriticalEmpty || isDBStale) && (process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL) && (process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY)) {
         const syncType = isDBCriticalEmpty ? "CRITICAL_RESTORE" : "STALE_UPDATE";
         console.log(`[SYNC] Triggering background sync (${syncType}). Local latest: ${latestDbDate || 'None'}, Expected: ${expectedLatestDate}`);

         // Reset status block
         debugState.activeSyncProcess.running = true;
         debugState.activeSyncProcess.startTime = new Date().toLocaleString("en-US", { timeZone: "Asia/Taipei" });
         debugState.activeSyncProcess.error = null;

         if (isDBCriticalEmpty) {
           debugState.activeSyncProcess.logs = [
             `[系統] ${new Date().toLocaleTimeString("zh-TW", { hour12: false })} [自動修復] 檢測到本地資料集嚴重缺失（僅 ${row.c} 天歷史），啟動極速恢復程序...`
           ];
         } else {
           debugState.activeSyncProcess.logs = [
             `[系統] ${new Date().toLocaleTimeString("zh-TW", { hour12: false })} [自動同步] 檢測到本地資料 (${latestDbDate}) 舊於最新交易日 (${expectedLatestDate})，啟動盤後自動補登更新...`
           ];
         }

         const { spawn } = await import("child_process");
         const webhookUrl = process.env.UPDATE_WEBHOOK_URL || process.env.VITE_UPDATE_WEBHOOK_URL;

         if (webhookUrl && (webhookUrl.startsWith("http://") || webhookUrl.startsWith("https://"))) {
           pushSyncLog(`[系統] 偵測到遠端 Webhook，進行同步觸發: ${webhookUrl}`);
           try {
             await fetch(webhookUrl, {
               method: 'POST',
               signal: AbortSignal.timeout(4000)
             });
             pushSyncLog(`[系統] 遠端 Webhook 觸發成功。`);
           } catch (err: any) {
             pushSyncLog(`[系統] [警告] 遠端 Webhook 觸發未成功: ${err.message}`);
             console.warn(`[Webhook-Warning] Background remote webhook trigger failed: ${err.message}`);
           }
         }

         // For critical empty, we do fast_sync first. For stale, we do pull_from_supabase && complete_and_fetch_today.
         const node = JSON.stringify(process.execPath);
         const cmd = isDBCriticalEmpty
           ? `${node} scripts/fast_sync.js && ${node} scripts/pull_from_supabase.js`
           : `${node} scripts/pull_from_supabase.js && ${node} scripts/complete_and_fetch_today.js`;

         pushSyncLog(`[系統] 執行命令: ${cmd}`);

         const child = spawn(cmd, { shell: true, windowsHide: true });
         syncChild = child;

         child.stdout.on("data", (data) => {
           const text = data.toString();
           const lines = text.split(/\r?\n/);
           for (const line of lines) {
             const trimmed = line.trim();
             if (trimmed) {
               const time = new Date().toLocaleTimeString("zh-TW", { hour12: false });
               pushSyncLog(`[${time}] ${trimmed}`);
               addLog('SYNC_STAGE', 'INFO', trimmed);
               if (trimmed.startsWith("[Sync-Info]") || trimmed.startsWith("[Sync-Error]")) {
                 console.log(trimmed);
               } else {
                 console.log(`[Sync-Info] ${trimmed}`);
               }
             }
           }
         });

         child.stderr.on("data", (data) => {
           const text = data.toString();
           const lines = text.split(/\r?\n/);
           for (const line of lines) {
             const trimmed = line.trim();
             if (trimmed) {
               const time = new Date().toLocaleTimeString("zh-TW", { hour12: false });
               pushSyncLog(`[${time}] [錯誤] ${trimmed}`);
               addLog('SYNC_STAGE', 'ERR', trimmed);
               if (trimmed.startsWith("[Sync-Info]") || trimmed.startsWith("[Sync-Error]")) {
                 console.error(trimmed);
               } else {
                 console.error(`[Sync-Error] ${trimmed}`);
               }
             }
           }
         });

         child.on("close", (code) => {
           if (syncChild === child) syncChild = null;
           debugState.activeSyncProcess.running = false;
           const time = new Date().toLocaleTimeString("zh-TW", { hour12: false });
           if (code !== 0) {
             debugState.activeSyncProcess.error = `處理程序異常終止 (代碼: ${code})`;
             pushSyncLog(`\n[${time}] ❌ 行程異常結束。錯誤代碼: ${code}`);
             addLog('SYNC', 'ERROR', `Background sync process exited with code ${code}`);
           } else {
             pushSyncLog(`\n[${time}] ✅ 行程順利完成！資料庫日期已與最新盤後資訊同步。`);
             addLog('SYNC', 'OK', 'Database synchronized successfully on server start.');
           }
         });
      }
    } catch (e: any) {
      console.error("Failed to check DB history state:", e.message);
    }
  }

  // Only the CSV import route accepts a large body.
  app.use("/api/upload-tdcc", express.json({ limit: "50mb" }));
  app.use(express.json({ limit: "1mb" }));
  app.use(express.urlencoded({ extended: true, limit: "1mb" }));

  // Mount API router
  app.use(apiRouter);

  // Vite Middleware for Development or Static Files for Production
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  const httpServer = app.listen(PORT, HOST, () => {
    console.log(`[FULL-STACK] Express server running on http://${HOST}:${PORT}`);
    // MVP: 连 remote MCP server (失败不卡 server)
    initMcp().then((ok) => console.log(`[MVP] MCP init ${ok ? "OK" : "FAIL (server 仍可用)"}`));

    // 恢復未完成的 job (server 重啟後)
    try { resumeInterruptedJobs(); } catch (e: any) { console.warn("[jobQueue] resume 失敗:", e.message); }

    // TDCC 每周排程器
    if (process.env.TDCC_SCHEDULER_ENABLED !== "false") {
      try { startTdccScheduler(); } catch (e: any) { console.warn("[tdcc-scheduler] 啟動失敗:", e.message); }
    }
  });

  let closing = false;
  const shutdown = async (signal: string) => {
    if (closing) return;
    closing = true;
    console.log(`[FULL-STACK] ${signal}: graceful shutdown started`);
    stopTdccScheduler();
    syncChild?.kill();
    await shutdownJobQueue();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    closeDb();
    console.log("[FULL-STACK] graceful shutdown complete");
  };
  process.once("SIGINT", () => { shutdown("SIGINT").then(() => process.exit(0)); });
  process.once("SIGTERM", () => { shutdown("SIGTERM").then(() => process.exit(0)); });
}

startServer().catch((error) => {
  console.error("[FULL-STACK] startup failed", error);
  closeDb();
  process.exitCode = 1;
});

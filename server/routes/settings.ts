import { Router, json, type NextFunction, type Request, type Response } from "express";
import fs from "fs";
import path from "path";
import { isLoopbackRequest, normalizeLongcatBaseUrl, validateEnvValue } from "../lib/security";
import { describeSupabaseError } from "../lib/supabaseDiagnostics";
import { pruneSupabaseData } from "../lib/syncBridge";
import { debugState, addLog, pushSyncLog, supabase } from "../services";

const router = Router();

router.use((req: Request, res: Response, next: NextFunction) => {
  if (!isLoopbackRequest(req)) return res.status(403).json({ success: false, error: "設定與同步管理只能從本機使用" });
  next();
});

function updateEnvFile(updates: Record<string, string>) {
  const envPath = path.join(process.cwd(), ".env");
  let content = "";
  if (fs.existsSync(envPath)) content = fs.readFileSync(envPath, "utf-8");
  else {
    const examplePath = path.join(process.cwd(), ".env.example");
    if (fs.existsSync(examplePath)) content = fs.readFileSync(examplePath, "utf-8");
  }

  const lines = content.split(/\r?\n/);
  for (const [key, value] of Object.entries(updates)) {
    process.env[key] = value;
    const index = lines.findIndex((line) => line.trim().startsWith(`${key}=`) || line.trim().startsWith(`# ${key}=`));
    if (index >= 0) lines[index] = `${key}=${value}`;
    else lines.push(`${key}=${value}`);
  }
  fs.writeFileSync(envPath, lines.join("\n"), "utf-8");
}

// API to check Supabase diagnostics and return connection & schema status
router.get("/api/settings/supabase-status", async (_req: Request, res: Response) => {
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || "";
  const key = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY || "";
  if (!url || !key) {
    return res.json({
      success: true,
      configured: false,
      connected: false,
      tableExists: false,
      message: "未在 .env 中配置 SUPABASE_URL 與 SUPABASE_ANON_KEY",
    });
  }

  if (!supabase) {
    return res.json({
      success: true,
      configured: true,
      connected: false,
      tableExists: false,
      message: "Supabase 用戶端初始化失敗，請檢查金鑰格式",
    });
  }

  try {
    const { error } = await supabase
      .from("stock_price")
      .select("stock_id")
      .limit(1);

    if (error) {
      if (error.message.includes("relation") && error.message.includes("does not exist")) {
        return res.json({
          success: true,
          configured: true,
          connected: true,
          tableExists: false,
          sql: `CREATE TABLE IF NOT EXISTS public.stock_price (
    stock_id TEXT NOT NULL,
    date TEXT NOT NULL,
    open REAL,
    high REAL,
    low REAL,
    close REAL,
    volume BIGINT,
    amount BIGINT,
    trade_count BIGINT,
    spread REAL,
    PRIMARY KEY(stock_id, date)
);

ALTER TABLE public.stock_price ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.stock_price FROM anon, authenticated;
GRANT SELECT ON TABLE public.stock_price TO anon, authenticated;
GRANT ALL ON TABLE public.stock_price TO service_role;

CREATE POLICY "stock_price_public_read"
ON public.stock_price FOR SELECT
TO anon, authenticated
USING (true);`,
          message: "連線成功，但尚未建立受 RLS 保護的 stock_price。請先套用專案中的 Supabase migration。"
        });
      }
      return res.json({
        success: true,
        configured: true,
        connected: false,
        tableExists: false,
        ...describeSupabaseError(error, url),
      });
    }

    return res.json({
      success: true,
      configured: true,
      connected: true,
      tableExists: true,
      serviceRoleConfigured: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY),
      message: "Supabase 連線成功且 `stock_price` 可讀；RLS 狀態請以 Supabase advisor 為準。"
    });
  } catch (e: any) {
    return res.json({
      success: true,
      configured: true,
      connected: false,
      tableExists: false,
      message: `連線異常: ${e.message}`
    });
  }
});

// API to trigger database pruning and cleanup fallback
router.post("/api/settings/cleanup", json(), async (req: Request, res: Response) => {
  if (debugState.activeSyncProcess.running) {
    return res.status(400).json({ success: false, error: "另一個背景工作（爬蟲、清理或同步）仍在運行中" });
  }

  debugState.activeSyncProcess.running = true;
  debugState.activeSyncProcess.startTime = new Date().toISOString();
  debugState.activeSyncProcess.error = null;
  debugState.activeSyncProcess.logs = [];

  const addSyncLog = (msg: string) => {
    const time = new Date().toLocaleTimeString("zh-TW", { hour12: false });
    pushSyncLog(`[${time}] ${msg}`);
  };
  const execute = req.body?.confirm === "DELETE_SUPABASE_HISTORY";

  // Run in background
  (async () => {
    try {
      addSyncLog(execute ? "開始執行 Supabase 保留規則..." : "開始 Supabase 保留規則 dry-run...");
      const result = await pruneSupabaseData(512, addSyncLog, execute);
      addLog("PRUNE", "OK", JSON.stringify(result));
    } catch (e: any) {
      debugState.activeSyncProcess.error = e.message;
      addSyncLog(`\n❌ 清理過程遭遇阻礙: ${e.message}`);
      addLog('PRUNE', 'ERROR', e.message);
    } finally {
      debugState.activeSyncProcess.running = false;
    }
  })();

  res.json({
    success: true,
    dryRun: !execute,
    message: execute
      ? "Supabase 修剪已於背景啟動"
      : "Supabase 修剪預覽已於背景啟動；未提供確認字串，不會刪除資料",
  });
});

// Kept as an explicit tombstone so older clients cannot silently mix cloud and local data.
router.post("/api/settings/sync-bridge", json(), (_req: Request, res: Response) => {
  res.status(410).json({
    success: false,
    error: "雙向同步橋已停用；Supabase 與本地 SQLite 現為獨立資料來源",
  });
});

// Public diagnostics expose presence only; secret values never leave the server.
router.get("/api/settings", (_req: Request, res: Response) => {
  res.json({
    success: true,
    hasLongcatKey: Boolean(process.env.LONGCAT_API_KEY || process.env.VITE_LONGCAT_API_KEY),
    hasFinmindKey: Boolean(process.env.FINMIND_API_KEY || process.env.VITE_FINMIND_API_KEY),
    hasGeminiKey: Boolean(process.env.GEMINI_API_KEY),
    longcatModel: process.env.LONGCAT_MODEL || process.env.VITE_LONGCAT_MODEL || "LongCat-2.0",
  });
});

// API to update server-only settings in the local .env file.
router.post("/api/settings", json(), async (req: Request, res: Response) => {
  if (!isLoopbackRequest(req)) {
    return res.status(403).json({ success: false, error: "設定只能從本機修改" });
  }
  try {
    const updates: Record<string, string> = {};
    if (req.body.longcatApiKey) updates.LONGCAT_API_KEY = validateEnvValue("LongCat API key", req.body.longcatApiKey);
    if (req.body.finmindApiKey) updates.FINMIND_API_KEY = validateEnvValue("FinMind API key", req.body.finmindApiKey);
    if (req.body.longcatBaseUrl) updates.LONGCAT_BASE_URL = normalizeLongcatBaseUrl(req.body.longcatBaseUrl);
    if (req.body.longcatModel) {
      const model = validateEnvValue("LongCat model", req.body.longcatModel, 100);
      if (!/^[A-Za-z0-9._:-]+$/.test(model)) throw new Error("LongCat model 格式無效");
      updates.LONGCAT_MODEL = model;
    }
    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ success: false, error: "沒有可儲存的設定" });
    }
    updateEnvFile(updates);
    res.json({ success: true, message: "設定已安全儲存至本機 .env" });
  } catch (err: any) {
    console.error("Save settings error:", err);
    res.status(400).json({ success: false, error: err.message });
  }
});

export default router;

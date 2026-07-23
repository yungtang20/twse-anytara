import { Router, json, type NextFunction, type Request, type Response } from "express";
import fs from "fs";
import path from "path";
import { isLoopbackRequest, normalizeLongcatBaseUrl, validateEnvValue } from "../lib/security";
import { describeSupabaseError } from "../lib/supabaseDiagnostics";
import {
  pushTdccToSupabase,
  pushPriceToSupabase,
  pushInstitutionalToSupabase,
  pullPriceFromSupabase,
  pullInstitutionalFromSupabase,
  pullTdccFromSupabase,
  pruneSupabaseData,
} from "../lib/syncBridge";
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

-- 建立三大法人買賣超表
CREATE TABLE IF NOT EXISTS public.stock_institutional (
    stock_id TEXT NOT NULL,
    date TEXT NOT NULL,
    foreign_net BIGINT DEFAULT 0,
    trust_net BIGINT DEFAULT 0,
    dealer_net BIGINT DEFAULT 0,
    foreign_buy BIGINT DEFAULT 0,
    foreign_sell BIGINT DEFAULT 0,
    trust_buy BIGINT DEFAULT 0,
    trust_sell BIGINT DEFAULT 0,
    dealer_buy BIGINT DEFAULT 0,
    dealer_sell BIGINT DEFAULT 0,
    total_net BIGINT DEFAULT 0,
    PRIMARY KEY(stock_id, date)
);

-- 建立個股基本資料表
CREATE TABLE IF NOT EXISTS public.stock_meta (
    stock_id TEXT PRIMARY KEY,
    stock_name TEXT NOT NULL,
    industry_category TEXT,
    market TEXT,
    type TEXT,
    source TEXT,
    updated_at TIMESTAMPTZ DEFAULT now()
);

-- 建立個股特徵/指標與股權分散表
CREATE TABLE IF NOT EXISTS public.stock_features (
    stock_id TEXT NOT NULL,
    date TEXT NOT NULL,
    ma5 REAL,
    ma20 REAL,
    ma60 REAL,
    rsi14 REAL,
    macd REAL,
    macd_signal REAL,
    macd_hist REAL,
    volume_ma5 BIGINT,
    volume_ma20 BIGINT,
    bb_upper REAL,
    bb_middle REAL,
    bb_lower REAL,
    updated_at TIMESTAMPTZ DEFAULT now(),
    PRIMARY KEY(stock_id, date)
);

CREATE TABLE IF NOT EXISTS public.tdcc_shareholding (
    stock_id TEXT NOT NULL,
    date TEXT NOT NULL,
    total_shares BIGINT,
    whale_ratio REAL,
    retail_ratio REAL,
    source TEXT,
    updated_at TIMESTAMPTZ DEFAULT now(),
    PRIMARY KEY(stock_id, date)
);

-- 建立個股估值指標歷史紀錄表
CREATE TABLE IF NOT EXISTS public.stock_valuation (
    stock_id TEXT NOT NULL,
    date DATE NOT NULL,
    yield REAL,
    pe_ratio REAL,
    pb_ratio REAL,
    updated_at TIMESTAMPTZ DEFAULT now(),
    PRIMARY KEY (stock_id, date)
);

-- 建立個股信用交易/融資融券餘額表
CREATE TABLE IF NOT EXISTS public.stock_margin (
    stock_id TEXT NOT NULL,
    date DATE NOT NULL,
    margin_buy BIGINT,
    margin_sell BIGINT,
    margin_cash_redeem BIGINT,
    margin_balance BIGINT,
    short_buy BIGINT,
    short_sell BIGINT,
    short_balance BIGINT,
    updated_at TIMESTAMPTZ DEFAULT now(),
    PRIMARY KEY (stock_id, date)
);

-- 建立個股月營收表
CREATE TABLE IF NOT EXISTS public.stock_monthly_revenue (
    stock_id TEXT NOT NULL,
    year_month TEXT NOT NULL,
    month_revenue BIGINT,
    cumulative_revenue BIGINT,
    mom REAL,
    yoy REAL,
    updated_at TIMESTAMPTZ DEFAULT now(),
    PRIMARY KEY (stock_id, year_month)
);

-- 建立個股季度利潤表
CREATE TABLE IF NOT EXISTS public.stock_financials_quarter (
    stock_id TEXT NOT NULL,
    quarter_label TEXT NOT NULL,
    revenue BIGINT,
    net_income BIGINT,
    eps REAL,
    updated_at TIMESTAMPTZ DEFAULT now(),
    PRIMARY KEY (stock_id, quarter_label)
);`,
          message: "連線成功，但尚未建立完整的資料表。請在右側複製完整的 SQL 語句，到您的 Supabase SQL Editor 中貼上並執行即可！"
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
      message: "Supabase 連線成功且 `stock_price` 資料表配置完好！"
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
router.post("/api/settings/cleanup", async (_req: Request, res: Response) => {
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

  // Run in background
  (async () => {
    try {
      addSyncLog("開始執行 Supabase 免費額度 500MB 大空間優化修剪...");
      const result = await pruneSupabaseData(512, addSyncLog);
      addSyncLog(`\n✅ 清理完成！刪除普通股過期數據 ${result.deletedRegular} 筆，清理衍生權證標的 ${result.deletedWarrants} 檔。`);
      addLog('PRUNE', 'OK', `Deleted ${result.deletedRegular} price records and ${result.deletedWarrants} warrant meta.`);
    } catch (e: any) {
      debugState.activeSyncProcess.error = e.message;
      addSyncLog(`\n❌ 清理過程遭遇阻礙: ${e.message}`);
      addLog('PRUNE', 'ERROR', e.message);
    } finally {
      debugState.activeSyncProcess.running = false;
    }
  })();

  res.json({ success: true, message: "Supabase 修剪優化排程已於背景啟動，日誌將即時串流" });
});

// API to trigger bidirectional data sync bridge (push/pull)
router.post("/api/settings/sync-bridge", json(), async (req: Request, res: Response) => {
  const { mode, days = 30, dataType = "all" } = req.body;
  if (!supabase) {
    return res.status(400).json({ success: false, error: "Supabase 尚未連線，無法使用同步橋功能" });
  }

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

  (async () => {
    try {
      const isPush = mode === "push";
      addSyncLog(`🌉 啟動 雙向同步大橋 - [${isPush ? "SQLite → Supabase (上傳)" : "Supabase → SQLite (還原)"}] (指定天數: ${days} 天)`);
      
      const targetTypes = dataType === "all" ? ["price", "institutional", "tdcc"] : [dataType];

      for (const type of targetTypes) {
        if (type === "price") {
          addSyncLog(`📦 正在進行 [日K線收盤價] 資料組同步處理...`);
          if (isPush) {
            const { pushed } = await pushPriceToSupabase(days);
            addSyncLog(`   ✅ 日K線收盤價已成功上傳: ${pushed} 筆`);
          } else {
            const { pulled } = await pullPriceFromSupabase(days);
            addSyncLog(`   ✅ 日K線收盤價已成功還原: ${pulled} 筆`);
          }
        }
        else if (type === "institutional") {
          addSyncLog(`📦 正在進行 [三大法人籌碼] 資料組同步處理...`);
          if (isPush) {
            const { pushed } = await pushInstitutionalToSupabase(days);
            addSyncLog(`   ✅ 三大法人籌碼已成功上傳: ${pushed} 筆`);
          } else {
            const { pulled } = await pullInstitutionalFromSupabase(days);
            addSyncLog(`   ✅ 三大法人籌碼已成功還原: ${pulled} 筆`);
          }
        }
        else if (type === "tdcc") {
          addSyncLog(`📦 正在進行 [TDCC 集保股權分布] 資料組同步處理...`);
          const tdccDays = dataType === "all" ? 365 : days; // TDCC is weekly, sync 1 year when overall
          if (isPush) {
            const { pushed } = await pushTdccToSupabase(tdccDays);
            addSyncLog(`   ✅ TDCC 集保股權已成功上傳: ${pushed} 筆`);
          } else {
            const { pulled } = await pullTdccFromSupabase(tdccDays);
            addSyncLog(`   ✅ TDCC 集保股權已成功還原: ${pulled} 筆`);
          }
        }
      }

      addSyncLog(`\n🎉 本次雙向同步請求已完成；尚未執行全量一致性驗證。`);
    } catch (e: any) {
      debugState.activeSyncProcess.error = e.message;
      addSyncLog(`\n❌ 同步大橋遭遇阻礙: ${e.message}`);
      addLog('SYNC_BRIDGE', 'ERROR', e.message);
    } finally {
      debugState.activeSyncProcess.running = false;
    }
  })();

  res.json({ success: true, message: "雙向同步橋接工作已於背景啟動，日誌將即時串流" });
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

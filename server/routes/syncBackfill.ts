import { exec, spawn } from "child_process";
import { Router, json, type Request, type Response } from "express";
import { getDb } from "../db";
import { isLoopbackRequest } from "../lib/security";
import { scrapePriceFromYahoo } from "../lib/yahooPrice";
import { addLog, debugState, pushSyncLog } from "../services";

const router = Router();

// Daily sync and backfill routes remain here until the dedicated sync-router phase.
router.post("/api/sync-daily", (req: Request, res: Response) => {
  if (!isLoopbackRequest(req)) return res.status(403).json({ success: false, error: "同步只能從本機觸發" });
  const node = JSON.stringify(process.execPath);
  exec(`${node} node_modules/tsx/dist/cli.mjs scripts/syncData.ts && ${node} scripts/complete_and_fetch_today.js && ${node} node_modules/tsx/dist/cli.mjs scripts/prune_supabase.ts`, (error, stdout) => {
    if (error) {
      console.error(`Sync error: ${error}`);
      return res.status(500).json({ success: false, error: error.message });
    }
    addLog('SYNC', 'OK', `Supabase TS sync and Local SQLite sync complete.`);
    res.json({ success: true, log: stdout });
  });
});

// Client-safe Webhook proxy and local database sync
router.post("/api/trigger-update", async (req: Request, res: Response) => {
  if (!isLoopbackRequest(req)) return res.status(403).json({ success: false, error: "同步只能從本機觸發" });
  if (debugState.activeSyncProcess.running) {
    return res.json({
      success: true,
      message: "爬取與同步流程已在中途執行，同步日誌更新中...",
      alreadyRunning: true
    });
  }

  const webhookUrl = process.env.UPDATE_WEBHOOK_URL || process.env.VITE_UPDATE_WEBHOOK_URL;

  // Reset status block
  debugState.activeSyncProcess.running = true;
  debugState.activeSyncProcess.logs = [`[系統] ${new Date().toLocaleTimeString("zh-TW", { hour12: false })} 開始大盤行情同步程序...`];
  debugState.activeSyncProcess.startTime = new Date().toLocaleString("en-US", { timeZone: "Asia/Taipei" });
  debugState.activeSyncProcess.error = null;

  res.json({
    success: true,
    message: "大盤與個股實時同步指令已送達！即刻在背景啟動爬蟲對接...",
    alreadyRunning: false
  });

  // Execute background update tasks asynchronously
  (async () => {
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

    pushSyncLog(`[系統] 啟動本地 Python/Node.js 爬蟲對接。`);
    pushSyncLog(`[系統] 目標工作流程：從 Supabase 擷取並對接本地補登...`);

    const node = JSON.stringify(process.execPath);
    const child = spawn(`${node} scripts/pull_from_supabase.js && ${node} scripts/complete_and_fetch_today.js && ${node} node_modules/tsx/dist/cli.mjs scripts/prune_supabase.ts`, { shell: true, windowsHide: true });

    child.stdout.on("data", (data) => {
      const text = data.toString();
      const lines = text.split(/\r?\n/);
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed) {
          const time = new Date().toLocaleTimeString("zh-TW", { hour12: false });
          pushSyncLog(`[${time}] ${trimmed}`);
          addLog('SYNC_STAGE', 'INFO', trimmed);
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
        }
      }
    });

    child.on("close", (code) => {
      debugState.activeSyncProcess.running = false;
      const time = new Date().toLocaleTimeString("zh-TW", { hour12: false });
      if (code !== 0) {
        debugState.activeSyncProcess.error = `處理程序異常終止 (代碼: ${code})`;
        pushSyncLog(`\n[${time}] ❌ 行程異常結束。錯誤代碼: ${code}`);
        addLog('SYNC', 'ERROR', `Background sync process exited with code ${code}`);
      } else {
        pushSyncLog(`\n[${time}] ✅ 大盤實時爬蟲同步完成！本地 SQLite 資料庫已同步至最新。`);
        addLog('SYNC', 'OK', 'Database synchronized successfully with raw crawling stream.');
      }
    });
  })();
});

// GET Endpoint to poll sync progress
router.get("/api/sync-status", (req: Request, res: Response) => {
  if (!isLoopbackRequest(req)) return res.status(403).json({ success: false, error: "同步狀態只能從本機讀取" });
  const db = getDb();
  let latestDbDate = "";
  if (db) {
    try {
      const latestDbRow = db.prepare("SELECT MAX(date) as max_date FROM stock_price").get() as { max_date: string | null };
      latestDbDate = latestDbRow?.max_date || "";
    } catch { /* ignore */ }
  }
  res.json({
    success: true,
    running: debugState.activeSyncProcess.running,
    logs: debugState.activeSyncProcess.logs,
    startTime: debugState.activeSyncProcess.startTime,
    error: debugState.activeSyncProcess.error,
    latestDbDate
  });
});


router.post("/api/backfill-finmind", json(), async (req: Request, res: Response) => {
  if (!isLoopbackRequest(req)) return res.status(403).json({ success: false, error: "資料回補只能從本機觸發" });
  const db = getDb();
  if (!db) return res.status(500).json({ success: false, error: "Database not connected" });
  const { stockId, startDate, endDate, types = ["price", "institutional"], source = "scraper" } = req.body;
  
  if (!stockId) {
    return res.status(400).json({ success: false, error: "缺少 stockId (股票代號或批次組)" });
  }
  if (!startDate) {
    return res.status(400).json({ success: false, error: "缺少 startDate (開始日期, 格式: YYYY-MM-DD)" });
  }

  const token = process.env.FINMIND_API_KEY || process.env.VITE_FINMIND_API_KEY || "";
  
  let targetStockIds: string[] = [];
  if (Array.isArray(stockId)) {
    targetStockIds = stockId.map(id => String(id).trim()).filter(Boolean);
  } else if (typeof stockId === "string") {
    if (stockId === "ALL_META") {
      try {
        const rows = db.prepare("SELECT stock_id FROM stock_meta WHERE length(stock_id) = 4 AND stock_id NOT GLOB '*[A-Z]*' ORDER BY stock_id ASC LIMIT 100").all() as any[];
        targetStockIds = rows.map(r => r.stock_id);
      } catch (e: any) {
        return res.status(500).json({ success: false, error: "無法獲取庫存 stock_meta 列表: " + e.message });
      }
    } else {
      targetStockIds = stockId.split(/[\s,，]+/).map(id => id.trim()).filter(Boolean);
    }
  }

  if (targetStockIds.length === 0) {
    return res.status(400).json({ success: false, error: "無效的股票代號指定" });
  }

  let priceInsertedTotal = 0;
  let instInsertedTotal = 0;
  const logs: string[] = [];
  const maxBulkLimit = 150;

  if (targetStockIds.length > maxBulkLimit) {
    logs.push(`⚠️ 注意：由於 API 速率限制，已將此次批次數量自動安全調整為前 ${maxBulkLimit} 檔個股。`);
    targetStockIds = targetStockIds.slice(0, maxBulkLimit);
  }

  logs.push(`🔍 開始自 ${source === "scraper" ? "免費多源網路爬蟲" : "FinMind 官方 API"} 執行【自動批次歷史數據回補】! 共計偵測到 ${targetStockIds.length} 檔個股...`);
  logs.push(`📅 回補日期區間: ${startDate} 至 ${endDate || '今日'}`);

  try {
    for (let i = 0; i < targetStockIds.length; i++) {
      const id = targetStockIds[i];
      const progressStr = `[進度 ${i + 1}/${targetStockIds.length}] 股號 ${id}`;
      logs.push(`--------------------------------------`);
      logs.push(`🔄 正在下載對接 ${progressStr}...`);

      if (i > 0 && targetStockIds.length > 1) {
        await new Promise(resolve => setTimeout(resolve, 350));
      }

      // 1. Fetch Pricing
      if (types.includes("price")) {
        let priceData: any[] = [];
        let fetchedSource = "finmind";

        if (source === "scraper") {
          try {
            let market = "TSE";
            try {
              const metaRow = db.prepare("SELECT market FROM stock_meta WHERE stock_id = ?").get(id) as any;
              if (metaRow && metaRow.market) {
                market = metaRow.market;
              }
            } catch {}

            logs.push(`🌐 [爬蟲] 正在從 Yahoo Finance 爬取歷史 K 線...`);
            priceData = await scrapePriceFromYahoo(id, startDate, endDate, market);
            fetchedSource = "yahoo";
          } catch (err: any) {
            logs.push(`⚠️ [爬蟲] Yahoo 爬取失敗: ${err.message}，自動切換至 FinMind 免費接口...`);
            priceData = [];
          }
        }

        if (priceData.length === 0) {
          const urlPrice = `https://api.finmindtrade.com/api/v4/data?dataset=TaiwanStockPrice&data_id=${id}&start_date=${startDate}${endDate ? `&end_date=${endDate}` : ''}&token=${token}`;
          const resPrice = await fetch(urlPrice);
          if (!resPrice.ok) {
            logs.push(`❌ ${progressStr} 股價 API 回應錯誤: ${resPrice.status}`);
            continue;
          }
          const jsonPrice = await resPrice.json() as any;
          if (jsonPrice.data && jsonPrice.data.length > 0) {
            priceData = jsonPrice.data.map((r: any) => ({
              date: r.date,
              open: parseFloat(r.open) || 0,
              high: parseFloat(r.max) || 0,
              low: parseFloat(r.min) || 0,
              close: parseFloat(r.close) || 0,
              volume: parseInt(r.Trading_Volume, 10) || 0,
              amount: parseFloat(r.Trading_money) || 0,
              trade_count: parseInt(r.Trading_turnover, 10) || 0,
              spread: parseFloat(r.spread) || 0,
              adj_close: parseFloat(r.close) || 0
            }));
            fetchedSource = "finmind";
          }
        }

        if (priceData.length > 0) {
          const insertStmt = db.prepare(`
            INSERT OR REPLACE INTO stock_price (
              stock_id, date, open, high, low, close, volume, amount, trade_count, spread, adj_factor, adj_close, source
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1.0, ?, ?)
          `);
          
          let insertedInThisStock = 0;
          db.transaction(() => {
            for (const r of priceData) {
              insertStmt.run(
                id,
                r.date,
                r.open,
                r.high,
                r.low,
                r.close,
                r.volume,
                r.amount,
                r.trade_count,
                r.spread,
                r.adj_close,
                fetchedSource
              );
              insertedInThisStock++;
            }
          })();
          priceInsertedTotal += insertedInThisStock;
          logs.push(`📈 ${progressStr} 成功寫入 ${insertedInThisStock} 筆日股價 (來源: ${fetchedSource})。`);
        } else {
          logs.push(`⚠️ ${progressStr} 無可用的股價歷史數據。`);
        }
      }

      // 2. Fetch Institutional Sell/Buy
      if (types.includes("institutional")) {
        const urlInst = `https://api.finmindtrade.com/api/v4/data?dataset=TaiwanStockInstitutionalInvestorsBuySell&data_id=${id}&start_date=${startDate}${endDate ? `&end_date=${endDate}` : ''}&token=${token}`;
        const resInst = await fetch(urlInst);
        if (!resInst.ok) {
          logs.push(`❌ ${progressStr} 法人 API 回應錯誤: ${resInst.status}`);
          continue;
        }
        const jsonInst = await resInst.json() as any;
        if (jsonInst.data && jsonInst.data.length > 0) {
          const grouped: { [dateStr: string]: {
            foreign_buy: number; foreign_sell: number;
            trust_buy: number; trust_sell: number;
            dealer_buy: number; dealer_sell: number;
          } } = {};

          for (const item of jsonInst.data) {
            const d = item.date;
            if (!grouped[d]) {
              grouped[d] = {
                foreign_buy: 0, foreign_sell: 0,
                trust_buy: 0, trust_sell: 0,
                dealer_buy: 0, dealer_sell: 0
              };
            }
            const buy = parseInt(item.buy, 10) || 0;
            const sell = parseInt(item.sell, 10) || 0;
            const n = item.name;

            if (n === "Foreign_Investor") {
              grouped[d].foreign_buy += buy;
              grouped[d].foreign_sell += sell;
            } else if (n === "Investment_Trust") {
              grouped[d].trust_buy += buy;
              grouped[d].trust_sell += sell;
            } else if (n === "Dealer_self" || n === "Dealer_Hedging") {
              grouped[d].dealer_buy += buy;
              grouped[d].dealer_sell += sell;
            }
          }

          const insertInstStmt = db.prepare(`
            INSERT OR REPLACE INTO stock_institutional (
              stock_id, date, foreign_net, trust_net, dealer_net,
              foreign_buy, foreign_sell, trust_buy, trust_sell, dealer_buy, dealer_sell,
              institutional_net, source
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'finmind')
          `);

          let instInsertedInThisStock = 0;
          db.transaction(() => {
            for (const [dateStr, v] of Object.entries(grouped)) {
              const fNet = v.foreign_buy - v.foreign_sell;
              const tNet = v.trust_buy - v.trust_sell;
              const dNet = v.dealer_buy - v.dealer_sell;
              const instNet = fNet + tNet + dNet;

              insertInstStmt.run(
                id,
                dateStr,
                fNet,
                tNet,
                dNet,
                v.foreign_buy,
                v.foreign_sell,
                v.trust_buy,
                v.trust_sell,
                v.dealer_buy,
                v.dealer_sell,
                instNet
              );
              instInsertedInThisStock++;
            }
          })();
          instInsertedTotal += instInsertedInThisStock;
          logs.push(`👥 ${progressStr} 成功寫入 ${instInsertedInThisStock} 筆三大法人歷史。`);
        } else {
          logs.push(`⚠️ ${progressStr} 無可用的法人歷史數據。`);
        }
      }
    }

    try {
      const dates = db.prepare("SELECT DISTINCT date FROM stock_price ORDER BY date ASC").all() as any[];
      db.prepare("DELETE FROM stock_trading_calendar").run();
      
      if (dates.length > 0) {
        const tradingDatesSet = new Set(dates.map(d => d.date));
        const minDateStr = dates[0].date;
        const maxDateStr = dates[dates.length - 1].date;
        
        const start = new Date(minDateStr);
        const end = new Date(maxDateStr);
        
        const insertCalendar = db.prepare(`
          INSERT INTO stock_trading_calendar (date, is_open, source)
          VALUES (?, ?, 'finmind')
        `);
        
        db.transaction(() => {
          let current = new Date(start);
          while (current <= end) {
            const dateStr = current.toISOString().split('T')[0];
            const isOpen = tradingDatesSet.has(dateStr) ? 1 : 0;
            insertCalendar.run(dateStr, isOpen);
            current.setDate(current.getDate() + 1);
          }
        })();
        
        const totalCount = db.prepare("SELECT COUNT(*) as c FROM stock_trading_calendar").get().c;
        logs.push(`--------------------------------------`);
        logs.push(`📅 本地交易日曆已重新整合，共載入 ${totalCount} 個日曆天。`);
      } else {
        logs.push(`--------------------------------------`);
        logs.push(`⚠️ 未找到交易歷史，無法整合日曆。`);
      }
    } catch (calErr: any) {
      logs.push(`⚠️ 統整本地日曆時有警訊但非致命: ${calErr.message}`);
    }

    const summaryMsg = `🎉 自動批次對接成功！共回補了 ${targetStockIds.length} 檔個股 (股價: ${priceInsertedTotal} 筆, 法人: ${instInsertedTotal} 筆)`;
    addLog('BACKFILL', 'OK', summaryMsg);
    logs.push(`\n✅ ${summaryMsg}`);

    res.json({
      success: true,
      priceInserted: priceInsertedTotal,
      instInserted: instInsertedTotal,
      logs
    });
  } catch (err: any) {
    console.error("FinMind backfill error:", err);
    logs.push(`\n❌ 回補程序中斷: ${err.message}`);
    addLog('BACKFILL', 'ERROR', `FinMind batch backfill failed: ${err.message}`);
    res.json({
      success: false,
      error: err.message,
      logs
    });
  }
});


export default router;

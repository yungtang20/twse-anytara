import React, { useState, useEffect } from 'react';
import { Search, RotateCw, AlertTriangle, CheckCircle, ArrowUpRight, ArrowDownRight, Terminal as TerminalIcon, Database, ChartLine } from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { MarketDetailDashboard } from '../MarketDetailDashboard';
import { normalizeVolumes } from '../../lib/utils';

import { StockData } from '../../types/stock';
import { SRPanel } from "./SRPanel";
import { MAPanel } from "./MAPanel";
import { ChipsPanel } from "./ChipsPanel";
import { PatternPanel } from "./PatternPanel";

const getPrevTradingDayStr = (dateStr: string) => {
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return dateStr;
  d.setDate(d.getDate() - 1);
  if (d.getDay() === 0) { // Sunday, go to Friday
    d.setDate(d.getDate() - 2);
  } else if (d.getDay() === 6) { // Saturday, go to Friday
    d.setDate(d.getDate() - 1);
  }
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
};

export function MarketsView() {
  const [ticker, setTicker] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [stock, setStock] = useState<StockData | null>(null);
  const [activeSubTab, setActiveSubTab] = useState<'terminal' | 'kline'>('terminal');
  
  // Database Date states
  const [latestDate, setLatestDate] = useState('');
  const [updateLogs, setUpdateLogs] = useState<string[]>([]);
  const [isUpdating, setIsUpdating] = useState(false);
  const [showConsole, setShowConsole] = useState(false);

  // Supabase states for direct data queries
  const [supabaseLog, setSupabaseLog] = useState<string>('');
  const [dbLoading, setDbLoading] = useState(false);
  const [dbStatus, setDbStatus] = useState<{
    connected: boolean;
    tableName: string;
    rowCount: number | null;
    metaSource: string;
  }>({
    connected: false,
    tableName: 'stock_meta',
    rowCount: null,
    metaSource: '載入中...'
  });

  useEffect(() => {
    let activeInterval: NodeJS.Timeout | null = null;

    const checkStatus = async () => {
      try {
        const res = await fetch("/api/sync-status").then(r => r.json());
        if (res.success) {
          if (res.latestDbDate) {
            setLatestDate(res.latestDbDate);
          }
          if (res.running) {
            setIsUpdating(true);
            setShowConsole(true);
            if (res.logs && res.logs.length > 0) {
              setUpdateLogs(res.logs);
            }
            
            activeInterval = setInterval(async () => {
              try {
                const pollRes = await fetch("/api/sync-status").then(r => r.json());
                if (pollRes.success) {
                  if (pollRes.logs && pollRes.logs.length > 0) {
                    setUpdateLogs(pollRes.logs);
                  }
                  if (!pollRes.running) {
                    if (pollRes.latestDbDate) {
                      setLatestDate(pollRes.latestDbDate);
                    }
                    setIsUpdating(false);
                    if (activeInterval) {
                      clearInterval(activeInterval);
                      activeInterval = null;
                    }
                    setTimeout(() => setShowConsole(false), 3000);
                  }
                }
              } catch (e) {
                console.error("Error polling sync-status in effect:", e);
              }
            }, 1500);
          }
        }
      } catch (e) {
        console.error("Error checking sync-status on mount:", e);
      }
    };

    checkStatus();

    return () => {
      if (activeInterval) {
        clearInterval(activeInterval);
      }
    };
  }, []);

  useEffect(() => {
    if (searchQuery) {
      querySupabase(searchQuery);
    }
  }, [searchQuery]);

  const querySupabase = async (stockId: string) => {
    setDbLoading(true);
    setSupabaseLog(`[資料請求] 正在向伺服器 API 請求個股數據: ${stockId}...`);
    
    try {
      // 1. Fetch from unified API
      setSupabaseLog(prev => prev + `\n[連線] 呼叫 /api/stock/${stockId}/quote...`);
      
      const quoteRes = await fetch(`/api/stock/${stockId}/quote`).then(r => r.json());
      if (!quoteRes || !quoteRes.success || !quoteRes.data) {
          throw new Error('API 返回錯誤或無資料');
      }
      
      const quote = quoteRes.data;
      setSupabaseLog(prev => prev + `\n[對接匹配] 尋獲個股 metadata:\n> 代號: ${quote.stock_id}\n> 名稱: ${quote.name}\n> 市場: ${quote.market || 'TSE'}`);
      
      let mergedData: any = {
        id: quote.stock_id,
        name: quote.name || '未知',
        source_type: 'raw',
        close: quote.close,
        change: quote.change,
        changePercent: quote.changePercent,
        volume: quote.volume,
        prevClose: quote.prevClose,
        prevVolume: null,
        volDiff: 0,
        prevVolDiff: 0,
        chipHistory: [],
        predictions: [],
        integratedSupports: [],
        integratedPressures: []
      };
      
      setSupabaseLog(prev => prev + `\n[資料請求] 正在向伺服器 API 請求歷史數據...`);
      const histRes = await fetch(`/api/stock/${stockId}/history?days=3`).then(r => r.json());
      if (histRes && histRes.success && histRes.data && histRes.data.length > 0) {
          const priceData = histRes.data; // Note: API returns normalized volume
          setSupabaseLog(prev => prev + `\n[價格對接成功] 成功從 API 載入 ${priceData.length} 筆歷史交易資訊。`);
          
          const latestPrice = priceData[0];
          const prevPriceRec = priceData[1] || latestPrice;
          const prev2PriceRec = priceData[2] || prevPriceRec;

          setSupabaseLog(prev => prev + `\n[對照載入] 最新交易日期: ${latestPrice.date}，收盤: ${latestPrice.close}，開盤: ${latestPrice.open}，最高: ${latestPrice.high}，最低: ${latestPrice.low}，成交量: ${latestPrice.volume}`);

          const dateDiff = Math.abs((new Date(latestPrice.date).getTime() - new Date(prevPriceRec.date).getTime()) / (1000 * 60 * 60 * 24));
          const changePrev = Number(prevPriceRec.close || 0) - Number(prev2PriceRec.close || prevPriceRec.close);
          
          mergedData.prevChange = changePrev;
          mergedData.prevChangePercent = Number(prev2PriceRec.close || prevPriceRec.close) > 0 ? Number(((changePrev / Number(prev2PriceRec.close || prevPriceRec.close)) * 100).toFixed(2)) : 0;
          
          mergedData.volume = Math.floor(Number(latestPrice.volume || 0));
          mergedData.prevVolume = Math.floor(Number(prevPriceRec.volume || 0));
          const prev2Vol = Math.floor(Number(prev2PriceRec.volume || 0));
          
          mergedData.volDiff = mergedData.volume - mergedData.prevVolume;
          mergedData.prevVolDiff = mergedData.prevVolume - prev2Vol;
      }
      
      setDbStatus({
        connected: true,
        tableName: 'API: quote, history',
        rowCount: 1,
        metaSource: '已驗證'
      });
      
      setSupabaseLog(prev => prev + '\n[解析完成] 所有資料驗證無誤，渲染引擎啟動...');
      setStock(mergedData);
      
    } catch (err: any) {
      setSupabaseLog(prev => prev + `\n[系統崩潰] 連線失敗或找不到該股: ${err.message}`);
      setDbStatus({
        connected: false,
        tableName: 'N/A',
        rowCount: 0,
        metaSource: '無法取得資料'
      });
      setStock(null);
    } finally {
      setDbLoading(false);
    }
  };

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    if (ticker.trim()) {
      setSearchQuery(ticker.trim());
    }
  };

  const handleQuickSelect = (code: string) => {
    setTicker(code);
    setSearchQuery(code);
  };

  const triggerDailyUpdate = async () => {
    if (isUpdating) return;
    
    setIsUpdating(true);
    setShowConsole(true);
    setUpdateLogs(['[系統] 正在送達大盤實時同步指令...']);

    try {
      const res = await fetch("/api/trigger-update", { method: "POST" }).then(r => r.json());
      
      // Start polling for real-time logs
      const pollInterval = setInterval(async () => {
        try {
          const pollRes = await fetch("/api/sync-status").then(r => r.json());
          if (pollRes.success) {
            if (pollRes.logs && pollRes.logs.length > 0) {
              setUpdateLogs(pollRes.logs);
            }
            if (!pollRes.running) {
              clearInterval(pollInterval);
              if (pollRes.latestDbDate) {
                setLatestDate(pollRes.latestDbDate);
              }
              setIsUpdating(false);
              setTimeout(() => setShowConsole(false), 3000);
            }
          }
        } catch (e) {
          console.error("Error polling sync-status manually:", e);
        }
      }, 1500);

    } catch (e: any) {
      setUpdateLogs(prev => [...prev, `${new Date().toLocaleTimeString()} [錯誤] 啟動背景更新時發生例外: ${e.message}`]);
      setIsUpdating(false);
    }
  };

  // Center alignment for Header Box in CSS style
  const getASCIIHeaderBox = () => {
    const totalWidth = 63;
    const contentStr = stock ? `🚀 ${stock.id} ${stock.name}` : `🚀 Loading...`;
    const totalSpaces = totalWidth - contentStr.length;
    const leftSpaces = Math.max(1, Math.floor(totalSpaces / 2));
    const rightSpaces = Math.max(1, totalWidth - contentStr.length - leftSpaces);
    
    return (
      <div className="font-mono text-center tracking-wide select-none text-cyan-400 font-bold text-[11px] sm:text-[14px] md:text-[16px] leading-tight whitespace-pre overflow-x-auto bg-slate-950 p-2 sm:p-4 rounded-t-xl border-t border-x border-slate-800">
        {`╔${"═".repeat(totalWidth)}╗\n║${" ".repeat(leftSpaces)}${contentStr}${" ".repeat(rightSpaces)}║\n╚${"═".repeat(totalWidth)}╝`}
      </div>
    );
  };

  return (
    <div className="flex flex-col gap-2.5 font-sans">
      {/* 1. 頂部搜尋與快速選擇 */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-3 flex flex-col md:flex-row md:items-center justify-between gap-2">
        <div className="space-y-1">
          <h2 className="text-xl sm:text-2xl font-bold text-white tracking-tight flex items-center gap-2">
            <TerminalIcon className="text-cyan-500" size={24} />
            AI 精準個股終端
          </h2>
          <p className="text-slate-450 text-xs sm:text-sm">
            輸入上市櫃個股代號，即時編譯 5 大決策要素與 AI 模擬預估圖表。
          </p>
        </div>

        <form onSubmit={handleSearch} className="relative w-full md:w-72" id="stock-search-form">
          <input
            type="text"
            value={ticker}
            onChange={(e) => setTicker(e.target.value)}
            placeholder="搜尋股票代號 (例如: 2330)"
            className="w-full bg-slate-950 border border-slate-700 rounded-lg pl-10 pr-20 py-2.5 text-xs sm:text-sm text-slate-200 outline-none focus:border-cyan-500 transition-colors placeholder:text-slate-500 font-mono"
            id="stock-search-input"
          />
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" size={16} />
          <button 
            type="submit"
            className="absolute right-2 top-1/2 -translate-y-1/2 text-xs bg-cyan-500/20 text-cyan-400 px-3 py-1.5 rounded-md font-semibold hover:bg-cyan-500/35 transition-colors border border-cyan-500/30 font-mono"
            id="stock-search-submit"
          >
            COMPILE
          </button>
        </form>
      </div>

      {/* 2. 資料庫更新警報與日誌 */}
      <div className="flex flex-col gap-3">
        {(!latestDate || latestDate < getPrevTradingDayStr(new Date().toISOString())) ? (
          <div className="bg-amber-950/40 border border-amber-900/60 rounded-xl p-2.5 flex flex-col sm:flex-row sm:items-center justify-between gap-2">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-amber-500/10 text-amber-500 shrink-0">
                <AlertTriangle size={20} />
              </div>
              <div className="space-y-0.5">
                <p className="text-sm font-semibold text-amber-300">資料庫最新日期為 {latestDate || '尚無資料'}</p>
                <p className="text-xs text-amber-400">目前數據與官方交易所今日最新交易盤後資訊存有落差，建議先執行更新。</p>
              </div>
            </div>
            <button
              onClick={triggerDailyUpdate}
              disabled={isUpdating}
              className="text-xs shrink-0 font-bold bg-amber-600 hover:bg-amber-500 text-slate-950 px-4 py-2 rounded-lg flex items-center gap-2 transition-all shadow-md self-start sm:self-center disabled:opacity-50"
              id="btn-daily-update"
            >
              <RotateCw className={`w-3.5 h-3.5 ${isUpdating ? 'animate-spin' : ''}`} />
              執行每日更新
            </button>
          </div>
        ) : (
          <div className="bg-emerald-950/40 border border-emerald-900/60 rounded-xl p-2.5 flex items-center justify-between gap-2">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-emerald-500/10 text-emerald-400 shrink-0">
                <CheckCircle size={20} />
              </div>
              <div className="space-y-0.5">
                <p className="text-sm font-semibold text-emerald-300">資料庫最新日期已同步至 {latestDate}（今日盤後）</p>
                <p className="text-xs text-emerald-400/80">
                  全盤日終開放數據、法人持股日報、均線交叉指標已校對至最新。
                </p>
              </div>
            </div>
            <span className="text-[10px] uppercase font-bold tracking-wider font-mono text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 px-2 py-0.5 rounded shadow-sm">
              UP-TO-DATE
            </span>
          </div>
        )}

        {/* 模擬更新控制台日誌 */}
        <AnimatePresence>
          {showConsole && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              className="bg-slate-950 border border-slate-850 rounded-xl overflow-hidden shadow-2xl font-mono"
            >
              <div className="bg-slate-900 py-2.5 px-4 flex items-center justify-between border-b border-slate-850 text-xs text-slate-400">
                <span className="flex items-center gap-1.5 font-bold">
                  <span className="w-2.5 h-2.5 rounded-full bg-red-500 animate-pulse"></span>
                  STATION DATA-SYNC CONSOLE
                </span>
                <span className="text-xs">SYSTEM CLOCK: {new Date().toLocaleTimeString()}</span>
              </div>
              <div className="p-4 overflow-y-auto max-h-[160px] text-xs space-y-1.5 scrollbar-thin scrollbar-thumb-slate-800 scrollbar-track-slate-950">
                {updateLogs.map((log, index) => (
                  <div key={index} className="text-slate-350 flex gap-2">
                    <span className="text-cyan-500 shrink-0">&gt;</span>
                    {log.includes('完成') ? (
                      <span className="text-emerald-400 font-bold">{log}</span>
                    ) : log.includes('下載') ? (
                      <span className="text-slate-300">{log}</span>
                    ) : (
                      <span className="text-slate-450">{log}</span>
                    )}
                  </div>
                ))}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* 3. 股票分析資訊總頁 (Terminal Classic Style) */}
      {!searchQuery ? (
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 flex flex-col items-center justify-center min-h-[180px]">
          <ChartLine className="text-cyan-500 mb-4 animate-pulse" size={48} />
          <h3 className="text-white text-lg font-bold mb-2 tracking-widest uppercase font-mono">[ 歡迎使用個股決策終端 ]</h3>
          <p className="text-slate-400 text-center text-sm max-w-md">
            請在上方搜尋欄位中輸入上市櫃股票代號（例如: <span className="text-cyan-400 font-mono">2330</span>），即可一鍵編譯五大決策要素與 AI 模擬預估。
          </p>
        </div>
      ) : !stock ? (
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 flex flex-col items-center justify-center min-h-[160px]">
          <AlertTriangle className="text-amber-500 mb-4" size={48} />
          <h3 className="text-white text-lg font-bold mb-2 tracking-widest">NO DATA AVAILABLE</h3>
          <p className="text-slate-400 text-center text-sm max-w-md">
            目前無法獲取「{searchQuery}」的真實數據。根據系統指令，禁止顯示模擬或虛假資料。<br/>
            請檢查本地資料庫或 Supabase 連線，並確認該股代號是否存在於歷史紀錄中。
          </p>
        </div>
      ) : (
        <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden shadow-lg hover:border-slate-750 transition-all">
          {/* Monospaced Ascii-bordered title card */}
          {getASCIIHeaderBox()}

          {/* 1. 專業互動 K 線圖與法人、大戶整合面板 */}
          <div className="p-3 bg-slate-950/60 border-b border-slate-850/80">
            <div className="flex items-center gap-2 mb-4">
              <ChartLine size={18} className="text-cyan-400 animate-pulse" />
              <h4 className="text-xs sm:text-sm font-bold text-slate-200 uppercase tracking-wider font-mono">
                [PANEL] 專業互動 K 線圖 · 法人買賣超 · 大戶集保持股 (REALTIME CHART COCKPIT)
              </h4>
            </div>
            
            <div>
              <MarketDetailDashboard stockId={stock.id} />
            </div>
          </div>

          {/* 雙重歷史股價摘要比較盒 */}
          <div className="bg-slate-950/65 px-3 py-3 font-mono select-none border-b border-slate-800/80">
          <div className="max-w-xl mx-auto border border-dashed border-slate-800 p-2.5 rounded-lg bg-slate-950 text-xs sm:text-sm leading-relaxed overflow-x-auto text-slate-400">
            <div className="grid grid-cols-2 gap-4 divide-x divide-slate-800 text-[11px] sm:text-xs">
              <div className="space-y-1.5">
                <div className="text-slate-450 font-bold">收盤 {stock.lastDate}</div>
                <div>
                  股價：
                  <span className="text-white font-bold text-sm sm:text-base">{stock.price?.toFixed(2) ?? '---'} </span>
                  <span className={`font-bold ${(stock.change ?? 0) >= 0 ? 'text-red-500' : 'text-emerald-400'}`}>
                    {(stock.change ?? 0) >= 0 ? '▲' : '▼'}{(stock.changePercent !== undefined && stock.changePercent !== null) ? Math.abs(stock.changePercent).toFixed(1) : '---'}%({stock.change?.toFixed(2) ?? '---'})
                  </span>
                </div>
                <div>
                  張數：
                  <span className="text-white font-semibold">{stock.volume?.toLocaleString() ?? '---'}張 </span>
                  <span className={`font-medium ${(stock.volDiff ?? 0) >= 0 ? 'text-red-500' : 'text-emerald-400'}`}>
                    (差{(stock.volDiff ?? 0) >= 0 ? '+' : ''}{stock.volDiff?.toLocaleString() ?? '---'})
                  </span>
                </div>
              </div>

              <div className="pl-4 space-y-1.5">
                <div className="text-slate-450 font-bold">歷史 {stock.histDate}</div>
                <div>
                  股價：
                  <span className="text-white font-bold text-sm sm:text-base">{stock.prevPrice?.toFixed(2) ?? '---'} </span>
                  <span className={`font-bold ${(stock.prevChange ?? 0) >= 0 ? 'text-red-500' : 'text-emerald-400'}`}>
                    {(stock.prevChange ?? 0) >= 0 ? '▲' : '▼'}{(stock.prevChangePercent !== undefined && stock.prevChangePercent !== null) ? Math.abs(stock.prevChangePercent).toFixed(1) : '---'}%({stock.prevChange?.toFixed(2) ?? '---'})
                  </span>
                </div>
                <div>
                  張數：
                  <span className="text-white font-semibold">{stock.prevVolume?.toLocaleString() ?? '---'}張 </span>
                  <span className={`font-medium ${(stock.prevVolDiff ?? 0) >= 0 ? 'text-red-500' : 'text-emerald-400'}`}>
                    (差{(stock.prevVolDiff ?? 0) >= 0 ? '+' : ''}{stock.prevVolDiff?.toLocaleString() ?? '---'})
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* REPLACED WITH REAL PANELS */}
        <div className="p-3 grid grid-cols-[repeat(auto-fit,minmax(320px,1fr))] gap-3 bg-slate-900 text-slate-300">
          <div className="space-y-3">
            <SRPanel stockId={stock.id} />
            <MAPanel stockId={stock.id} change={stock.change ?? 0} changePercent={stock.changePercent ?? 0} />
            <PatternPanel stockId={stock.id} />
          </div>
          <div className="space-y-3">
            <ChipsPanel stockId={stock.id} />
          </div>
        </div>

        {/* Footer command bar */}
        <div className="bg-slate-950 border-t border-slate-800/80 px-3 py-2 flex flex-col sm:flex-row items-center justify-between gap-2 text-xs text-slate-450 font-mono">
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded bg-cyan-400 animate-ping"></span>
            <span>指令就緒。按 <kbd className="bg-slate-900 border border-slate-750 px-1 py-0.5 rounded text-slate-200">Enter</kbd> 重新編譯數據表...</span>
          </div>
          <div>
            TRINITY SYSTEM CORE STATE: <span className="text-emerald-400">ACTIVE</span> (v1.8.2-twd-ai)
          </div>
        </div>
      </div>
      )}
    </div>
  );
}

import React, { useState, useEffect } from 'react';
import { Search, AlertTriangle, Terminal as TerminalIcon, ChartLine } from "lucide-react";
import { MarketDetailDashboard } from '../MarketDetailDashboard';
import { CompanyFinancialAnalysis } from '../CompanyFinancialAnalysis';

import { StockData } from '../../types/stock';
import { SRPanel } from "./SRPanel";
import { MAPanel } from "./MAPanel";
import { ChipsPanel } from "./ChipsPanel";
import { PatternPanel } from "./PatternPanel";

export function MarketsView() {
  const [ticker, setTicker] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [stock, setStock] = useState<StockData | null>(null);

  useEffect(() => {
    if (searchQuery) {
      querySupabase(searchQuery);
    }
  }, [searchQuery]);

  const querySupabase = async (stockId: string) => {
    try {
      const quoteRes = await fetch(`/api/stock/${stockId}/quote`).then(r => r.json());
      if (!quoteRes || !quoteRes.success || !quoteRes.data) {
          throw new Error('API 返回錯誤或無資料');
      }
      
      const quote = quoteRes.data;
      let mergedData: any = {
        id: quote.stock_id,
        name: quote.name || '未知',
        source_type: 'raw',
        price: Number(quote.close || 0),
        change: quote.change,
        changePercent: quote.changePercent,
        volume: Math.floor(Number(quote.volume || 0) / 1000),
        prevPrice: Number(quote.prevClose || quote.close || 0),
        prevVolume: 0,
        volDiff: 0,
        prevVolDiff: 0,
        lastDate: quote.date || '',
        histDate: '',
        chipHistory: [],
        predictions: [],
        integratedSupports: [],
        integratedPressures: []
      };
      
      const histRes = await fetch(`/api/stock/${stockId}/history?days=3`).then(r => r.json());
      if (histRes && histRes.success && histRes.data && histRes.data.length > 0) {
          const priceData = histRes.data; // Note: API returns normalized volume
          
          const latestPrice = priceData.at(-1);
          const prevPriceRec = priceData.at(-2) || latestPrice;
          const prev2PriceRec = priceData.at(-3) || prevPriceRec;
          if (!latestPrice || !prevPriceRec || !prev2PriceRec) {
            throw new Error('歷史價格筆數不足');
          }

          const changePrev = Number(prevPriceRec.close || 0) - Number(prev2PriceRec.close || prevPriceRec.close);

          mergedData.price = Number(latestPrice.close || quote.close || 0);
          mergedData.prevPrice = Number(prevPriceRec.close || latestPrice.close || 0);
          mergedData.lastDate = String(latestPrice.date || quote.date || '');
          mergedData.histDate = String(prevPriceRec.date || '');
          mergedData.prevChange = changePrev;
          mergedData.prevChangePercent = Number(prev2PriceRec.close || prevPriceRec.close) > 0 ? Number(((changePrev / Number(prev2PriceRec.close || prevPriceRec.close)) * 100).toFixed(2)) : 0;

          mergedData.volume = Math.floor(Number(latestPrice.volume || 0) / 1000);
          mergedData.prevVolume = Math.floor(Number(prevPriceRec.volume || 0) / 1000);
          const prev2Vol = Math.floor(Number(prev2PriceRec.volume || 0) / 1000);

          mergedData.volDiff = mergedData.volume - mergedData.prevVolume;
          mergedData.prevVolDiff = mergedData.prevVolume - prev2Vol;
      }
      
      setStock(mergedData);
      
    } catch (err: any) {
      console.error(`Stock query failed for ${stockId}:`, err);
      setStock(null);
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

  const getASCIIHeaderBox = () => {
    if (!stock) return null;
    return (
      <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1 rounded-t-xl border-x border-t border-slate-800 bg-slate-950 px-3 py-3 text-center font-mono font-bold tracking-wide">
        <span className="text-sm text-cyan-400 sm:text-base">{stock.id} {stock.name}</span>
        <span className="text-[11px] text-slate-400 sm:text-sm">
          Supabase 資料庫日期 <strong className="text-emerald-400">{stock.lastDate || '無資料'}</strong>
        </span>
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
            輸入上市櫃個股代號，即時載入 Supabase 個股決策資料與整合圖表。
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

      {/* 2. 股票分析資訊總頁 (Terminal Classic Style) */}
      {!searchQuery ? (
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 flex flex-col items-center justify-center min-h-[180px]">
          <ChartLine className="text-cyan-500 mb-4 animate-pulse" size={48} />
          <h3 className="text-white text-lg font-bold mb-2 tracking-widest uppercase font-mono">[ 歡迎使用個股決策終端 ]</h3>
          <p className="text-slate-400 text-center text-sm max-w-md">
            請在上方搜尋欄位中輸入上市櫃股票代號（例如: <span className="text-cyan-400 font-mono">2330</span>），即可載入個股決策資料。
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

          <CompanyFinancialAnalysis stockId={stock.id} />

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
        <div className="flex flex-col gap-3 bg-slate-900 p-3 text-slate-300">
          <SRPanel stockId={stock.id} />
          <MAPanel stockId={stock.id} change={stock.change ?? 0} changePercent={stock.changePercent ?? 0} />
          <ChipsPanel stockId={stock.id} />
          <PatternPanel stockId={stock.id} />
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

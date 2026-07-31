import React, { useState, useEffect } from 'react';
import { KlineChart } from './KlineChart';
import {
  backfillStockShareholding,
  fetchStockHistory,
  fetchStockInstitutional,
  fetchStockShareholding,
  type DataQuality,
  type InstitutionalRow,
  type PriceData,
  type ShareholdingRow,
} from '../lib/api';
import { ShieldAlert, CheckCircle2, RefreshCw } from 'lucide-react';

interface MarketDetailDashboardProps {
  stockId: string;
}

export function MarketDetailDashboard({ stockId }: MarketDetailDashboardProps) {
  const [priceData, setPriceData] = useState<PriceData[]>([]);
  const [instData, setInstData] = useState<InstitutionalRow[]>([]);
  const [shareholding, setShareholding] = useState<ShareholdingRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [hasDataIssue, setHasDataIssue] = useState(false);
  const [quality, setQuality] = useState<DataQuality | null>(null);
  const [tdccBackfilling, setTdccBackfilling] = useState(false);
  const [tdccMessage, setTdccMessage] = useState('');

  const backfillTdcc = async () => {
    setTdccBackfilling(true);
    setTdccMessage('正在從集保官方網頁回補 52 週...');
    try {
      const inserted = await backfillStockShareholding(stockId);
      const whales = await fetchStockShareholding(stockId);
      setShareholding(whales.data);
      setTdccMessage(inserted > 0 ? `已新增 ${inserted} 週集保資料` : '集保一年資料已完整');
    } catch (error) {
      setTdccMessage(error instanceof Error ? error.message : '集保歷史回補失敗');
    } finally {
      setTdccBackfilling(false);
    }
  };

  useEffect(() => {
    if (!stockId) return;
    setLoading(true);
    const loadData = async () => {
      try {
        const [prices, insts, whales] = await Promise.all([
          fetchStockHistory(stockId, 1000),
          fetchStockInstitutional(stockId),
          fetchStockShareholding(stockId),
        ]);

        setPriceData(prices.data);
        setHasDataIssue(prices.data.length === 0 || prices.quality.isMock || prices.quality.isStale || prices.quality.warnings.length > 0);
        setQuality(prices.quality);
        setInstData(insts.data);
        setShareholding(whales.data);
      } catch (err) {
        console.error("Failed to load stock data in MarketDetailDashboard via API:", err);
      } finally {
        setLoading(false);
      }
    };

    loadData();
  }, [stockId]);

  if (loading) {
    return (
      <div className="bg-slate-950/60 border border-slate-850 rounded-xl p-4 flex flex-col items-center justify-center min-h-[180px]">
        <div className="w-8 h-8 border-2 border-cyan-400 border-t-transparent rounded-full animate-spin mb-3" />
        <span className="text-slate-400 text-xs font-mono">[DASHBOARD] LOADING REALTIME DATA COCKPIT...</span>
      </div>
    );
  }

  return (
    <div className="bg-slate-950/40 border border-slate-900 rounded-xl p-3 flex flex-col gap-3 shadow-xl">
      {/* 數據狀態條 */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2 bg-slate-900/60 border border-slate-800 rounded-lg px-3 py-2 text-xs">
        <div className="flex items-center gap-2">
          <div className={`w-2 h-2 rounded-full ${hasDataIssue ? 'bg-amber-400 animate-pulse' : 'bg-emerald-500 animate-pulse'}`} />
          <span className="text-slate-300 font-medium">
            市場數據庫：{hasDataIssue ? '實體資料缺失、過期或不足' : `${quality?.source || 'unknown'} 實體資料`}
          </span>
        </div>
        {hasDataIssue && (
          <div className="text-[10px] text-amber-400 flex items-center gap-1 bg-amber-400/10 border border-amber-400/20 px-2 py-0.5 rounded">
            <ShieldAlert size={12} />
            系統未生成替代行情
          </div>
        )}
        {!hasDataIssue && quality && (
          <div className={`text-[10px] flex items-center gap-1 px-2 py-0.5 rounded border ${quality.isStale || quality.warnings.length ? 'text-amber-400 bg-amber-400/10 border-amber-400/20' : 'text-emerald-400 bg-emerald-400/10 border-emerald-400/20'}`}>
            {quality.asOf ? `截至 ${quality.asOf}` : '無資料日期'}
            {quality.isStale && ' · 資料可能過期'}
            {quality.warnings.length > 0 && ` · ${quality.warnings.join(', ')}`}
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 text-[10px]">
        <span className="font-mono text-slate-500">
          K 線、成交量、外資、投信與千戶大戶已共用日期範圍
        </span>
        <div className="flex items-center gap-2">
          {tdccMessage && <span className="text-slate-400">{tdccMessage}</span>}
          <button
            type="button"
            onClick={backfillTdcc}
            disabled={tdccBackfilling}
            className="flex items-center gap-1.5 rounded-md border border-cyan-500/30 bg-cyan-500/10 px-2.5 py-1.5 font-bold text-cyan-300 disabled:opacity-50"
          >
            <RefreshCw size={12} className={tdccBackfilling ? 'animate-spin' : ''} />
            {tdccBackfilling ? '回補中' : '從集保網頁補一年'}
          </button>
        </div>
      </div>

      <div className="relative min-h-[300px]">
        {priceData.length > 0 ? (
          <div className="flex flex-col gap-2">
            <KlineChart
              data={priceData}
              institutional={instData}
              shareholding={shareholding}
            />
            {!hasDataIssue && (
              <div className="flex items-center justify-end gap-1.5 pr-1 font-mono text-[10px] text-slate-500">
                <CheckCircle2 size={12} className="text-emerald-500" />
                已整合 {priceData.length} 根日 K、{instData.length} 個法人交易日與 {shareholding.length} 週 TDCC。
              </div>
            )}
          </div>
        ) : (
          <div className="bg-slate-900/40 border border-slate-850/60 rounded-xl py-6 flex flex-col items-center justify-center text-center">
            <span className="text-slate-500 text-xs font-mono">無歷史交易數據，請前往策略分析分頁進行一鍵同步</span>
          </div>
        )}
      </div>
    </div>
  );
}

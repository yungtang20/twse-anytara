import React, { useState, useEffect } from 'react';
import { KlineChart } from './KlineChart';
import { fetchStockHistory, fetchStockInstitutional, fetchStockShareholding, type DataQuality } from '../lib/api';
import { ChipsBarChart } from './ChipsBarChart';
import { BarChart3, TrendingUp, Users, ShieldAlert, CheckCircle2, ShieldCheck } from 'lucide-react';

interface MarketDetailDashboardProps {
  stockId: string;
}

export function MarketDetailDashboard({ stockId }: MarketDetailDashboardProps) {
  const [activeTab, setActiveTab] = useState<'kline' | 'institutional' | 'shareholding'>('kline');
  const [priceData, setPriceData] = useState<any[]>([]);
  const [instData, setInstData] = useState<any[]>([]);
  const [shareholding, setShareholding] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [hasDataIssue, setHasDataIssue] = useState(false);
  const [quality, setQuality] = useState<DataQuality | null>(null);

  useEffect(() => {
    if (!stockId) return;
    setLoading(true);

    const loadData = async () => {
      try {
        const [prices, insts, whales] = await Promise.all([
          fetchStockHistory(stockId, 1000),
          fetchStockInstitutional(stockId),
          fetchStockShareholding(stockId)
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

      {/* 專業 Tab 切換 */}
      <div className="flex bg-slate-900/80 p-1 rounded-lg border border-slate-850 gap-1">
        {[
          { id: 'kline', label: '技術 K 線圖', icon: TrendingUp },
          { id: 'institutional', label: '三大法人籌碼', icon: Users, count: instData.length },
          { id: 'shareholding', label: '千戶大戶比例', icon: ShieldCheck, count: shareholding.length }
        ].map(tab => {
          const Icon = tab.icon;
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id as any)}
              className={`flex-1 flex items-center justify-center gap-1.5 py-2.5 px-3 rounded-md text-xs font-bold transition-all ${
                isActive
                  ? 'bg-cyan-500/15 text-cyan-400 border border-cyan-500/35 shadow-sm'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800 border border-transparent'
              }`}
            >
              <Icon size={14} className={isActive ? 'text-cyan-400 animate-pulse' : 'text-slate-500'} />
              <span>{tab.label}</span>
              {tab.count !== undefined && tab.count > 0 && (
                <span className={`px-1.5 py-0.5 text-[9px] rounded-full font-mono ${isActive ? 'bg-cyan-500/20 text-cyan-300' : 'bg-slate-850 text-slate-500'}`}>
                  {tab.count}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* 圖表展示區 */}
      <div className="relative min-h-[300px]">
        {activeTab === 'kline' && (
          <div className="flex flex-col gap-2">
            {priceData.length > 0 ? (
              <>
                <KlineChart data={priceData} />
                {!hasDataIssue && (
                  <div className="flex items-center justify-end gap-1.5 text-[10px] text-slate-500 pr-1 mt-1 font-mono">
                    <CheckCircle2 size={12} className="text-emerald-500" />
                    已成功解析 {priceData.length} 根日 K 棒。支持成交量與技術指標自適應縮放。
                  </div>
                )}
              </>
            ) : (
              <div className="bg-slate-900/40 border border-slate-850/60 rounded-xl py-6 flex flex-col items-center justify-center text-center">
                <span className="text-slate-500 text-xs font-mono">無歷史交易數據，請前往策略分析分頁進行一鍵同步</span>
              </div>
            )}
          </div>
        )}

        {activeTab === 'institutional' && (
          <ChipsBarChart
            chipHistory={instData.map(r => ({ date: r.date, foreign: r.foreign_net, trust: r.trust_net }))}
            shareholding={[]}
            viewMode="institutional"
          />
        )}

        {activeTab === 'shareholding' && (
          <ChipsBarChart
            chipHistory={[]}
            shareholding={shareholding}
            viewMode="shareholding"
          />
        )}
      </div>
    </div>
  );
}

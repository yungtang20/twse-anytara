import { useState, useEffect } from 'react';
import { fetchPatternAnalysis, type PatternAnalysis } from '../../lib/api';

interface PatternPanelProps {
  stockId: string;
}

export function PatternPanel({ stockId }: PatternPanelProps) {
  const [data, setData] = useState<PatternAnalysis | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!stockId) return;
    setLoading(true);
    fetchPatternAnalysis(stockId)
      .then(setData)
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  }, [stockId]);

  return (
    <div className="bg-slate-950/50 border border-slate-800 rounded-xl p-3 hover:border-slate-700/80 transition-all font-mono text-xs sm:text-[13px]">
      <h3 className="text-sm sm:text-base font-bold text-white mb-4 flex items-center gap-2 border-b border-slate-800 pb-2">
        <span className="font-mono text-cyan-400 select-none">4 ⚡</span>
        幾何型態 (Chart Patterns)
      </h3>

      {loading && <div className="text-slate-500 text-center py-4 text-xs">分析中...</div>}
      {!loading && !data && <div className="text-slate-500 text-center py-4 text-xs">無資料</div>}

      {data && <PatternResultCard data={data} />}
    </div>
  );
}

function PatternResultCard({ data }: { data: PatternAnalysis }) {
  if (data.stage === 'none') return (
    <div className="rounded-lg border border-slate-850 bg-slate-950 p-3 text-slate-500">
      最近 10 根內未偵測到正在形成或剛確認的 W／M 型態。
    </div>
  );
  const directionClass = data.patternDirection === 'up' ? 'text-red-400' : 'text-emerald-400';
  const pivotLabel = data.patternDirection === 'up' ? '底' : '頂';
  return <div className="rounded-lg border border-slate-850 bg-slate-950 p-3">
    <div className="mb-3 flex flex-wrap items-center gap-2">
      <strong className={`text-base ${directionClass}`}>{data.patternName}</strong>
      <span className="rounded border border-slate-700 px-1.5 py-0.5 text-[10px] text-cyan-300">
        {data.stage === 'confirmed' ? '已確認' : '形成中'}
      </span>
      <span className="text-[10px] text-slate-500">信心度 {(data.confidence * 100).toFixed(0)}%</span>
    </div>
    <div className="grid grid-cols-3 gap-2 border-b border-slate-800 pb-3 text-slate-400">
      <PriceMetric label="頸線" value={data.neckline} color="text-slate-100" />
      <PriceMetric label={data.stage === 'confirmed' ? '目標' : '突破後目標'} value={data.target} color="text-cyan-300" />
      <PriceMetric label="ATR 停損" value={data.stopLoss} color="text-rose-400" />
    </div>
    <div className="grid grid-cols-1 gap-1.5 pt-3 text-[11px] text-slate-400 sm:grid-cols-3">
      <PivotMetric label={`第一${pivotLabel}`} point={data.firstPivot} />
      <PivotMetric label="中間頸線點" point={data.middlePivot} />
      <PivotMetric label={`第二${pivotLabel}`} point={data.secondPivot} />
    </div>
    <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[10px] text-slate-500">
      <span>距頸線 {signedPercent(data.distanceToNecklinePct)}</span>
      <span>ATR14 {data.atr14?.toFixed(2) ?? '--'}</span>
      {data.breakoutDate && <span>確認日 {data.breakoutDate}</span>}
      {data.volumeRatio !== null && <span>量比 {data.volumeRatio.toFixed(2)}x</span>}
    </div>
  </div>;
}

function PriceMetric({ label, value, color }: { label: string; value: number | null; color: string }) {
  return <div><div>{label}</div><strong className={color}>{value?.toFixed(2) ?? '--'}</strong></div>;
}

function PivotMetric({ label, point }: { label: string; point: { date: string; price: number } | null }) {
  return <div><span>{label}</span> <b className="text-slate-200">{point ? `${point.date} · ${point.price.toFixed(2)}` : '--'}</b></div>;
}

function signedPercent(value: number | null) {
  return value === null ? '--' : `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`;
}

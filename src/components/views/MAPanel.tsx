import { useState, useEffect } from 'react';
import { ArrowUpRight, ArrowDownRight } from 'lucide-react';
import { fetchMAAnalysis, type MAAnalysis } from '../../lib/api';

interface MAPanelProps {
  stockId: string;
  change: number;
  changePercent: number;
}

export function MAPanel({ stockId, change, changePercent }: MAPanelProps) {
  const [data, setData] = useState<MAAnalysis | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!stockId) return;
    setLoading(true);
    fetchMAAnalysis(stockId)
      .then(setData)
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  }, [stockId]);

  const TrendIcon = ({ trend }: { trend: string }) => {
    if (!trend) return <span className="w-3.5 h-3.5 block text-center">→</span>;
    if (trend.includes('上揚')) return <ArrowUpRight className="w-3.5 h-3.5" />;
    if (trend.includes('下彎')) return <ArrowDownRight className="w-3.5 h-3.5" />;
    return <span className="w-3.5 h-3.5 block text-center">→</span>;
  };

  return (
    <div className="bg-slate-950/50 border border-slate-800 rounded-xl p-3 hover:border-slate-700/80 transition-all">
      <h3 className="text-sm sm:text-base font-bold text-white mb-4 flex items-center gap-2 border-b border-slate-800 pb-2">
        <span className="font-mono text-cyan-400 select-none">2 ⚡</span>
        均線趨勢 (MA Trend)
      </h3>

      {loading && <div className="text-slate-500 text-center py-4 text-xs">計算中...</div>}
      {!loading && !data && <div className="text-slate-500 text-center py-4 text-xs">無資料</div>}

      {data && (
      <div className="space-y-4 font-mono text-[11px] sm:text-xs">
        <div className="flex items-center justify-between text-slate-400 px-1 font-bold">
          <span>📊 均線技術分析</span>
          <span className="text-cyan-500 text-[10px]">MA-DEDUCTION ENGINE</span>
        </div>

        <div className="overflow-x-auto rounded-lg border border-slate-850">
          <table className="w-full text-left border-collapse bg-slate-950">
            <thead>
              <tr className="border-b border-slate-850 text-slate-450 bg-slate-900/60 font-semibold">
                <th className="p-2 sm:p-3">指標</th>
                <th className="p-2 sm:p-3">數值</th>
                <th className="p-2 sm:p-3">趨勢 / 解讀</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-850 text-slate-300">
              <tr>
                <td className="p-2 sm:p-3 font-semibold text-white">目前收盤</td>
                <td className="p-2 sm:p-3">
                  <div className="font-bold text-slate-100">{data.lastClose?.toFixed(2) ?? '0.00'}</div>
                  <div className={`text-[10px] sm:text-xs font-bold ${(change ?? 0) >= 0 ? 'text-red-500' : 'text-emerald-400'}`}>
                    {(change ?? 0) >= 0 ? '▲' : '▼'}{Math.abs(changePercent ?? 0).toFixed(1)}%({(change ?? 0).toFixed(2)})
                  </div>
                </td>
                <td className="p-2 sm:p-3">
                  <div className="text-emerald-400 font-bold">{data.arrangement}</div>
                  <div className="text-slate-400 text-[10px] sm:text-xs">乖離 {data.bias}%</div>
                </td>
              </tr>
              <tr>
                <td className="p-2 sm:p-3 text-slate-400">MA25 (月線)</td>
                <td className="p-2 sm:p-3 font-bold text-white">{data.ma25?.toFixed(2) ?? 'N/A'}</td>
                <td className="p-2 sm:p-3 text-red-500 font-bold flex items-center gap-1">
                  <TrendIcon trend={data.trend25} /> {data.trend25}
                </td>
              </tr>
              <tr>
                <td className="p-2 sm:p-3 text-slate-400">MA60 (季線)</td>
                <td className="p-2 sm:p-3 font-bold text-white">{data.ma60?.toFixed(2) ?? 'N/A'}</td>
                <td className="p-2 sm:p-3 text-red-500 font-bold flex items-center gap-1">
                  <TrendIcon trend={data.trend60} /> {data.trend60}
                </td>
              </tr>
              <tr>
                <td className="p-2 sm:p-3 text-slate-400">MA200 (年線)</td>
                <td className="p-2 sm:p-3 font-bold text-white">{data.ma200?.toFixed(2) ?? 'N/A'}</td>
                <td className="p-2 sm:p-3 text-red-500 font-bold flex items-center gap-1">
                  <TrendIcon trend={data.trend200} /> {data.trend200}
                </td>
              </tr>
              <tr>
                <td className="p-2 sm:p-3 text-slate-400">季線乖離</td>
                <td className="p-2 sm:p-3 font-bold text-white">{data.maGapPercent >= 0 ? '+' : ''}{data.maGapPercent}%</td>
                <td className="p-2 sm:p-3 text-slate-400">正常</td>
              </tr>
            </tbody>
          </table>
        </div>

        <div className="p-3 bg-slate-950 rounded-lg text-slate-400 border border-slate-850 leading-relaxed text-[10px] sm:text-xs space-y-1">
          <div>MA25 扣抵 {data.deduction25?.toFixed(2) ?? 'N/A'} {data.tomorrow25} | MA60 扣抵 {data.deduction60?.toFixed(2) ?? 'N/A'} {data.tomorrow60}</div>
          <div>MA200 扣抵 {data.deduction200?.toFixed(2) ?? 'N/A'} {data.tomorrow200}</div>
        </div>
      </div>
      )}
    </div>
  );
}

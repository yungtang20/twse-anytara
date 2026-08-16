import { ArrowUpRight, ArrowDownRight } from 'lucide-react';
import { useEffect, useState } from 'react';
import { fetchMAAnalysis, type MAAnalysis } from '../../lib/api';

interface MAPanelProps {
  stockId?: string;
  data?: MAAnalysis | null;
  change: number;
  changePercent: number;
}

export function MAPanel({ stockId, data: providedData, change, changePercent }: MAPanelProps) {
  const [loadedData, setLoadedData] = useState<MAAnalysis | null>(null);
  const data = providedData === undefined ? loadedData : providedData;

  useEffect(() => {
    if (!stockId || providedData !== undefined) return;
    const controller = new AbortController();
    setLoadedData(null);
    fetchMAAnalysis(stockId, controller.signal)
      .then((result) => { if (!controller.signal.aborted) setLoadedData(result); })
      .catch(() => { if (!controller.signal.aborted) setLoadedData(null); });
    return () => controller.abort();
  }, [stockId, providedData]);

  const TrendIcon = ({ trend }: { trend: string }) => {
    if (!trend) return <span className="w-3.5 h-3.5 block text-center">→</span>;
    if (trend.includes('上揚')) return <ArrowUpRight className="w-3.5 h-3.5" />;
    if (trend.includes('下彎')) return <ArrowDownRight className="w-3.5 h-3.5" />;
    return <span className="w-3.5 h-3.5 block text-center">→</span>;
  };

  const trendClass = (trend: string) => trend.includes('上揚')
    ? 'text-red-500' : trend.includes('下彎') ? 'text-emerald-400' : 'text-slate-400';

  return (
    <div className="bg-slate-950/50 border border-slate-800 rounded-xl p-3 hover:border-slate-700/80 transition-all">
      <h3 className="text-sm sm:text-base font-bold text-white mb-4 flex items-center gap-2 border-b border-slate-800 pb-2">
        <span className="font-mono text-cyan-400 select-none">2 ⚡</span>
        均線趨勢 (MA Trend)
      </h3>

      {!data && <div className="text-slate-500 text-center py-4 text-xs">無資料</div>}

      {data && (
      <div className="space-y-3 font-mono text-[11px] sm:text-xs">
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
                <td className="p-2">
                  <div className="font-bold text-slate-100">{data.lastClose?.toFixed(2) ?? '0.00'}</div>
                  <div className={`text-[10px] sm:text-xs font-bold ${(change ?? 0) >= 0 ? 'text-red-500' : 'text-emerald-400'}`}>
                    {(change ?? 0) >= 0 ? '▲' : '▼'}{Math.abs(changePercent ?? 0).toFixed(1)}%({(change ?? 0).toFixed(2)})
                  </div>
                </td>
                <td className="p-2">
                  <div className="font-bold text-cyan-300">{data.arrangement}</div>
                  <div className="text-slate-400 text-[10px] sm:text-xs">季線乖離 {data.bias >= 0 ? '+' : ''}{data.bias}%</div>
                </td>
              </tr>
              <tr>
                <td className="p-2 text-slate-400">MA25 (月線)</td>
                <td className="p-2 font-bold text-white">{data.ma25.ma.toFixed(2)}</td>
                <td className={`p-2 font-bold ${trendClass(data.ma25.trend)}`}>
                  <span className="flex items-center gap-1"><TrendIcon trend={data.ma25.trend} /> {data.ma25.trend}</span>
                </td>
              </tr>
              <tr>
                <td className="p-2 text-slate-400">MA60 (季線)</td>
                <td className="p-2 font-bold text-white">{data.ma60.ma.toFixed(2)}</td>
                <td className={`p-2 font-bold ${trendClass(data.ma60.trend)}`}>
                  <span className="flex items-center gap-1"><TrendIcon trend={data.ma60.trend} /> {data.ma60.trend}</span>
                </td>
              </tr>
              <tr>
                <td className="p-2 text-slate-400">MA200 (年線)</td>
                <td className="p-2 font-bold text-white">{data.ma200.ma.toFixed(2)}</td>
                <td className={`p-2 font-bold ${trendClass(data.ma200.trend)}`}>
                  <span className="flex items-center gap-1"><TrendIcon trend={data.ma200.trend} /> {data.ma200.trend}</span>
                </td>
              </tr>
              <tr>
                <td className="p-2 text-slate-400">季線乖離</td>
                <td className={`p-2 font-bold ${data.bias >= 0 ? 'text-red-500' : 'text-emerald-400'}`}>{data.bias >= 0 ? '+' : ''}{data.bias}%</td>
                <td className="p-2 text-slate-400">{data.biasLabel}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <div className="grid gap-1 rounded-lg border border-slate-850 bg-slate-950 p-2.5 text-[10px] leading-relaxed text-slate-400 sm:grid-cols-3 sm:text-xs">
          <div>MA25 扣抵 <b className="text-white">{data.ma25.deduction.toFixed(2)}</b> {data.ma25.tomorrow}</div>
          <div>MA60 扣抵 <b className="text-white">{data.ma60.deduction.toFixed(2)}</b> {data.ma60.tomorrow}</div>
          <div>MA200 扣抵 <b className="text-white">{data.ma200.deduction.toFixed(2)}</b> {data.ma200.tomorrow}</div>
        </div>
      </div>
      )}
    </div>
  );
}

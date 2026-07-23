import { useState, useEffect } from 'react';
import { fetchChipsAnalysis, type ChipsAnalysis } from '../../lib/api';

interface ChipsPanelProps {
  stockId: string;
}

export function ChipsPanel({ stockId }: ChipsPanelProps) {
  const [data, setData] = useState<ChipsAnalysis | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!stockId) return;
    setLoading(true);
    fetchChipsAnalysis(stockId)
      .then(setData)
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  }, [stockId]);

  return (
    <div className="bg-slate-950/50 border border-slate-800 rounded-xl p-3 hover:border-slate-700/80 transition-all">
      <h3 className="text-sm sm:text-base font-bold text-white mb-4 flex items-center gap-2 border-b border-slate-800 pb-2">
        <span className="font-mono text-cyan-400 select-none">3 ⚡</span>
        籌碼動能 (Institutional Chips)
      </h3>

      {loading && <div className="text-slate-500 text-center py-4 text-xs">載入中...</div>}
      {!loading && !data && <div className="text-slate-500 text-center py-4 text-xs">無資料</div>}

      {data && (
      <div className="space-y-4 font-mono text-xs sm:text-[13px]">
        <div className="grid grid-cols-2 gap-2">
          <div className="bg-slate-950 p-2.5 rounded-lg border border-slate-850 flex items-center justify-between">
            <span className="text-slate-400">🔥 外資動向：</span>
            <span className={`font-bold ${data.foreignConsecutive >= 0 ? 'text-red-500' : 'text-emerald-400'}`}>
              {data.foreignConsecutive >= 0 ? `連買 ${data.foreignConsecutive} 天` : `連賣 ${Math.abs(data.foreignConsecutive)} 天`}
            </span>
          </div>
          <div className="bg-slate-950 p-2.5 rounded-lg border border-slate-850 flex items-center justify-between">
            <span className="text-slate-400">🔥 投信動向：</span>
            <span className={`font-bold ${data.trustConsecutive >= 0 ? 'text-red-500' : 'text-emerald-400'}`}>
              {data.trustConsecutive >= 0 ? `連買 ${data.trustConsecutive} 天` : `連賣 ${Math.abs(data.trustConsecutive)} 天`}
            </span>
          </div>
        </div>

        {data.whaleRatio !== null && (
        <div className="bg-slate-950 p-2.5 rounded-lg border border-slate-850 flex items-center justify-between">
          <span className="text-slate-400">🏛️ 千戶大戶：</span>
          <span className="text-red-400 font-bold">{data.whaleRatio}%</span>
        </div>
        )}

        <div className="space-y-2">
          <div className="font-bold text-slate-400 px-1">📅 近 10 日法人進出明細</div>
          <div className="overflow-x-auto rounded-lg border border-slate-850 text-xs text-slate-300">
            <table className="w-full text-center border-collapse bg-slate-950">
              <thead>
                <tr className="border-b border-slate-850 text-slate-450 bg-slate-900/40 text-[11px] font-semibold">
                  <th className="p-2 text-left pl-4">日期</th>
                  <th className="p-2 text-right">外資買賣(張)</th>
                  <th className="p-2 text-right pr-4">投信買賣(張)</th>
                </tr>
              </thead>
              <tbody>
                {(data.chipHistory || []).slice(0, 10).map((row, index) => (
                  <tr key={index} className="hover:bg-slate-900/30 border-b border-slate-850/60 leading-normal">
                    <td className="p-2 text-left pl-4 text-slate-400">{row.date}</td>
                    <td className={`p-2 text-right font-semibold ${row.foreign >= 0 ? 'text-red-500' : 'text-emerald-400 font-medium'}`}>
                      {row.foreign >= 0 ? '+' : ''}{row.foreign.toLocaleString()}
                    </td>
                    <td className={`p-2 text-right pr-4 font-semibold ${row.trust >= 0 ? 'text-red-500' : 'text-emerald-400 font-medium'}`}>
                      {row.trust >= 0 ? '+' : ''}{row.trust.toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
      )}
    </div>
  );
}

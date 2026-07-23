import { useState, useEffect } from 'react';
import { fetchSRAnalysis, type SRAnalysis } from '../../lib/api';

interface SRPanelProps {
  stockId: string;
}

export function SRPanel({ stockId }: SRPanelProps) {
  const [data, setData] = useState<SRAnalysis | null>(null);
  const [loading, setLoading] = useState(false);
  const formatLevel = (value: number | null) => value == null ? '--' : value.toFixed(2);

  useEffect(() => {
    if (!stockId) return;
    setLoading(true);
    fetchSRAnalysis(stockId)
      .then(setData)
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  }, [stockId]);

  return (
    <div className="bg-slate-950/50 border border-slate-800 rounded-xl p-3 hover:border-slate-700/80 transition-all group">
      <h3 className="text-sm sm:text-base font-bold text-white mb-4 flex items-center gap-2 border-b border-slate-800 pb-2">
        <span className="font-mono text-cyan-400 select-none">1 ⚡</span>
        撐壓分析 (Support/Resistance)
      </h3>

      {loading && <div className="text-slate-500 text-center py-4 text-xs">計算中...</div>}
      {!loading && !data && <div className="text-slate-500 text-center py-4 text-xs">無資料</div>}

      {data && (
      <div className="space-y-4 font-mono text-xs sm:text-[13px]">
        <div className="space-y-1.5 bg-slate-950 p-2.5 rounded-lg border border-slate-850">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs pt-1 sm:divide-x sm:divide-slate-850">
            <div>
              <div className="text-slate-400 pb-0.5">前高/短期/長期壓力</div>
              <div className="text-rose-400 font-bold text-xs sm:text-sm">
                {formatLevel(data.pressure.near)} / {formatLevel(data.pressure.mid)} / {formatLevel(data.pressure.far)}
              </div>
            </div>
            <div className="sm:pl-3">
              <div className="text-slate-400 pb-0.5">前低/短期/長期支撐</div>
              <div className="text-emerald-400 font-bold text-xs sm:text-sm">
                {formatLevel(data.support.near)} / {formatLevel(data.support.mid)} / {formatLevel(data.support.far)}
              </div>
            </div>
          </div>
        </div>
      </div>
      )}
    </div>
  );
}

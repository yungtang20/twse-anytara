import { useEffect, useState } from "react";
import {
  fetchPredictionAnalysis,
  type PredictionAnalysis,
} from "../../lib/api";

interface PredictionPanelProps {
  stockId: string;
}

export function PredictionPanel({ stockId }: PredictionPanelProps) {
  const [data, setData] = useState<PredictionAnalysis | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!stockId) return;
    let disposed = false;
    setLoading(true);
    setError("");
    fetchPredictionAnalysis(stockId)
      .then((result) => {
        if (!disposed) setData(result);
      })
      .catch((cause: unknown) => {
        if (!disposed) {
          setData(null);
          setError(cause instanceof Error ? cause.message : "模擬推演失敗");
        }
      })
      .finally(() => {
        if (!disposed) setLoading(false);
      });
    return () => {
      disposed = true;
    };
  }, [stockId]);

  return (
    <div className="bg-slate-950/50 border border-slate-800 rounded-xl p-4 sm:p-5 hover:border-slate-700/80 transition-all font-mono text-xs sm:text-[13px]">
      <h3 className="text-sm sm:text-base font-bold text-white mb-4 flex flex-wrap items-center gap-2 border-b border-slate-800 pb-2">
        <span className="font-mono text-cyan-400 select-none">4 ⚡</span>
        AI 模擬分析 (Simulation)
        <span className="rounded border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[9px] text-amber-300">
          模擬，非預測
        </span>
      </h3>

      {loading && <div className="text-slate-500 text-center py-4">計算中...</div>}
      {!loading && error && <div className="text-rose-300 text-center py-4">{error}</div>}

      {!loading && data && (
        <div className="space-y-4">
          <div className="bg-slate-950 p-3 rounded-lg border border-slate-850">
            <div className="flex items-center justify-between mb-2">
              <span className="text-slate-400 font-bold">🧠 技術模擬判斷</span>
              <span className={`text-sm font-bold ${
                data.aiStrength === "看多"
                  ? "text-rose-400"
                  : data.aiStrength === "看空"
                    ? "text-emerald-400"
                    : "text-amber-300"
              }`}>
                {data.aiStrength}
              </span>
            </div>
            <div className="grid grid-cols-1 gap-1 text-slate-300 sm:grid-cols-2">
              <div>信心分數：<strong className="text-white">{(data.aiScore * 100).toFixed(1)}%</strong></div>
              <div>日波動度：<strong className="text-white">{data.volatility.toFixed(2)}%</strong></div>
              <div>近 20 日平均報酬：<strong className={data.avgReturn >= 0 ? "text-rose-400" : "text-emerald-400"}>{data.avgReturn >= 0 ? "+" : ""}{data.avgReturn.toFixed(2)}%</strong></div>
            </div>
            <p className="mt-2 rounded border border-slate-800 bg-slate-900/60 p-2 text-[11px] leading-relaxed text-slate-400">
              {data.aiReason}
            </p>
          </div>

          <div className="bg-slate-950 p-3 rounded-lg border border-slate-850">
            <div className="text-slate-400 font-bold mb-2">📈 模擬路徑 (T+1 ～ T+5)</div>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
              {data.predictions.map((point) => (
                <div key={point.day} className="bg-slate-900/50 rounded-lg p-2 text-center border border-slate-800/60">
                  <div className="text-slate-500 text-[10px]">{point.day}</div>
                  <div className="text-white font-bold">{point.price.toFixed(2)}</div>
                  <div className={`text-[10px] font-semibold ${point.pct >= 0 ? "text-rose-400" : "text-emerald-400"}`}>
                    {point.pct >= 0 ? "+" : ""}{point.pct.toFixed(2)}%
                  </div>
                </div>
              ))}
            </div>
            <p className="mt-3 text-[10px] leading-relaxed text-amber-300/90">
              {data.disclaimer}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

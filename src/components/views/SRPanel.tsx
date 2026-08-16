import { useEffect, useState } from 'react';
import { fetchSRAnalysis, type SRAnalysis } from '../../lib/api';

interface SRPanelProps {
  stockId?: string;
  data?: SRAnalysis | null;
}

export function SRPanel({ stockId, data: providedData }: SRPanelProps) {
  const [loadedData, setLoadedData] = useState<SRAnalysis | null>(null);
  const data = providedData === undefined ? loadedData : providedData;

  useEffect(() => {
    if (!stockId || providedData !== undefined) return;
    const controller = new AbortController();
    setLoadedData(null);
    fetchSRAnalysis(stockId, controller.signal)
      .then((result) => { if (!controller.signal.aborted) setLoadedData(result); })
      .catch(() => { if (!controller.signal.aborted) setLoadedData(null); });
    return () => controller.abort();
  }, [stockId, providedData]);

  return (
    <div className="bg-slate-950/50 border border-slate-800 rounded-xl p-3 hover:border-slate-700/80 transition-all group">
      <h3 className="text-sm sm:text-base font-bold text-white mb-4 flex items-center gap-2 border-b border-slate-800 pb-2">
        <span className="font-mono text-cyan-400 select-none">1 ⚡</span>
        撐壓分析 (Support/Resistance)
      </h3>

      {!data && <div className="text-slate-500 text-center py-4 text-xs">無資料</div>}

      {data && <div className="grid grid-cols-1 gap-2 font-mono text-xs sm:grid-cols-2 xl:grid-cols-5">
        <SingleLevel label="VWAP（20日）" value={data.vwap} color="text-yellow-400" />
        <SingleLevel label="POC 最密成交價" value={data.poc} color="text-rose-400" />
        <LevelPair label="短期撐壓（25日）" upper={data.shortResistance} lower={data.shortSupport} />
        <LevelPair label="長期撐壓（60日）" upper={data.longResistance} lower={data.longSupport} />
        <LevelPair label="波段高低（61日）" upper={data.swingHigh} lower={data.swingLow} upperName="高" lowerName="低" />
      </div>}
    </div>
  );
}

function formatLevel(value: number | null | undefined) {
  return value == null ? '--' : value.toFixed(2);
}

function SingleLevel({ label, value, color }: { label: string; value: number | null | undefined; color: string }) {
  return <div className="rounded-lg border border-slate-800 bg-slate-950 p-2.5">
    <div className="mb-1 text-slate-400">{label}</div>
    <div className={`text-sm font-bold ${color}`}>{formatLevel(value)}</div>
  </div>;
}

function LevelPair({ label, upper, lower, upperName = '壓力', lowerName = '支撐' }: {
  label: string;
  upper: number | null | undefined;
  lower: number | null | undefined;
  upperName?: string;
  lowerName?: string;
}) {
  return <div className="rounded-lg border border-slate-800 bg-slate-950 p-2.5">
    <div className="mb-1 text-slate-400">{label}</div>
    <div className="flex flex-wrap gap-x-3 gap-y-0.5 font-bold">
      <span className="text-rose-400">{upperName} {formatLevel(upper)}</span>
      <span className="text-emerald-400">{lowerName} {formatLevel(lower)}</span>
    </div>
  </div>;
}

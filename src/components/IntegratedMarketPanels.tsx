import { useMemo } from "react";
import {
  Bar,
  CartesianGrid,
  Cell,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  buildIntegratedMarketData,
  type InstitutionalPoint,
  type ShareholdingPoint,
} from "../lib/integratedMarketData";

interface IntegratedMarketPanelsProps {
  visibleDates: string[];
  institutional: InstitutionalPoint[];
  shareholding: ShareholdingPoint[];
  showForeign: boolean;
  showTrust: boolean;
  showShareholding: boolean;
}

interface TooltipEntry {
  dataKey?: string;
  value?: number;
  color?: string;
  fill?: string;
}

interface PanelTooltipProps {
  active?: boolean;
  label?: string;
  payload?: TooltipEntry[];
}

const layerLabels: Record<string, string> = {
  foreign: "外資",
  trust: "投信",
  whaleRatio: "千戶大戶",
};

function PanelTooltip({ active, label, payload }: PanelTooltipProps) {
  const values = payload?.filter((entry) => entry.value != null) || [];
  if (!active || values.length === 0) return null;
  return (
    <div className="space-y-1 rounded-lg border border-slate-700 bg-slate-950/95 p-2.5 font-mono text-xs shadow-xl">
      <div className="border-b border-slate-800 pb-1 font-bold text-slate-400">{label}</div>
      {values.map((entry) => {
        const key = entry.dataKey || "";
        const isRatio = key === "whaleRatio";
        return (
          <div key={key} className="flex justify-between gap-4">
            <span style={{ color: entry.color || entry.fill }}>{layerLabels[key] || key}</span>
            <strong className="text-slate-100">
              {isRatio
                ? `${Number(entry.value).toFixed(2)}%`
                : `${Number(entry.value).toLocaleString()} 張`}
            </strong>
          </div>
        );
      })}
    </div>
  );
}

function signedDomain(values: Array<number | null>): [number, number] {
  const maximum = Math.max(...values.map((value) => Math.abs(value || 0)), 1);
  const bound = Math.ceil(maximum * 1.1);
  return [-bound, bound];
}

export function IntegratedMarketPanels({
  visibleDates,
  institutional,
  shareholding,
  showForeign,
  showTrust,
  showShareholding,
}: IntegratedMarketPanelsProps) {
  const data = useMemo(
    () => buildIntegratedMarketData(visibleDates, institutional, shareholding),
    [visibleDates, institutional, shareholding],
  );
  const institutionalDomain = signedDomain(
    data.flatMap((row) => [
      showForeign ? row.foreign : null,
      showTrust ? row.trust : null,
    ]),
  );
  const ratios = data
    .map((row) => row.whaleRatio)
    .filter((value): value is number => value != null);
  const ratioMin = ratios.length ? Math.max(0, Math.floor(Math.min(...ratios) - 1)) : 0;
  const ratioMax = ratios.length ? Math.min(100, Math.ceil(Math.max(...ratios) + 1)) : 100;
  const showInstitutional = showForeign || showTrust;

  if (!showInstitutional && !showShareholding) return null;

  return (
    <div className="border-t border-slate-800/80 bg-slate-950/30">
      {showInstitutional && (
        <section className="border-b border-slate-800/70 px-3 py-2">
          <div className="mb-1 flex flex-wrap items-center gap-3 text-[10px] font-mono">
            <strong className="text-slate-300">法人買賣超</strong>
            {showForeign && <span className="text-blue-300">■ 外資</span>}
            {showTrust && <span className="text-amber-300">■ 投信</span>}
            <span className="ml-auto text-slate-500">紅＝買超、綠＝賣超（張）</span>
          </div>
          <ResponsiveContainer width="100%" height={118}>
            <ComposedChart
              syncId="integrated-stock-cockpit"
              data={data}
              margin={{ top: 4, right: 8, left: 0, bottom: 0 }}
              barGap={2}
            >
              <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" opacity={0.35} />
              <XAxis dataKey="date" tick={false} tickLine={false} axisLine={false} />
              <YAxis
                domain={institutionalDomain}
                width={48}
                tick={{ fill: "#64748b", fontSize: 8 }}
                tickLine={false}
                axisLine={false}
                tickFormatter={(value) => Math.abs(value) >= 1000 ? `${(value / 1000).toFixed(0)}K` : `${value}`}
              />
              <Tooltip content={<PanelTooltip />} />
              <ReferenceLine y={0} stroke="#64748b" />
              {showForeign && (
                <Bar dataKey="foreign" name="外資" maxBarSize={12}>
                  {data.map((row) => (
                    <Cell
                      key={`foreign-${row.date}`}
                      fill={(row.foreign || 0) >= 0 ? "#f87171" : "#34d399"}
                      opacity={0.9}
                    />
                  ))}
                </Bar>
              )}
              {showTrust && (
                <Bar dataKey="trust" name="投信" maxBarSize={12}>
                  {data.map((row) => (
                    <Cell
                      key={`trust-${row.date}`}
                      fill={(row.trust || 0) >= 0 ? "#fb923c" : "#10b981"}
                      opacity={0.9}
                    />
                  ))}
                </Bar>
              )}
            </ComposedChart>
          </ResponsiveContainer>
        </section>
      )}

      {showShareholding && (
        <section className="px-3 py-2">
          <div className="mb-1 flex flex-wrap items-center gap-3 text-[10px] font-mono">
            <strong className="text-slate-300">千戶大戶持股比例</strong>
            <span className="text-cyan-300">━ 1,000 張以上</span>
            <span className="ml-auto text-slate-500">TDCC 週資料延續至下一公告日</span>
          </div>
          <ResponsiveContainer width="100%" height={110}>
            <ComposedChart
              syncId="integrated-stock-cockpit"
              data={data}
              margin={{ top: 4, right: 8, left: 0, bottom: 2 }}
            >
              <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" opacity={0.35} />
              <XAxis
                dataKey="date"
                interval="preserveStartEnd"
                minTickGap={30}
                tick={{ fill: "#64748b", fontSize: 8 }}
                tickLine={false}
                axisLine={false}
                tickFormatter={(value) => value.slice(5)}
              />
              <YAxis
                domain={[ratioMin, ratioMax]}
                width={42}
                tick={{ fill: "#64748b", fontSize: 8 }}
                tickLine={false}
                axisLine={false}
                tickFormatter={(value) => `${value}%`}
              />
              <Tooltip content={<PanelTooltip />} />
              <Line
                type="stepAfter"
                dataKey="whaleRatio"
                name="千戶大戶"
                stroke="#22d3ee"
                strokeWidth={2}
                dot={false}
                connectNulls
              />
            </ComposedChart>
          </ResponsiveContainer>
        </section>
      )}
    </div>
  );
}

import { useMemo, useState } from "react";
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
  type IntegratedMarketPoint,
  type InstitutionalPoint,
  type ShareholdingPoint,
} from "../lib/integratedMarketData";
import { mondayTicks } from "../lib/chartFormatting";

interface IntegratedMarketPanelsProps {
  visibleDates: string[];
  activeDate?: string;
  institutional: InstitutionalPoint[];
  shareholding: ShareholdingPoint[];
  showForeign: boolean;
  showTrust: boolean;
  showDealer: boolean;
  showShareholding: boolean;
}

function signedDomain(values: Array<number | null>): [number, number] {
  const maximum = Math.max(...values.map((value) => Math.abs(value || 0)), 1);
  const bound = Math.ceil(maximum * 1.1);
  return [-bound, bound];
}

function InvisibleTooltip() {
  return null;
}

export function IntegratedMarketPanels({
  visibleDates,
  activeDate,
  institutional,
  shareholding,
  showForeign,
  showTrust,
  showDealer,
  showShareholding,
}: IntegratedMarketPanelsProps) {
  const [hoveredDate, setHoveredDate] = useState<string | null>(null);
  const data = useMemo(
    () => buildIntegratedMarketData(visibleDates, institutional, shareholding),
    [visibleDates, institutional, shareholding],
  );
  const weekdayTicks = useMemo(() => mondayTicks(visibleDates), [visibleDates]);
  const institutionalDomain = signedDomain(
    data.flatMap((row) => [
      showForeign ? row.foreign : null,
      showTrust ? row.trust : null,
      showDealer ? row.dealer : null,
    ]),
  );
  const ratios = data
    .map((row) => row.whaleRatio)
    .filter((value): value is number => value != null);
  const ratioMin = ratios.length ? Math.max(0, Math.floor(Math.min(...ratios) - 1)) : 0;
  const ratioMax = ratios.length ? Math.min(100, Math.ceil(Math.max(...ratios) + 1)) : 100;
  const showInstitutional = showForeign || showTrust || showDealer;
  const selectedDate = hoveredDate ?? activeDate;
  const activeRow = data.find((row) => row.date === selectedDate) ?? data.at(-1);

  if (!showInstitutional && !showShareholding) return null;

  return (
    <div className="border-t border-slate-800/80 bg-slate-950/30">
      {showInstitutional && (
        <section className="border-b border-slate-800/70 px-3 py-2">
          <InstitutionalHeader row={activeRow} showForeign={showForeign} showTrust={showTrust} showDealer={showDealer} />
          <ResponsiveContainer width="100%" height={118}>
            <ComposedChart
              syncId="integrated-stock-cockpit"
              data={data}
              margin={{ top: 4, right: 8, left: 0, bottom: 0 }}
              barGap={2}
              onMouseMove={(state) => setHoveredDate(typeof state?.activeLabel === "string" ? state.activeLabel : null)}
              onMouseLeave={() => setHoveredDate(null)}
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
              <Tooltip content={<InvisibleTooltip />} cursor={false} />
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
              {showDealer && (
                <Bar dataKey="dealer" name="自營商" maxBarSize={12}>
                  {data.map((row) => (
                    <Cell
                      key={`dealer-${row.date}`}
                      fill={(row.dealer || 0) >= 0 ? "#c084fc" : "#14b8a6"}
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
          <ShareholdingHeader row={activeRow} />
          <ResponsiveContainer width="100%" height={110}>
            <ComposedChart
              syncId="integrated-stock-cockpit"
              data={data}
              margin={{ top: 4, right: 8, left: 0, bottom: 2 }}
              onMouseMove={(state) => setHoveredDate(typeof state?.activeLabel === "string" ? state.activeLabel : null)}
              onMouseLeave={() => setHoveredDate(null)}
            >
              <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" opacity={0.35} />
              <XAxis
                dataKey="date"
                ticks={weekdayTicks}
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
              <Tooltip content={<InvisibleTooltip />} cursor={false} />
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

function InstitutionalHeader({ row, showForeign, showTrust, showDealer }: {
  row?: IntegratedMarketPoint;
  showForeign: boolean;
  showTrust: boolean;
  showDealer: boolean;
}) {
  return <div className="mb-1 flex min-h-5 flex-wrap items-center gap-3 font-mono text-[10px]">
    <strong className="text-slate-300">法人買賣超</strong>
    <span className="text-slate-500">{row?.date ?? '--'}</span>
    {showForeign && <SignedHeaderValue label="外資" value={row?.foreign} />}
    {showTrust && <SignedHeaderValue label="投信" value={row?.trust} />}
    {showDealer && <SignedHeaderValue label="自營商" value={row?.dealer} />}
    <span className="ml-auto text-slate-500">紅＝買超、綠＝賣超（張）</span>
  </div>;
}

function SignedHeaderValue({ label, value }: { label: string; value: number | null | undefined }) {
  const color = (value ?? 0) >= 0 ? 'text-red-400' : 'text-emerald-400';
  return <span className={color}>{label} <b>{value == null ? '--' : `${value >= 0 ? '+' : ''}${value.toLocaleString()} 張`}</b></span>;
}

function ShareholdingHeader({ row }: { row?: IntegratedMarketPoint }) {
  return <div className="mb-1 flex min-h-5 flex-wrap items-center gap-3 font-mono text-[10px]">
    <strong className="text-slate-300">千戶大戶持股比例</strong>
    <span className="text-slate-500">{row?.date ?? '--'}</span>
    <span className="text-cyan-300">1,000 張以上 <b>{row?.whaleRatio == null ? '--' : `${row.whaleRatio.toFixed(2)}%`}</b></span>
    <span className="ml-auto text-slate-500">TDCC 週資料延續至下一公告日</span>
  </div>;
}

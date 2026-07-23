import React from 'react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceLine, Cell, LineChart, Line
} from 'recharts';

interface ChipRow { date: string; foreign: number; trust: number; }
interface ShareholdingRow { date: string; ratio: number; shares?: number; }

interface ChipsBarChartProps {
  chipHistory: ChipRow[];
  /** 千戶大戶持股歷史（API: /api/stock/:id/shareholding） */
  shareholding?: ShareholdingRow[];
  viewMode?: 'all' | 'institutional' | 'shareholding';
}

const InstitutionalTooltip = ({ active, payload, label }: any) => {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-slate-950/95 border border-slate-700 p-2.5 rounded-lg shadow-xl font-mono text-xs space-y-1">
      <div className="text-slate-400 font-bold border-b border-slate-800 pb-1">{label}</div>
      {payload.map((p: any) => (
        <div key={p.name} className="flex justify-between gap-4">
          <span style={{ color: p.fill ?? p.color }}>{p.name}:</span>
          <span className={`font-bold ${p.value >= 0 ? 'text-red-400' : 'text-emerald-400'}`}>
            {p.value >= 0 ? '+' : ''}{p.value.toLocaleString()} 張
          </span>
        </div>
      ))}
    </div>
  );
};

const WhaleTooltip = ({ active, payload, label }: any) => {
  if (!active || !payload?.length) return null;
  const v = payload[0]?.value;
  return (
    <div className="bg-slate-950/95 border border-slate-700 p-2.5 rounded-lg shadow-xl font-mono text-xs">
      <div className="text-slate-400 font-bold border-b border-slate-800 pb-1">{label}</div>
      <div className="text-cyan-400 font-bold">千戶大戶: {v?.toFixed(1)}%</div>
    </div>
  );
};

export function ChipsBarChart({ chipHistory, shareholding, viewMode = 'all' }: ChipsBarChartProps) {
  // 法人資料：限 20 天，由舊到新排列（圖由左到右）
  const institutionalData = [...chipHistory].reverse().slice(-20).map(r => ({
    ...r,
    date: r.date.slice(5), // MM-DD
  }));

  // 集保資料
  const whaleData = shareholding
    ? [...shareholding].reverse().slice(-20).map(r => ({
        date: r.date.slice(5),
        ratio: r.ratio,
      }))
    : [];

  const maxAbs = Math.max(
    ...institutionalData.flatMap(r => [Math.abs(r.foreign), Math.abs(r.trust)]),
    1
  );
  const yDomain: [number, number] = [-Math.ceil(maxAbs * 1.1), Math.ceil(maxAbs * 1.1)];

  return (
    <div className="space-y-4">
      {/* ── 法人買賣超柱狀圖 ── */}
      {viewMode !== 'shareholding' && (
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
          <div className="flex items-center justify-between mb-3">
            <h4 className="text-sm font-bold text-white">法人買賣超（近 20 日）</h4>
            <div className="flex items-center gap-3 text-[10px] font-mono">
              <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-blue-400 inline-block" />外資</span>
              <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-amber-400 inline-block" />投信</span>
              <span className="text-slate-500">正值=買超 紅, 負值=賣超 綠</span>
            </div>
          </div>
          {institutionalData.length === 0 ? (
            <div className="text-slate-500 text-center py-6 text-xs">無法人資料</div>
          ) : (
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={institutionalData} margin={{ top: 4, right: 8, left: 0, bottom: 0 }} barGap={2} barCategoryGap="25%">
                <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" opacity={0.6} />
                <XAxis dataKey="date" tick={{ fill: '#475569', fontSize: 9 }} tickLine={false} axisLine={false} />
                <YAxis domain={yDomain} tick={{ fill: '#475569', fontSize: 9 }} tickLine={false} axisLine={false} width={52}
                  tickFormatter={v => v >= 1000 || v <= -1000 ? `${(v / 1000).toFixed(0)}K` : `${v}`} />
                <Tooltip content={<InstitutionalTooltip />} />
                <ReferenceLine y={0} stroke="#475569" strokeWidth={1} />
                {/* 外資 */}
                <Bar dataKey="foreign" name="外資" maxBarSize={14}>
                  {institutionalData.map((e, i) => (
                    <Cell key={`f${i}`} fill={e.foreign >= 0 ? '#60a5fa' : '#34d399'} opacity={0.85} />
                  ))}
                </Bar>
                {/* 投信 */}
                <Bar dataKey="trust" name="投信" maxBarSize={14}>
                  {institutionalData.map((e, i) => (
                    <Cell key={`t${i}`} fill={e.trust >= 0 ? '#fbbf24' : '#6ee7b7'} opacity={0.85} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>
      )}

      {/* ── 千戶大戶持股比例 ── */}
      {viewMode !== 'institutional' && whaleData.length > 0 && (
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
          <div className="flex items-center justify-between mb-3">
            <h4 className="text-sm font-bold text-white">千戶大戶持股比例（集保）</h4>
            <span className="text-[10px] text-slate-500 font-mono">持有 1,000 張以上</span>
          </div>
          <ResponsiveContainer width="100%" height={160}>
            <BarChart data={whaleData} margin={{ top: 4, right: 8, left: 0, bottom: 0 }} barCategoryGap="25%">
              <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" opacity={0.6} />
              <XAxis dataKey="date" tick={{ fill: '#475569', fontSize: 9 }} tickLine={false} axisLine={false} />
              <YAxis domain={[0, 100]} tick={{ fill: '#475569', fontSize: 9 }} tickLine={false} axisLine={false} width={32}
                tickFormatter={v => `${v}%`} />
              <Tooltip content={<WhaleTooltip />} />
              <Bar dataKey="ratio" name="大戶持股%" maxBarSize={20}>
                {whaleData.map((e, i) => (
                  <Cell key={`w${i}`}
                    fill={e.ratio >= 60 ? '#f87171' : e.ratio >= 40 ? '#fb923c' : '#94a3b8'}
                    opacity={0.9}
                  />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
          <div className="flex gap-3 text-[10px] font-mono text-slate-500 mt-1 pl-1">
            <span><span className="text-red-400">■</span> ≥60% 集中度高</span>
            <span><span className="text-orange-400">■</span> 40-60% 中等</span>
            <span><span className="text-slate-400">■</span> &lt;40% 分散</span>
          </div>
        </div>
      )}
    </div>
  );
}

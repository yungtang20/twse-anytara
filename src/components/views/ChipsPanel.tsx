import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  fetchStockInstitutional,
  fetchStockShareholding,
  type InstitutionalRow,
  type ShareholdingRow,
} from '../../lib/api';

interface ChipsDetailPanelProps {
  institutional: InstitutionalRow[];
  shareholding: ShareholdingRow[];
}

type InstitutionalKey = 'foreign_net' | 'trust_net';

export function ChipsDetailPanel({ institutional, shareholding }: ChipsDetailPanelProps) {
  const recentInstitutional = useMemo(
    () => [...institutional].sort((left, right) => right.date.localeCompare(left.date)).slice(0, 10),
    [institutional],
  );
  const recentShareholding = useMemo(
    () => [...shareholding].sort((left, right) => right.date.localeCompare(left.date)).slice(0, 10),
    [shareholding],
  );

  return <section className="rounded-xl border border-slate-800 bg-slate-950/50 p-3">
    <h3 className="mb-3 border-b border-slate-800 pb-2 text-sm font-bold text-white">3 ⚡ 籌碼動能</h3>
    {!recentInstitutional.length && !recentShareholding.length
      ? <div className="py-4 text-center text-xs text-slate-500">無資料</div>
      : <div className="space-y-2 font-mono text-xs">
          <ChipsSummary institutional={recentInstitutional} />
          <ChipsTables institutional={recentInstitutional} shareholding={recentShareholding} />
        </div>}
  </section>;
}

function ChipsSummary({ institutional }: Pick<ChipsDetailPanelProps, 'institutional'>) {
  return <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
    <TrendSummary label="外資動向" days={countConsecutive(institutional, 'foreign_net')} />
    <TrendSummary label="投信動向" days={countConsecutive(institutional, 'trust_net')} />
  </div>;
}

function TrendSummary({ label, days }: { label: string; days: number }) {
  const color = days > 0 ? 'text-red-400' : days < 0 ? 'text-emerald-400' : 'text-slate-500';
  const value = days > 0 ? `連買 ${days} 天` : days < 0 ? `連賣 ${Math.abs(days)} 天` : '無連續';
  return <div className="flex items-center justify-between rounded-lg border border-slate-800 bg-slate-950 p-2.5">
    <span className="text-slate-400">{label}</span><b className={color}>{value}</b>
  </div>;
}

function ChipsTables({ institutional, shareholding }: ChipsDetailPanelProps) {
  return <div className="overflow-x-auto">
    <div className="grid w-max grid-cols-[max-content_max-content] items-start gap-1.5">
      <DetailTable title="近 10 日法人買賣超" headers={['日期', '外資(張)', '投信(張)']}>
        {institutional.map((row) => <tr key={row.date} className="border-b border-slate-800/60">
          <td className="px-2 py-0.5 text-slate-400">{row.date}</td>
          <SignedLotsCell value={row.foreign_net} /><SignedLotsCell value={row.trust_net} />
        </tr>)}
      </DetailTable>
      <ShareholdingTable rows={shareholding} />
    </div>
  </div>;
}

function ShareholdingTable({ rows }: { rows: ShareholdingRow[] }) {
  return <DetailTable title="TDCC 千張大戶明細" headers={['週別', '持股比率（較上週）', '股東總人數（較上週）']}>
    {rows.map((row, index) => {
      const previous = rows[index + 1];
      return <tr key={row.date} className="border-b border-slate-800/60">
        <td className="px-2 py-0.5 text-slate-400">{row.date}</td>
        <td className="px-2 py-0.5 text-left font-semibold text-cyan-300">{row.ratio.toFixed(2)}% <WeeklyChange current={row.ratio} previous={previous?.ratio} suffix="%" decimals={2} /></td>
        <td className="px-2 py-0.5 text-left font-semibold text-white">{row.totalPeople === null ? '尚無資料' : `${row.totalPeople.toLocaleString()} 人`}{row.totalPeople !== null && <WeeklyChange current={row.totalPeople} previous={previous?.totalPeople} suffix=" 人" decimals={0} />}</td>
      </tr>;
    })}
  </DetailTable>;
}

export function ChipsPanel({ stockId }: { stockId: string }) {
  const [institutional, setInstitutional] = useState<InstitutionalRow[]>([]);
  const [shareholding, setShareholding] = useState<ShareholdingRow[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let active = true;
    setLoading(true);
    Promise.all([fetchStockInstitutional(stockId), fetchStockShareholding(stockId)])
      .then(([institutions, holders]) => {
        if (!active) return;
        setInstitutional(institutions.data); setShareholding(holders.data);
      })
      .catch(() => { if (active) { setInstitutional([]); setShareholding([]); } })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [stockId]);

  return loading
    ? <section className="rounded-xl border border-slate-800 bg-slate-950/50 p-3"><h3 className="mb-3 border-b border-slate-800 pb-2 text-sm font-bold text-white">3 ⚡ 籌碼動能</h3><div className="py-4 text-center text-xs text-slate-500">載入中...</div></section>
    : <ChipsDetailPanel institutional={institutional} shareholding={shareholding} />;
}

function countConsecutive(rows: InstitutionalRow[], key: InstitutionalKey) {
  const firstValue = rows[0]?.[key] ?? 0;
  if (firstValue === 0) return 0;
  const direction = Math.sign(firstValue);
  let count = 0;
  for (const row of rows) {
    if (Math.sign(row[key]) !== direction) break;
    count += 1;
  }
  return count * direction;
}

function WeeklyChange({ current, previous, suffix, decimals }: { current: number; previous: number | null | undefined; suffix: string; decimals: number }) {
  if (previous == null) return <span className="ml-1 text-slate-600">—</span>;
  const difference = current - previous;
  if (difference === 0) return <span className="ml-1 text-slate-500">→ 0{suffix}</span>;
  const display = decimals === 0 ? Math.abs(difference).toLocaleString() : Math.abs(difference).toFixed(decimals);
  return <span className={`ml-1 ${difference > 0 ? 'text-red-400' : 'text-emerald-400'}`}>{difference > 0 ? '↑' : '↓'} {display}{suffix}</span>;
}

function SignedLotsCell({ value }: { value: number }) {
  const lots = Math.trunc(value / 1000);
  return <td className={`px-2 py-0.5 text-left font-semibold ${lots >= 0 ? 'text-red-400' : 'text-emerald-400'}`}>{lots >= 0 ? '+' : ''}{lots.toLocaleString()}</td>;
}

function DetailTable({ title, headers, children }: { title: string; headers: string[]; children: ReactNode }) {
  return <div className="w-max overflow-hidden rounded-lg border border-slate-800">
    <div className="border-b border-slate-800 bg-slate-900/60 px-2 py-0.5 text-[11px] font-bold text-slate-300">{title}</div>
    <table className="w-auto text-xs font-mono"><thead><tr className="border-b border-slate-800 text-slate-500">{headers.map((header) => <th key={header} className="px-2 py-0.5 text-left font-semibold">{header}</th>)}</tr></thead><tbody>{children}</tbody></table>
  </div>;
}

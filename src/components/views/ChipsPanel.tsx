import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  fetchStockInstitutional,
  fetchInstitutionalHoldings,
  fetchStockShareholding,
  type InstitutionalHoldingSnapshot,
  type InstitutionalRow,
  type ShareholdingRow,
} from '../../lib/api';

interface ChipsDetailPanelProps {
  stockId: string;
  institutional: InstitutionalRow[];
  shareholding: ShareholdingRow[];
}

type InstitutionalKey = 'foreign_net' | 'trust_net' | 'dealer_net';

export function ChipsDetailPanel({ stockId, institutional, shareholding }: ChipsDetailPanelProps) {
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
    <div className="space-y-2 font-mono text-xs">
      <InstitutionalHoldingsCard
        stockId={stockId}
        institutional={recentInstitutional}
        shareholding={recentShareholding}
      />
      {!recentInstitutional.length && !recentShareholding.length
        ? <div className="py-4 text-center text-xs text-slate-500">買賣超與 TDCC 無資料</div>
        : <>
          <ChipsSummary institutional={recentInstitutional} />
          <ChipsTables institutional={recentInstitutional} shareholding={recentShareholding} />
        </>}
    </div>
  </section>;
}

function InstitutionalHoldingsCard({ stockId, institutional, shareholding }: ChipsDetailPanelProps) {
  const [data, setData] = useState<InstitutionalHoldingSnapshot | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    setData(null); setUnavailable(false);
    fetchInstitutionalHoldings(stockId, controller.signal)
      .then((value) => { if (!controller.signal.aborted) setData(value); })
      .catch(() => { if (!controller.signal.aborted) setUnavailable(true); });
    return () => controller.abort();
  }, [stockId]);
  if (unavailable) return <div className="rounded-lg border border-slate-800 p-2 text-slate-500">法人持股狀態暫無資料</div>;
  if (!data) return <div className="rounded-lg border border-slate-800 p-2 text-slate-500">法人持股狀態載入中…</div>;
  const flow = institutional.find((row) => row.date === data.date);
  const totalShares = shareholding.find((row) => row.date <= data.date && (row.shares ?? 0) > 0)?.shares;
  const totalNet = flow?.institutional_net ?? (flow
    ? flow.foreign_net + flow.trust_net + (flow.dealer_net ?? 0)
    : undefined);
  const items = [
    { label: '外資', ratio: data.foreignRatio, ratioChange: data.foreignRatioChange, net: flow?.foreign_net, estimated: false },
    { label: '投信', ratio: data.trustRatio, ratioChange: data.trustRatioChange, net: flow?.trust_net, estimated: true },
    { label: '自營商', ratio: data.dealerRatio, ratioChange: data.dealerRatioChange, net: flow?.dealer_net, estimated: true },
    { label: '三大法人', ratio: data.totalRatio, ratioChange: data.totalRatioChange, net: totalNet, estimated: true },
  ];
  return <div className="rounded-lg border border-slate-800 bg-slate-950 p-2">
    <div className="mb-1.5 flex items-center justify-between gap-2"><b className="text-slate-300">{data.stale ? '法人持股狀態（歷史）' : '目前法人持股狀態'}</b><span className={data.stale ? 'text-[10px] text-amber-400' : 'text-[10px] text-slate-500'}>{data.date}{data.stale ? `（已 ${data.ageDays} 天）` : ''}</span></div>
    <div className="grid grid-cols-1 gap-1 sm:grid-cols-2 xl:grid-cols-4">{items.map((item) =>
      <HoldingMetric key={item.label} {...item} totalShares={totalShares} />
    )}</div>
    <div className="mt-1.5 flex flex-wrap items-center justify-between gap-1 text-[10px] text-slate-500"><span>持股張數以 TDCC 發行股數估算；外資比率為官方資料，投信、自營商與合計為歷史買賣超累計估算。</span><a href={data.sourceUrl} target="_blank" rel="noreferrer" className="text-cyan-500 hover:text-cyan-300">查看來源</a></div>
  </div>;
}

interface HoldingMetricProps {
  label: string;
  ratio: number;
  ratioChange: number | null;
  net: number | undefined;
  estimated: boolean;
  totalShares: number | null | undefined;
}

function HoldingMetric({ label, ratio, ratioChange, net, estimated, totalShares }: HoldingMetricProps) {
  const lots = totalShares ? Math.round(totalShares * ratio / 100 / 1000) : null;
  return <div className="rounded border border-slate-800/80 px-2 py-1.5">
    <div className="text-[10px] text-slate-500">{label}{estimated ? '（估）' : ''}</div>
    <b className="text-cyan-300">{lots == null ? '— 張' : `${lots.toLocaleString()} 張`}（{ratio.toFixed(2)}%）</b>
    <div className="mt-0.5 text-[10px] text-slate-500">較前一交易日 <SignedDailyChange shares={net} ratio={ratioChange} /></div>
  </div>;
}

function SignedDailyChange({ shares, ratio }: { shares: number | undefined; ratio: number | null }) {
  if (shares == null || ratio == null) return <span className="text-slate-600">—</span>;
  const lots = Math.trunc(shares / 1000);
  const positive = lots >= 0;
  return <b className={positive ? 'text-red-400' : 'text-emerald-400'}>
    {positive ? '+' : ''}{lots.toLocaleString()} 張（{ratio >= 0 ? '+' : ''}{ratio.toFixed(2)}%）
  </b>;
}

function ChipsSummary({ institutional }: Pick<ChipsDetailPanelProps, 'institutional'>) {
  return <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
    <TrendSummary label="外資動向" days={countConsecutive(institutional, 'foreign_net')} />
    <TrendSummary label="投信動向" days={countConsecutive(institutional, 'trust_net')} />
    <TrendSummary label="自營商動向" days={countConsecutive(institutional, 'dealer_net')} />
  </div>;
}

function TrendSummary({ label, days }: { label: string; days: number }) {
  const color = days > 0 ? 'text-red-400' : days < 0 ? 'text-emerald-400' : 'text-slate-500';
  const value = days > 0 ? `連買 ${days} 天` : days < 0 ? `連賣 ${Math.abs(days)} 天` : '無連續';
  return <div className="flex items-center justify-between rounded-lg border border-slate-800 bg-slate-950 p-2.5">
    <span className="text-slate-400">{label}</span><b className={color}>{value}</b>
  </div>;
}

function ChipsTables({ institutional, shareholding }: Pick<ChipsDetailPanelProps, 'institutional' | 'shareholding'>) {
  return <div className="overflow-x-auto">
    <div className="grid w-max grid-cols-[max-content_max-content] items-start gap-1.5">
      <DetailTable title="近 10 日法人買賣超" headers={['日期', '外資(張)', '投信(張)', '自營商(張)']}>
        {institutional.map((row) => <tr key={row.date} className="border-b border-slate-800/60">
          <td className="px-2 py-0.5 text-slate-400">{row.date}</td>
          <SignedLotsCell value={row.foreign_net} />
          <SignedLotsCell value={row.trust_net} />
          <SignedLotsCell value={row.dealer_net} />
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
    const controller = new AbortController();
    setLoading(true);
    setInstitutional([]);
    setShareholding([]);
    Promise.all([
      fetchStockInstitutional(stockId, controller.signal),
      fetchStockShareholding(stockId, controller.signal),
    ])
      .then(([institutions, holders]) => {
        if (controller.signal.aborted) return;
        setInstitutional(institutions.data); setShareholding(holders.data);
      })
      .catch(() => { if (!controller.signal.aborted) { setInstitutional([]); setShareholding([]); } })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [stockId]);

  return loading
    ? <section className="rounded-xl border border-slate-800 bg-slate-950/50 p-3"><h3 className="mb-3 border-b border-slate-800 pb-2 text-sm font-bold text-white">3 ⚡ 籌碼動能</h3><div className="py-4 text-center text-xs text-slate-500">載入中...</div></section>
    : <ChipsDetailPanel stockId={stockId} institutional={institutional} shareholding={shareholding} />;
}

function countConsecutive(rows: InstitutionalRow[], key: InstitutionalKey) {
  const firstValue = rows[0]?.[key] ?? 0;
  if (firstValue === 0) return 0;
  const direction = Math.sign(firstValue);
  let count = 0;
  for (const row of rows) {
    if (Math.sign(row[key] ?? 0) !== direction) break;
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

function SignedLotsCell({ value }: { value: number | undefined }) {
  if (value == null) return <td className="px-2 py-0.5 text-left font-semibold text-slate-600">—</td>;
  const lots = Math.trunc(value / 1000);
  return <td className={`px-2 py-0.5 text-left font-semibold ${lots >= 0 ? 'text-red-400' : 'text-emerald-400'}`}>{lots >= 0 ? '+' : ''}{lots.toLocaleString()}</td>;
}

function DetailTable({ title, headers, children }: { title: string; headers: string[]; children: ReactNode }) {
  return <div className="w-max overflow-hidden rounded-lg border border-slate-800">
    <div className="border-b border-slate-800 bg-slate-900/60 px-2 py-0.5 text-[11px] font-bold text-slate-300">{title}</div>
    <table className="w-auto text-xs font-mono"><thead><tr className="border-b border-slate-800 text-slate-500">{headers.map((header) => <th key={header} className="px-2 py-0.5 text-left font-semibold">{header}</th>)}</tr></thead><tbody>{children}</tbody></table>
  </div>;
}

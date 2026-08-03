import { useEffect, useState } from 'react';
import { AlertTriangle, ExternalLink } from 'lucide-react';
import { fetchStockTradeRisks, type StockTradeRiskResponse, type TradeRisk, type TradeRiskType } from '../lib/api';

const LABELS: Record<TradeRiskType, string> = {
  attention: '注意股', disposition: '處置股', trading_halt: '停止／暫停交易',
  margin_restricted: '融資限制（目前未支援）', short_sale_restricted: '融券限制', daytrade_restricted: '當沖限制',
};

function startText(risk: TradeRisk): string {
  if (risk.daysUntilStart > 0) return `${risk.daysUntilStart} 天後生效`;
  if (risk.daysUntilStart === 0) return risk.isActive ? '今日生效' : '生效日為今日';
  return '已生效';
}

function endText(risk: TradeRisk): string {
  if (risk.daysUntilEnd === null) return '官方未公告結束日';
  if (risk.daysUntilEnd > 0) return `${risk.daysUntilEnd} 天後結束`;
  if (risk.daysUntilEnd === 0) return '今日結束';
  return '已結束';
}

export function TradeRiskBanner({ stockId }: { stockId: string }) {
  const [data, setData] = useState<StockTradeRiskResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    setLoading(true); setError(null); setData(null);
    fetchStockTradeRisks(stockId)
      .then((value) => { if (current) setData(value); })
      .catch((reason) => { if (current) setError(reason instanceof Error ? reason.message : '交易風險載入失敗'); })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [stockId]);

  if (loading) return <div className="text-[10px] text-slate-500">交易風險資料載入中…</div>;
  if (error) return <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 px-3 py-2 text-xs text-amber-300">交易風險資料暫時無法取得：{error}</div>;
  if (!data || data.risks.length === 0) return null;

  const critical = data.highestLevel === 'critical';
  return (
    <section className={`rounded-xl border p-3 ${critical ? 'border-red-500/50 bg-red-500/10' : 'border-amber-500/40 bg-amber-500/10'}`}>
      <div className="mb-2 flex items-center gap-2 text-sm font-bold text-white">
        <AlertTriangle size={16} className={critical ? 'text-red-400' : 'text-amber-400'} />
        交易風險{data.hasActiveRisk ? '' : '（已公告、尚未生效）'}
      </div>
      <div className="space-y-2">
        {data.risks.map((risk) => (
          <article key={risk.id} className="rounded-lg border border-white/10 bg-slate-950/40 p-2 text-xs text-slate-300">
            <div className="flex flex-wrap items-center gap-2">
              <span className={`rounded px-2 py-0.5 font-bold ${risk.level === 'critical' ? 'bg-red-500/20 text-red-300' : risk.level === 'high' ? 'bg-orange-500/20 text-orange-300' : 'bg-amber-500/20 text-amber-300'}`}>{LABELS[risk.type]}</span>
              <span>{risk.startDate} ～ {risk.endDate || '未公告'}</span>
              <span className="text-cyan-300">{startText(risk)} · {endText(risk)}</span>
            </div>
            {risk.reason && <p className="mt-1">原因：{risk.reason}</p>}
            {risk.restrictions && <p className="mt-1 text-slate-400">限制：{risk.restrictions}</p>}
            <div className="mt-1 flex items-center gap-3 text-[10px] text-slate-500">
              <span>資料日 {risk.dataDate || '官方未提供'}</span>
              <a className="inline-flex items-center gap-1 text-cyan-400 hover:underline" href={risk.sourceUrl} target="_blank" rel="noreferrer">官方來源 <ExternalLink size={10} /></a>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

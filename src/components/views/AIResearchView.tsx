import { useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { AlertTriangle, Ban, Database, LoaderCircle, Play, ShieldCheck } from "lucide-react";
import { runAIResearch, type AIResearchReportSuccessResponse } from "../../lib/api";

type Report = AIResearchReportSuccessResponse;
type StrategyId = keyof Report["auditSummary"]["strategies"];

const STRATEGY_LABELS: Record<StrategyId, string> = {
  sr: "撐壓分析",
  ma: "均線趨勢",
  chips: "籌碼動能",
  pattern: "型態偵測",
};

const SIGNAL_LABELS: Record<string, string> = {
  BUY: "正向訊號", SELL: "負向訊號", HOLD: "中性訊號", UNKNOWN: "未判定",
};

const ERROR_LABELS: Record<string, string> = {
  invalid_stock_id: "股票代號格式錯誤",
  ai_research_stock_not_eligible: "此標的目前不符合研究資格",
  ai_research_context_unavailable: "研究來源目前無法取得",
  ai_research_insufficient_data: "目前資料不足，無法產生研究預覽",
  ai_research_provider_unavailable: "AI 研究來源目前無法使用",
  ai_research_provider_timeout: "AI 研究供應商回應逾時，請稍後再試",
  ai_research_provider_response_invalid: "AI 研究供應商回傳格式無效",
  ai_research_provider_rate_limited: "AI 研究供應商請求過於頻繁，請稍後再試",
  ai_research_provider_rejected: "AI 研究供應商拒絕請求，請檢查金鑰或權限",
  ai_research_provider_server_error: "AI 研究供應商服務異常，請稍後再試",
  ai_research_model_output_invalid: "AI 模型回傳內容未通過研究契約驗證",
  ai_research_timeout: "研究執行逾時，請稍後再試",
  ai_research_contract_error: "研究流程發生契約錯誤",
};

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-2xl border border-slate-800 bg-slate-900 p-4">
      <h2 className="mb-3 text-sm font-bold text-slate-100">{title}</h2>
      {children}
    </section>
  );
}

function ResearchForm({
  stockId, setStockId, loading, onSubmit, onCancel,
}: {
  stockId: string;
  setStockId: (value: string) => void;
  loading: boolean;
  onSubmit: (event: FormEvent) => void;
  onCancel: () => void;
}) {
  return (
    <header className="rounded-2xl border border-blue-500/30 bg-slate-900 p-4">
      <div className="flex items-start gap-3">
        <Database className="mt-0.5 text-blue-300" size={22} />
        <div><h1 className="text-lg font-bold text-white">AI 綜合研究</h1>
          <p className="mt-1 text-xs text-slate-400">建立可追溯、經伺服器語意驗證的綜合研究。</p></div>
      </div>
      <form onSubmit={onSubmit} className="mt-4 flex flex-wrap gap-2">
        <label className="min-w-44 flex-1 text-xs text-slate-400">
          股票代號
          <input value={stockId} onChange={(event) => setStockId(event.target.value)}
            disabled={loading} inputMode="numeric" placeholder="例如 2330"
            className="mt-1 w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2.5 text-sm text-white outline-none focus:border-blue-500" />
        </label>
        <div className="flex items-end gap-2">
          <button disabled={loading || !stockId.trim()} className="flex items-center gap-2 rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50">
            {loading ? <LoaderCircle className="animate-spin" size={17} /> : <Play size={17} />}
            {loading ? "執行中" : "產生 AI 綜合研究"}
          </button>
          {loading && <button type="button" onClick={onCancel}
            className="flex items-center gap-1 rounded-xl border border-slate-700 px-3 py-2.5 text-sm text-slate-200">
            <Ban size={16} />取消
          </button>}
        </div>
      </form>
    </header>
  );
}

function QualityPanel({ report }: { report: Report }) {
  const quality = report.auditSummary.dataQuality;
  return (
    <Section title="Data quality">
      <div className="flex flex-wrap gap-2 text-xs">
        <span className="rounded-full bg-blue-500/15 px-2.5 py-1 text-blue-200">Richness {quality.informationRichness}</span>
        <span className="rounded-full bg-slate-800 px-2.5 py-1 text-slate-200">{quality.status}</span>
      </div>
      {quality.missingDatasets.length > 0 && <p className="mt-3 text-xs text-amber-200">缺少：{quality.missingDatasets.join("、")}</p>}
      {quality.staleDatasets.length > 0 && <p className="mt-1 text-xs text-amber-200">可能過期：{quality.staleDatasets.join("、")}</p>}
      {quality.warnings.map((warning) => <p key={warning} className="mt-1 text-xs text-slate-400">{warning}</p>)}
    </Section>
  );
}

function ProviderPanel({ report }: { report: Report }) {
  return (
    <Section title="Provider / Model">
      <div className="space-y-2">
        {report.providerMetadata.map((item, index) => (
          <div key={`${item.provider}-${index}`} className="rounded-xl bg-slate-950/60 p-3 text-xs text-slate-300">
            <strong className="text-white">{item.provider}</strong> · {item.model}
            <span className="ml-2 text-slate-500">
              {item.durationMs === null ? "耗時無資料" : `${item.durationMs.toFixed(0)} ms`}
            </span>
          </div>
        ))}
      </div>
    </Section>
  );
}

function StrategyPanel({ report }: { report: Report }) {
  const entries = Object.entries(report.auditSummary.strategies) as Array<[
    StrategyId, Report["auditSummary"]["strategies"][StrategyId],
  ]>;
  return (
    <Section title="四大策略狀態">
      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        {entries.map(([id, strategy]) => <div key={id} className="rounded-xl bg-slate-950/60 p-3">
          <p className="text-xs text-slate-400">{STRATEGY_LABELS[id]}</p>
          <p className="mt-1 text-sm text-white">{strategy.status === "ok" ? SIGNAL_LABELS[strategy.signal] : strategy.status}</p>
          <p className="mt-1 text-[11px] text-slate-500">{strategy.date ?? "無資料"}</p>
        </div>)}
      </div>
    </Section>
  );
}

function PreviewPanel({ report }: { report: Report }) {
  const claims = report.draft?.claims ?? [];
  return (
    <Section title="機械驗證預覽">
      <div className="mb-3 flex items-center gap-2 rounded-xl border border-amber-600/40 bg-amber-950/30 p-3 text-xs text-amber-100">
        <ShieldCheck size={17} />此內容為 AI 機械驗證預覽，尚未完成語意發布驗證，不構成投資建議。
      </div>
      <div className="space-y-2">{claims.map((claim) => (
        <article key={claim.id} className="rounded-xl bg-slate-950/60 p-3">
          <p className="text-sm text-slate-100">{claim.text}</p>
          <p className="mt-1 text-[11px] text-slate-500">{claim.kind} · {claim.stance}</p>
        </article>
      ))}</div>
      {report.draft && <p className="mt-4 border-t border-slate-800 pt-3 text-sm text-slate-200">{report.draft.conclusion}</p>}
    </Section>
  );
}

function PublishedReportPanel({ report }: { report: Report }) {
  const published = report.publishedReport;
  if (!report.publicationReady || !published) return null;
  return <Section title="正式研究報告">
    <div className="mb-3 flex items-center gap-2 rounded-xl border border-emerald-600/40 bg-emerald-950/30 p-3 text-xs text-emerald-100">
      <ShieldCheck size={17} />事實由伺服器證據落地，目標價由伺服器計算；估值倍數仍是模型選擇的有界假設。
    </div>
    <p className="mb-3 text-[11px] text-slate-500">server-grounded · 發布時間 {published.generatedAt}</p>
    <div className="space-y-2">{published.claims.map((claim) => <article key={claim.id}
      className="rounded-xl bg-slate-950/60 p-3">
      <p className="text-sm text-slate-100">{claim.text}</p>
      <p className="mt-1 text-[11px] text-slate-500">{claim.kind} · {claim.stance} · server-grounded</p>
    </article>)}</div>
    <p className="mt-4 border-t border-slate-800 pt-3 text-sm text-slate-200">{published.conclusion}</p>
  </Section>;
}

function RecommendationPanel({ report }: { report: Report }) {
  const item = report.publicationReady && report.publishedReport
    ? report.publishedReport.recommendation : report.recommendation;
  const reportClaims = report.publishedReport?.claims ?? report.draft?.claims ?? [];
  const claims = new Map(reportClaims.map((entry) => [entry.id, entry.text]));
  const list = (ids: string[]) => ids.length === 0 ? "無資料"
    : ids.map((id) => claims.get(id) ?? id).join("；");
  return <Section title="綜合研究結論">
    {!item ? <p className="text-sm text-slate-400">現有資料不足以形成可驗證研究建議</p> : <div className="space-y-3">
      {!report.publicationReady && <p className="text-xs text-amber-200">模型候選預覽，尚未正式發布</p>}
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded-full bg-blue-500/20 px-3 py-1 text-sm font-bold text-blue-100">{item.verdict} · {item.label}</span>
        <span className="text-xs text-slate-400">研究期間 {item.horizonMonths} 個月</span>
        <span className="text-xs text-slate-400">模型信心值估計 {(item.confidence * 100).toFixed(0)}%（未經驗證）</span>
      </div>
      <p className="text-xs text-slate-300"><strong>支持因素：</strong>{list(item.supportingFindingIds)}</p>
      <p className="text-xs text-slate-300"><strong>反對因素：</strong>{list(item.opposingFindingIds)}</p>
      <p className="text-xs text-amber-200"><strong>主要風險：</strong>{list(item.riskFindingIds)}</p>
    </div>}
  </Section>;
}

const SCENARIO_LABELS = { conservative: "保守", base: "基準", optimistic: "樂觀" } as const;
const numberText = (value: number) => new Intl.NumberFormat("zh-TW", { maximumFractionDigits: 2 }).format(value);

function ValuationPanel({ report }: { report: Report }) {
  const item = report.publicationReady && report.publishedReport
    ? report.publishedReport.valuation : report.valuation;
  return <Section title="估值情境">
    {!item ? <p className="text-sm text-slate-400">現有資料不足以建立可驗證估值</p> : <>
      <div className="mb-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-300">
        <span>方法：{item.method}</span><span>現價：{numberText(item.currentPrice)}</span>
        <span>{item.metric.name}：{numberText(item.metric.value)}{item.metric.estimated ? "（估算）" : ""}</span>
        <span>財務期間：{item.metric.period}</span><span>source：{item.metric.sourceId}</span><span>as-of：{item.asOf}</span>
      </div>
      <div className="overflow-x-auto"><table className="w-full text-left text-xs">
        <thead className="text-slate-500"><tr><th className="py-2">情境</th><th>倍數</th><th>目標價</th><th>預期報酬</th></tr></thead>
        <tbody>{item.scenarios.map((scenario) => <tr key={scenario.name} className="border-t border-slate-800 text-slate-200">
          <td className="py-2">{SCENARIO_LABELS[scenario.name]}</td><td>{numberText(scenario.multiple)}x</td>
          <td>{numberText(scenario.targetPrice)}</td><td>{numberText(scenario.expectedReturnPercent)}%</td>
        </tr>)}</tbody>
      </table></div>
      <p className="mt-3 text-xs text-amber-200">目標價與預期報酬由伺服器計算；倍數為模型選擇的有界假設，不代表保證獲利</p>
    </>}
  </Section>;
}

function ProvenancePanel({ report }: { report: Report }) {
  return (
    <div className="grid gap-3 lg:grid-cols-2">
      <Section title="資料限制">
        {report.auditSummary.limitations.length === 0 ? <p className="text-sm text-slate-400">未列出額外限制</p>
          : report.auditSummary.limitations.map((item) => <p key={item} className="mb-1 text-xs text-amber-200">{item}</p>)}
      </Section>
      <Section title="Citations / 來源識別">
        {report.auditSummary.citations.map((item) => <p key={item.findingId} className="mb-1 text-xs text-slate-300">
          {item.findingId}: {item.evidenceIds.join("、")}
        </p>)}
        {report.auditSummary.sources.map((source) => <p key={source.id} className="mt-2 text-[11px] text-slate-500">
          {source.dataset} · {source.provider} · {source.asOf ?? "無日期"}
        </p>)}
      </Section>
    </div>
  );
}

function ReportView({ report }: { report: Report }) {
  if (report.publicationReady && !report.publishedReport) {
    return <div role="alert" className="rounded-2xl border border-rose-700/50 bg-rose-950/30 p-4 text-sm text-rose-200">
      研究報告契約錯誤：正式發布狀態缺少 publishedReport
    </div>;
  }
  return <div className="space-y-3"><div className="grid gap-3 lg:grid-cols-2">
    <QualityPanel report={report} /><ProviderPanel report={report} /></div>
    <StrategyPanel report={report} /><RecommendationPanel report={report} />
    <ValuationPanel report={report} />
    {report.publicationReady ? <PublishedReportPanel report={report} /> : <PreviewPanel report={report} />}
    <ProvenancePanel report={report} /></div>;
}

export function AIResearchView() {
  const [stockId, setStockId] = useState("2330");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<Report | null>(null);
  const active = useRef<AbortController | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const controller = new AbortController();
    active.current = controller;
    setLoading(true); setError(null); setReport(null);
    try { setReport(await runAIResearch(stockId.trim(), controller.signal)); }
    catch (cause) {
      if (!controller.signal.aborted) {
        const code = cause instanceof Error ? cause.message : "ai_research_contract_error";
        setError(ERROR_LABELS[code] ?? code);
      }
    } finally {
      if (active.current === controller) { active.current = null; setLoading(false); }
    }
  };

  return <div className="mx-auto w-full max-w-7xl space-y-3 pb-6">
    <ResearchForm stockId={stockId} setStockId={setStockId} loading={loading}
      onSubmit={(event) => { void submit(event); }} onCancel={() => active.current?.abort()} />
    {error && <div role="alert" className="flex gap-2 rounded-2xl border border-rose-700/50 bg-rose-950/30 p-4 text-sm text-rose-200">
      <AlertTriangle size={18} /><span>{error}</span></div>}
    {report && <ReportView report={report} />}
  </div>;
}

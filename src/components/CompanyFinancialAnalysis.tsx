import React, { useEffect, useMemo, useRef, useState } from "react";
import { Activity, AlertTriangle, Building2, Database, ShieldCheck } from "lucide-react";
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  fetchCompanyFinancialAnalysis,
  type CompanyFinancialAnalysisData,
  type FinancialMetricQuality,
  type FinancialTabId,
} from "../lib/api";

interface CompanyFinancialAnalysisProps {
  stockId: string;
}

const TAB_LABELS: Record<FinancialTabId, string> = {
  operations: "經營分析",
  profitability: "獲利分析",
  health: "財務健全度",
};

const QUALITY_LABELS: Record<FinancialMetricQuality, string> = {
  good: "品質良好",
  stale: "資料較舊",
  partial: "部分缺漏",
  no_data: "無資料",
  not_applicable: "不適用",
};

const QUALITY_STYLES: Record<FinancialMetricQuality, string> = {
  good: "border-emerald-500/30 bg-emerald-500/10 text-emerald-300",
  stale: "border-amber-500/30 bg-amber-500/10 text-amber-300",
  partial: "border-amber-500/30 bg-amber-500/10 text-amber-300",
  no_data: "border-slate-700 bg-slate-800/70 text-slate-400",
  not_applicable: "border-slate-700 bg-slate-800/70 text-slate-400",
};

const CHARTS = {
  operations: [
    { key: "revenue", name: "營收（億元）", color: "#22d3ee", axis: "left" },
    { key: "operatingCashFlow", name: "營業現金流（億元）", color: "#34d399", axis: "left" },
    { key: "freeCashFlow", name: "自由現金流（億元）", color: "#f59e0b", axis: "left" },
  ],
  profitability: [
    { key: "grossMargin", name: "毛利率（%）", color: "#22d3ee", axis: "left" },
    { key: "operatingMargin", name: "營業利益率（%）", color: "#a78bfa", axis: "left" },
    { key: "netMargin", name: "淨利率（%）", color: "#34d399", axis: "left" },
    { key: "eps", name: "EPS（元）", color: "#f59e0b", axis: "right" },
  ],
  health: [
    { key: "currentRatio", name: "流動比率（%）", color: "#22d3ee", axis: "left" },
    { key: "debtRatio", name: "負債比率（%）", color: "#f87171", axis: "left" },
    { key: "debtToEquity", name: "負債權益比（%）", color: "#a78bfa", axis: "left" },
    { key: "cashRatio", name: "現金比率（%）", color: "#34d399", axis: "left" },
  ],
} as const;

const FINANCIAL_CHARTS = {
  operations: [
    { key: "netIncome", name: "淨利（億元）", color: "#22d3ee", axis: "left" },
    { key: "eps", name: "EPS（元）", color: "#f59e0b", axis: "right" },
  ],
  profitability: [
    { key: "netIncome", name: "淨利（億元）", color: "#34d399", axis: "left" },
    { key: "eps", name: "EPS（元）", color: "#f59e0b", axis: "right" },
  ],
  health: [
    { key: "equity", name: "淨值（億元）", color: "#a78bfa", axis: "left" },
  ],
} as const;

function FinancialChart({ data, tabId, financialIndustry }: { data: CompanyFinancialAnalysisData["tabs"][FinancialTabId]["trend"]; tabId: FinancialTabId; financialIndustry: boolean }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerSize, setContainerSize] = useState<{ width: number; height: number } | null>(null);
  const lines = financialIndustry ? FINANCIAL_CHARTS[tabId] : CHARTS[tabId];
  const hasRightAxis = lines.some((line) => line.axis === "right");

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const updateSize = () => {
      const { width, height } = element.getBoundingClientRect();
      const nextSize = width > 0 && height > 0
        ? { width: Math.round(width), height: Math.round(height) }
        : null;
      setContainerSize((current) => current?.width === nextSize?.width && current?.height === nextSize?.height
        ? current
        : nextSize);
    };
    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  if (!data.length) {
    return <div className="flex h-72 items-center justify-center text-sm text-slate-500">無資料</div>;
  }
  return (
    <div ref={containerRef} className="h-72 w-full min-w-0">
      {containerSize && containerSize.width > 0 && containerSize.height > 0 ? <LineChart
        width={containerSize.width}
        height={containerSize.height}
        data={data}
        margin={{ top: 8, right: 16, left: 0, bottom: 0 }}
      >
        <CartesianGrid stroke="#1e293b" strokeDasharray="3 3" />
        <XAxis dataKey="period" stroke="#64748b" tick={{ fontSize: 10 }} />
        <YAxis yAxisId="left" stroke="#64748b" tick={{ fontSize: 10 }} width={52} />
        {hasRightAxis && (
          <YAxis yAxisId="right" orientation="right" stroke="#f59e0b" tick={{ fontSize: 10 }} width={42} />
        )}
        <Tooltip
          contentStyle={{ background: "#020617", border: "1px solid #334155", borderRadius: 8, fontSize: 12 }}
          labelStyle={{ color: "#cbd5e1" }}
        />
        <Legend wrapperStyle={{ fontSize: 11, paddingTop: 8 }} />
        {lines.map((line) => (
          <Line
            key={line.key}
            type="monotone"
            dataKey={line.key}
            name={line.name}
            yAxisId={line.axis}
            stroke={line.color}
            strokeWidth={2}
            dot={false}
            connectNulls={false}
          />
        ))}
      </LineChart> : null}
    </div>
  );
}

export function CompanyFinancialAnalysis({ stockId }: CompanyFinancialAnalysisProps) {
  const [activeTab, setActiveTab] = useState<FinancialTabId>("operations");
  const [data, setData] = useState<CompanyFinancialAnalysisData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    fetchCompanyFinancialAnalysis(stockId, controller.signal)
      .then(setData)
      .catch((reason: unknown) => {
        if (controller.signal.aborted) return;
        setError(reason instanceof Error ? reason.message : "財務資料讀取失敗");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [stockId]);

  const tab = data?.tabs[activeTab];
  const sources = useMemo(() => [...new Set(tab?.sources || [])].join("、") || "無資料", [tab]);

  return (
    <section className="min-w-0 border-b border-slate-800/80 bg-slate-950/70 px-3 py-4" aria-labelledby="company-financial-title">
      <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <Building2 size={18} className="text-cyan-400" />
            <h4 id="company-financial-title" className="text-sm font-bold tracking-wider text-slate-100">公司財務分析</h4>
          </div>
          <p className="mt-1 text-[11px] text-slate-500">後端程式化計算 · 不使用 Goodinfo 爬蟲</p>
        </div>
        {data && (
          <span className={`w-fit rounded border px-2 py-1 text-[10px] ${QUALITY_STYLES[data.quality.status]}`}>
            <ShieldCheck size={11} className="mr-1 inline" />{QUALITY_LABELS[data.quality.status]}
          </span>
        )}
      </div>

      <div className="mb-4 grid grid-cols-3 gap-1 rounded-lg border border-slate-800 bg-slate-900/70 p-1" role="tablist">
        {(Object.keys(TAB_LABELS) as FinancialTabId[]).map((id) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={activeTab === id}
            onClick={() => setActiveTab(id)}
            className={`rounded-md px-2 py-2 text-xs font-bold transition-colors ${activeTab === id ? "bg-cyan-500/15 text-cyan-300 ring-1 ring-cyan-500/30" : "text-slate-400 hover:bg-slate-800 hover:text-slate-200"}`}
          >
            {TAB_LABELS[id]}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="flex min-h-72 flex-col items-center justify-center gap-3 text-xs text-slate-400">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-cyan-400 border-t-transparent" />
          正在整理最近三年季度財報…
        </div>
      ) : error ? (
        <div className="flex min-h-44 items-center justify-center gap-2 rounded-lg border border-amber-500/20 bg-amber-500/5 text-sm text-amber-300">
          <AlertTriangle size={17} />{error || "無資料"}
        </div>
      ) : !tab ? (
        <div className="flex min-h-44 items-center justify-center text-sm text-slate-500">無資料</div>
      ) : (
        <div className="min-w-0 space-y-4">
          <div className="grid min-w-0 grid-cols-2 gap-2 lg:grid-cols-4">
            {tab.kpis.map((item) => (
              <article key={item.id} className="rounded-lg border border-slate-800 bg-slate-900/75 p-3">
                <div className="text-[11px] text-slate-400">{item.label}</div>
                <div className="mt-1 text-xl font-bold tabular-nums text-slate-100">
                  {item.display}{item.value != null && item.unit !== "%" ? <span className="ml-1 text-xs font-normal text-slate-500">{item.unit}</span> : null}
                </div>
                <div className="mt-2 space-y-0.5 text-[9px] leading-relaxed text-slate-500">
                  <div>期間：{item.period}</div>
                  <div className="truncate" title={item.source}>來源：{item.source}</div>
                  <div className={item.quality === "good" ? "text-emerald-400" : ["no_data", "not_applicable"].includes(item.quality) ? "text-slate-500" : "text-amber-400"}>
                    品質：{QUALITY_LABELS[item.quality]}
                  </div>
                  <div className="truncate" title={`${item.dataset} / ${item.type} / ${item.originName}`}>依據：{item.dataset} · {item.type}</div>
                  <div>報表日：{item.reportDate} · {item.periodBasis}</div>
                </div>
              </article>
            ))}
          </div>

          <div className="min-w-0 rounded-lg border border-slate-800 bg-slate-900/50 p-3">
            <div className="mb-2 flex flex-col gap-1 text-xs sm:flex-row sm:items-center sm:justify-between">
              <span className="flex items-center gap-1.5 font-bold text-slate-300"><Activity size={14} className="text-cyan-400" />最近三年季度趨勢</span>
              <span className="text-[10px] text-slate-500">期間：{tab.period}</span>
            </div>
            <FinancialChart data={tab.trend} tabId={activeTab} financialIndustry={Boolean(data?.isFinancialIndustry)} />
          </div>

          <div className="rounded-lg border border-cyan-500/20 bg-cyan-500/5 p-3">
            <div className="mb-2 text-xs font-bold text-cyan-300">程式化重點摘要</div>
            <ul className="space-y-1.5 text-xs leading-relaxed text-slate-300">
              {tab.summaries.map((item) => <li key={item}>• {item}</li>)}
            </ul>
          </div>

          <div className="flex flex-col gap-1 border-t border-slate-800 pt-2 text-[10px] text-slate-500 sm:flex-row sm:items-center sm:justify-between">
            <span><Database size={11} className="mr-1 inline" />來源：本機 SQLite 個股識別、{sources}、StockSnapshot</span>
            <span>資料品質：{QUALITY_LABELS[tab.quality]} · 截至 {data?.asOf || "無資料"} · 單位依圖例／卡片標示</span>
          </div>
        </div>
      )}
    </section>
  );
}

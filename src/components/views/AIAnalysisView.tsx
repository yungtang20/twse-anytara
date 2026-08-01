/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import {
  Search,
  Sparkles,
  Square,
  Maximize2,
  Minimize2,
  CheckCircle2,
  Circle,
  Clock,
  ChevronDown,
  RefreshCw,
  AlertCircle,
  Copy,
  Check,
  Settings,
  Trash2,
} from "lucide-react";

type FrameworkStatus = "pending" | "running" | "done" | "error" | "cancelled";

type FrameworkPollData = {
  status?: FrameworkStatus;
  report?: string;
  evidenceSummary?: {
    numericClaimLines?: number;
    supportedClaimLines?: number;
    coverage?: number;
    warnings?: string[];
    redactedLines?: number;
    invalidEvidenceIds?: string[];
  };
  error?: string;
};

type EvidenceSummary = {
  numericClaimLines: number;
  supportedClaimLines: number;
  coverage: number;
  quality: "normal" | "warning" | "low";
  canRetry: boolean;
  reasons: string[];
  message: string;
};

type FrameworkMeta = {
  id: string;
  name: string;
  icon: React.ReactNode;
  desc: string;
};

type JobRecord = {
  id: string;
  stockId: string;
  stockName?: string;
  status?: FrameworkStatus | "done" | "running" | "error" | "cancelled" | "created";
  frameworkIds: string[];
  perFramework?: Record<string, FrameworkPollData>;
  startedAt?: number;
  updatedAt?: number;
};

type SettingsStatus = {
  hasNvidiaKey?: boolean;
  hasFinmindKey?: boolean;
  nvidiaModel?: string;
};

const STEPS = [
  { id: 0, label: "Step 1", sub: "輸入股票代碼" },
  { id: 1, label: "Step 2", sub: "選擇報告框架" },
  { id: 2, label: "Step 3", sub: "確認並開始" },
  { id: 3, label: "Result", sub: "執行中/完成" },
];

const FRAMEWORKS: FrameworkMeta[] = [
  { id: "berkshire", name: "波克夏 Berkshire Board", icon: <Sparkles size={14} className="text-amber-500" />, desc: "報告內容：長期價值投資、護城河、股東盈餘、自由現金流、DCF 與安全邊際，適合判斷是否值得長期持有。" },
  { id: "goldman", name: "高盛 Goldman Sachs", icon: <Sparkles size={14} />, desc: "報告內容：投行式 pitch-book，涵蓋投資評等、總經假設、估值區間、財務預測、情境分析與目標價邏輯。" },
  { id: "morgan_stanley", name: "摩根士丹利 Morgan Stanley", icon: <Sparkles size={14} />, desc: "報告內容：技術分析，包含趨勢支撐壓力、均線、RSI、MACD、量價關係、進場停損與交易設定。" },
  { id: "bridgewater", name: "橋水 Bridgewater", icon: <Sparkles size={14} />, desc: "報告內容：風險配置視角，分析波動率、VaR、最大回撤、壓力測試、總經循環與下行情境。" },
  { id: "jpmorgan", name: "摩根大通 J.P. Morgan", icon: <Sparkles size={14} />, desc: "報告內容：基本面與財報品質，聚焦營收 YoY/QoQ、EPS、毛利率、資產負債表與風險報酬。" },
  { id: "blackrock", name: "貝萊德 BlackRock", icon: <Sparkles size={14} />, desc: "報告內容：資產配置與長期投資，涵蓋 ETF 配置、股息、自由現金流、產業權重與投資組合定位。" },
  { id: "citadel", name: "城堡 Citadel", icon: <Sparkles size={14} />, desc: "報告內容：量化交易與市場結構，觀察動能、估值、波動率、法人籌碼、流動性與短線交易風險。" },
  { id: "renaissance", name: "文藝復興 Renaissance Tech", icon: <Sparkles size={14} />, desc: "報告內容：統計與因子訊號，檢查報酬、波動率、PER、RSI、異常值與可量化的交易假設。" },
  { id: "vanguard", name: "先鋒 Vanguard", icon: <Sparkles size={14} />, desc: "報告內容：低成本長期配置，重點是指數化思維、股息率、長期報酬、核心衛星配置與再平衡。" },
  { id: "deshaw", name: "D.E. Shaw 量化期權", icon: <Sparkles size={14} />, desc: "報告內容：波動率與期權策略，討論 ATR、歷史 VaR、避險結構、Greeks 限制與量化風控。" },
  { id: "twosigma", name: "Two Sigma 數據科學", icon: <Sparkles size={14} />, desc: "報告內容：多因子資料科學，評估 1M/6M 報酬、波動率、RSI、MACD、訊號穩定度與資料品質。" },
  { id: "hedge_fund", name: "對沖基金 Multi-Strategy", icon: <Sparkles size={14} />, desc: "報告內容：多策略整合，結合法人籌碼、事件催化、財務體質、現金流、槓桿與風險控管。" },
  { id: "industry", name: "產業研究 Industry", icon: <Sparkles size={14} />, desc: "報告內容：產業與同業比較，分析月營收、毛利率、EPS、供需、競爭格局與產業鏈位置。" },
];

const STOCK_NAME_MAP: Record<string, string> = {
  "2303": "聯電",
  "2317": "鴻海",
  "2330": "台積電",
  "2454": "聯發科",
  "2603": "長榮",
  "2881": "富邦金",
  "2882": "國泰金",
  "3231": "緯創",
  "2308": "台達電",
};

const stripEvidenceBlock = (text: string) => {
  const markers = ["## 證據覆蓋", "## 霅", "## Evidence"];
  const idx = markers
    .map((marker) => text.indexOf(marker))
    .filter((pos) => pos >= 0)
    .sort((a, b) => a - b)[0];
  return idx < 0 ? text : text.slice(0, idx).trimEnd();
};

const getStockName = (job: { stockName?: string; stockId: string }) =>
  job.stockName || STOCK_NAME_MAP[job.stockId] || `股票(${job.stockId})`;

const getFrameworkName = (id: string) => FRAMEWORKS.find((f) => f.id === id)?.name || id;

const getCoverageSummary = (input?: FrameworkPollData["evidenceSummary"]): EvidenceSummary | null => {
  if (!input) return null;
  const numericClaimLines = input.numericClaimLines ?? 0;
  const supportedClaimLines = input.supportedClaimLines ?? 0;
  const coverage = numericClaimLines === 0 ? 100 : Math.round((input.coverage ?? 0) * 100);
  const redactedLines = input.redactedLines ?? 0;
  const invalidEvidenceCount = input.invalidEvidenceIds?.length ?? 0;
  const missing = Math.max(0, numericClaimLines - supportedClaimLines);
  const reasons: string[] = [];
  if (missing > 0) reasons.push(`有 ${missing} 筆含數值的文字沒有完整可追溯引用，系統已遮蔽或排除。`);
  if (invalidEvidenceCount > 0) reasons.push(`有 ${invalidEvidenceCount} 個引用 ID 無法在 FinMind/快照資料中對應。`);
  if (redactedLines > 0) reasons.push(`有 ${redactedLines} 行數值因證據不足被清理，避免顯示無法驗證的數字。`);
  if (coverage < 100 && reasons.length === 0) reasons.push("部分數值陳述缺少可驗證來源；不是 FinMind 沒抓到全部資料，而是生成文字未完整附上合法引用。");
  return {
    numericClaimLines,
    supportedClaimLines,
    coverage,
    quality: coverage >= 85 ? "normal" : coverage >= 70 ? "warning" : "low",
    canRetry: missing > 0,
    reasons,
    message: `可驗證數值陳述：${supportedClaimLines}/${numericClaimLines}｜覆蓋率：${coverage}%`,
  };
};

const coverageQualityLabel = {
  normal: "可信度：正常",
  warning: "可信度：警告",
  low: "可信度：低可信草稿",
} as const;

const coverageQualityClass = {
  normal: "border-emerald-700/60 bg-emerald-950/40 text-emerald-200",
  warning: "border-amber-700/60 bg-amber-950/40 text-amber-200",
  low: "border-rose-700/60 bg-rose-950/40 text-rose-200",
} as const;

function StepPanel({ title, sub, children }: { title: string; sub: string; children: React.ReactNode }) {
  return (
    <div className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden">
      <div className="px-3 py-1.5 bg-slate-950/50 border-b border-slate-800">
        <h3 className="text-sm font-bold text-white">{title}</h3>
        <p className="text-[10px] text-slate-400">{sub}</p>
      </div>
      <div className="p-2.5 md:p-3">{children}</div>
    </div>
  );
}

export function AIAnalysisView() {
  const [step, setStep] = useState(0);
  const [stockId, setStockId] = useState("2330");
  const [jobId, setJobId] = useState<string | null>(null);
  const [selected, setSelected] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(FRAMEWORKS.map((f) => [f.id, f.id === "berkshire"]))
  );
  const [statuses, setStatuses] = useState<Record<string, FrameworkStatus>>(
    () => Object.fromEntries(FRAMEWORKS.map((f) => [f.id, "pending"])) as Record<string, FrameworkStatus>
  );
  const [reports, setReports] = useState<Record<string, string>>({});
  const [summaries, setSummaries] = useState<Record<string, EvidenceSummary | null>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [elapsed, setElapsed] = useState(0);
  const [recentJobs, setRecentJobs] = useState<JobRecord[]>([]);
  const [settingsStatus, setSettingsStatus] = useState<SettingsStatus | null>(null);
  const [isRefreshingDebug, setIsRefreshingDebug] = useState(false);
  const [deletingJobId, setDeletingJobId] = useState<string | null>(null);
  const [isClearingJobs, setIsClearingJobs] = useState(false);
  const [copied, setCopied] = useState(false);
  const [showDebug, setShowDebug] = useState(false);
  const pollRef = useRef<number | null>(null);
  const timerRef = useRef<number | null>(null);
  const startRef = useRef<number>(0);

  const selectedFrameworks = FRAMEWORKS.filter((f) => selected[f.id]);
  const selectedCount = selectedFrameworks.length;
  const doneCount = selectedFrameworks.filter((f) => statuses[f.id] === "done").length;
  const runningCount = selectedFrameworks.filter((f) => statuses[f.id] === "running").length;
  const progressPct = selectedCount === 0 ? 0 : Math.min(100, Math.round(((doneCount + runningCount * 0.2) / selectedCount) * 100));

  const clearAllTimers = () => {
    if (pollRef.current) clearInterval(pollRef.current);
    if (timerRef.current) clearInterval(timerRef.current);
    pollRef.current = null;
    timerRef.current = null;
  };
  const applyFrameworkProgress = (job: Pick<JobRecord, "perFramework">) => {
    const nextStatuses = { ...statuses } as Record<string, FrameworkStatus>;
    const nextReports = { ...reports };
    const nextSummaries = { ...summaries };
    const nextErrors = { ...errors };

    FRAMEWORKS.forEach((f) => {
      const p = job.perFramework?.[f.id];
      if (!p) return;
      nextStatuses[f.id] = p.status || "pending";
      if (p.report) nextReports[f.id] = p.report;
      if (p.evidenceSummary) nextSummaries[f.id] = getCoverageSummary(p.evidenceSummary);
      if (p.error) nextErrors[f.id] = p.error;
      else if (p.status === "done" || p.status === "cancelled") delete nextErrors[f.id];
    });

    setStatuses(nextStatuses);
    setReports(nextReports);
    setSummaries(nextSummaries);
    setErrors(nextErrors);
  };

  const fetchDebugInfo = async (): Promise<JobRecord[]> => {
    setIsRefreshingDebug(true);
    try {
      const [jobsRes, settingsRes] = await Promise.all([fetch("/api/job"), fetch("/api/settings")]);
      let list: JobRecord[] = [];
      if (jobsRes.ok) {
        const jobsJson = (await jobsRes.json()) as { success?: boolean; jobs?: JobRecord[] };
        if (jobsJson?.success && Array.isArray(jobsJson.jobs)) {
          list = jobsJson.jobs;
          setRecentJobs(list);
        }
      }
      if (settingsRes.ok) {
        const settingJson = (await settingsRes.json()) as SettingsStatus;
        setSettingsStatus(settingJson);
      }
      return list;
    } catch (error) {
      console.error("fetch debug info failed", error);
      return [];
    } finally {
      setIsRefreshingDebug(false);
    }
  };

  const startPolling = (jid: string) => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = window.setInterval(async () => {
      try {
        const r = await fetch(`/api/job/${jid}`);
        const j = (await r.json()) as { success?: boolean; job?: JobRecord & { perFramework?: Record<string, FrameworkPollData> } };
        if (!j?.success || !j?.job) return;
        const job = j.job;
        setLoading(job.status === "running");
        applyFrameworkProgress(job);
        if (job.status === "done" || job.status === "error" || job.status === "cancelled") {
          clearAllTimers();
          setStep(3);
          setElapsed(Math.floor((Date.now() - startRef.current) / 1000));
          setLoading(false);
          void fetchDebugInfo();
        }
      } catch (error) {
        console.error("poll failed", error);
      }
    }, 3000);
  };

  const autoRestoreJob = async (job: JobRecord) => {
    if (!job) return;
    try {
      const r = await fetch(`/api/job/${job.id}`);
      const j = (await r.json()) as { success?: boolean; job?: JobRecord };
      if (!j?.success || !j?.job) return;
      const target = j.job;
      setJobId(target.id);
      setStockId(target.stockId);
      setStep(3);
      setElapsed(
        target.startedAt && target.updatedAt ? Math.floor((target.updatedAt - target.startedAt) / 1000) : 0
      );
      setSelected(Object.fromEntries(FRAMEWORKS.map((f) => [f.id, target.frameworkIds.includes(f.id)])));
      applyFrameworkProgress(target);
      if (target.status === "running") {
        setLoading(true);
        startRef.current = target.startedAt || Date.now();
        timerRef.current = window.setInterval(() => {
          setElapsed(Math.floor((Date.now() - startRef.current) / 1000));
        }, 1000);
        startPolling(target.id);
      } else {
        setLoading(false);
      }
    } catch (error) {
      console.error("autoRestoreJob failed", error);
    }
  };

  useEffect(() => {
    void (async () => {
      const list = await fetchDebugInfo();
      if (list.length > 0 && list[0]?.status === "running") {
        await autoRestoreJob(list[0]);
      }
    })();
    return () => clearAllTimers();
  }, []);

  const startRun = async () => {
    if (!/^\d{4}$/.test(stockId.trim())) {
      alert("股票代碼必須是4位數字");
      return;
    }
    if (selectedCount === 0) {
      alert("至少要選一個框架");
      return;
    }

    const sid = stockId.trim();
    clearAllTimers();
    setLoading(true);
    setElapsed(0);
    setReports({});
    setErrors({});
    setSummaries({});
    setStatuses(Object.fromEntries(FRAMEWORKS.map((f) => [f.id, "pending"])) as Record<string, FrameworkStatus>);
    setStep(3);
    startRef.current = Date.now();
    timerRef.current = window.setInterval(() => {
      setElapsed(Math.floor((Date.now() - startRef.current) / 1000));
    }, 1000);

    try {
      const frameworks = selectedFrameworks.map((f) => f.id);
      const resp = await fetch("/api/job/batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stock_id: sid, frameworks }),
      });
      const payload = (await resp.json()) as { success?: boolean; job_id?: string; error?: string };
      if (!resp.ok || !payload?.success || !payload.job_id) throw new Error(payload?.error || "建立任務失敗");
      setJobId(payload.job_id);
      startPolling(payload.job_id);
      void fetchDebugInfo();
    } catch (error) {
      const message = error instanceof Error ? error.message : "啟動失敗";
      alert(message);
      setLoading(false);
      clearAllTimers();
      setStep(2);
    }
  };

  const stopCurrent = async () => {
    clearAllTimers();
    setLoading(false);
    if (!jobId) return;
    try {
      const resp = await fetch(`/api/job/${jobId}/cancel`, { method: "POST" });
      const payload = (await resp.json()) as { success?: boolean; job?: JobRecord };
      if (payload?.success && payload.job) applyFrameworkProgress(payload.job);
    } catch (error) {
      console.error(error);
    }
    setStep(3);
    void fetchDebugInfo();
  };

  const deleteHistoryJob = async (id: string) => {
    if (!window.confirm("要刪除這筆歷史分析嗎？")) return;
    try {
      setDeletingJobId(id);
      const resp = await fetch(`/api/job/${id}`, { method: "DELETE" });
      const payload = (await resp.json()) as { success?: boolean; error?: string };
      if (!resp.ok || !payload?.success) throw new Error(payload?.error || "刪除失敗");
      void fetchDebugInfo();
    } catch (error) {
      alert(error instanceof Error ? error.message : "刪除失敗");
    } finally {
      setDeletingJobId((current) => (current === id ? null : current));
    }
  };

  const clearAllHistoryJobs = async () => {
    if (recentJobs.length === 0) return;
    if (!window.confirm(`確定清除全部 ${recentJobs.length} 筆歷史分析？`)) return;
    try {
      setIsClearingJobs(true);
      const resp = await fetch("/api/jobs", { method: "DELETE" });
      const payload = (await resp.json()) as { success?: boolean; error?: string };
      if (!resp.ok || !payload?.success) throw new Error(payload?.error || "清空失敗");
      void fetchDebugInfo();
    } catch (error) {
      alert(error instanceof Error ? error.message : "清空失敗");
    } finally {
      setIsClearingJobs(false);
    }
  };

  const toggleFramework = (id: string) => setSelected((prev) => ({ ...prev, [id]: !prev[id] }));
  const toggleExpand = (id: string) => setExpanded((prev) => ({ ...prev, [id]: !prev[id] }));

  return (
    <div className="w-full space-y-2.5 pb-4">
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-1.5 md:p-2">
        <div className="grid grid-cols-4 gap-1.5">
          {STEPS.map((s, i) => {
            const active = i === step;
            const done = i < step;
            return (
              <button
                key={s.id}
                onClick={() => !loading && i <= step && setStep(i)}
                className={`text-left p-1.5 rounded-lg border ${
                  active
                    ? "bg-blue-500/10 border-blue-500/40 text-blue-300"
                    : done
                      ? "bg-emerald-500/8 border-emerald-500/30 text-emerald-300"
                      : "bg-slate-950 border-slate-800 text-slate-500"
                }`}
              >
                <div className="text-[11px] font-bold">{`${i + 1}. ${s.label}`}</div>
                <p className="text-[10px] text-slate-400">{s.sub}</p>
              </button>
            );
          })}
        </div>
      </div>

      {step === 0 && (
        <StepPanel title="Step 1" sub="輸入代碼並管理歷史報告">
          <div className="space-y-3">
            <div className="bg-slate-950 border border-slate-800 p-3 rounded-xl flex gap-2">
              <div className="relative flex-1">
                <Search className="absolute left-3 top-3 text-slate-500" size={14} />
                <input
                  type="text"
                  value={stockId}
                  maxLength={4}
                  onChange={(e) => setStockId(e.target.value.replace(/[^\d]/g, ""))}
                  placeholder="2330"
                  className="w-full bg-transparent border-0 pl-9 pr-3 py-2 text-slate-100 font-mono focus:outline-none"
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && /^\d{4}$/.test(stockId.trim())) setStep(1);
                  }}
                />
              </div>
              <button
                onClick={() => /^\d{4}$/.test(stockId.trim()) && setStep(1)}
                disabled={!/^\d{4}$/.test(stockId.trim())}
                className="px-5 py-2 bg-blue-600 rounded-lg text-sm disabled:bg-slate-700"
              >
                下一步
              </button>
            </div>

            {recentJobs.length > 0 && (
              <div className="bg-slate-900 border border-slate-800 rounded-xl p-2.5 space-y-2">
                <div className="flex items-center gap-2">
                  <Clock size={14} className="text-blue-400" />
                  <span className="text-sm text-slate-300">歷史分析報告</span>
                  <button
                    className="ml-auto text-[11px] border border-rose-500/40 text-rose-300 px-2 py-1 rounded"
                    onClick={clearAllHistoryJobs}
                    disabled={isClearingJobs}
                  >
                    {isClearingJobs ? "清空中..." : "Clear all"}
                  </button>
                </div>
                <div className="grid grid-cols-[repeat(auto-fit,minmax(240px,1fr))] gap-2">
                  {recentJobs.slice(0, 6).map((job) => {
                    const done = Object.values(job.perFramework || {}).filter((x) => x.status === "done").length;
                    const total = job.frameworkIds?.length || 0;
                    const canOpen = done > 0;
                    const reportNames = (job.frameworkIds || []).map(getFrameworkName);
                    return (
                      <div key={job.id} className="border border-slate-800 rounded-lg bg-slate-950/70 p-2">
                        <div className="flex items-start justify-between gap-2">
                          <button
                            className="min-w-0 flex-1 text-left disabled:cursor-not-allowed disabled:opacity-60"
                            onClick={() => canOpen && autoRestoreJob(job)}
                            disabled={!canOpen}
                          >
                            <div>
                              <div className="text-sm font-semibold text-slate-100">
                                {getStockName(job)}({job.stockId})
                              </div>
                              <div className="text-[11px] text-slate-400">完成 {done}/{total}</div>
                            </div>
                          </button>
                          <div className="flex shrink-0 items-center gap-1">
                            <span className={`text-[10px] px-2 py-1 rounded border ${
                              job.status === "done"
                                ? "border-emerald-500/40 text-emerald-300"
                                : job.status === "running"
                                  ? "border-blue-500/40 text-blue-300"
                                  : "border-slate-700 text-slate-400"
                            }`}>
                              {job.status || "created"}
                            </span>
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                if (deletingJobId) return;
                                void deleteHistoryJob(job.id);
                              }}
                              disabled={deletingJobId === job.id}
                              title="刪除"
                              className="px-2 py-1 border border-rose-500/40 text-rose-300 rounded text-xs"
                            >
                              {deletingJobId === job.id ? "..." : <Trash2 size={13} />}
                            </button>
                          </div>
                        </div>
                        <button
                          className="mt-1 w-full truncate text-left text-[11px] text-slate-400 disabled:cursor-not-allowed disabled:opacity-60"
                          onClick={() => canOpen && autoRestoreJob(job)}
                          disabled={!canOpen}
                        >
                          使用報告：{reportNames.join("、")}
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        </StepPanel>
      )}

      {step === 1 && (
        <StepPanel title="Step 2 選擇報告框架" sub={`已選 ${selectedCount} / ${FRAMEWORKS.length} 個框架`}>
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-3 space-y-3">
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setSelected(Object.fromEntries(FRAMEWORKS.map((f) => [f.id, true])) as Record<string, boolean>)}
                className="text-xs px-3 py-1.5 rounded bg-slate-800 border border-slate-700 text-slate-200 hover:bg-slate-700"
              >
                全選
              </button>
              <button
                type="button"
                onClick={() => setSelected(Object.fromEntries(FRAMEWORKS.map((f) => [f.id, false])) as Record<string, boolean>)}
                className="text-xs px-3 py-1.5 rounded bg-slate-800 border border-slate-700 text-slate-200 hover:bg-slate-700"
              >
                清除
              </button>
            </div>

            <div className="grid grid-cols-[repeat(auto-fit,minmax(260px,1fr))] gap-2">
              {FRAMEWORKS.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  onClick={() => toggleFramework(f.id)}
                  className={`text-left p-2.5 rounded-xl border transition-all ${
                    selected[f.id]
                      ? "bg-blue-500/5 border-blue-500/40 text-white"
                      : "bg-slate-950 border-slate-800/70 text-slate-500 opacity-60"
                  }`}
                >
                  <div className="flex items-start gap-1.5 mb-1">
                    <span className="text-blue-400 shrink-0 mt-0.5">{f.icon}</span>
                    <span className="text-xs font-bold leading-snug">{f.name}</span>
                  </div>
                  <p className="text-[11px] opacity-80 leading-snug">{f.desc}</p>
                </button>
              ))}
            </div>

            <div className="flex gap-2.5">
              <button
                type="button"
                onClick={() => setStep(0)}
                className="px-4 py-2.5 bg-slate-800 border border-slate-700 rounded-lg text-sm font-semibold text-slate-200"
              >
                上一步
              </button>
              <button
                type="button"
                onClick={() => setStep(2)}
                disabled={selectedCount === 0}
                className="flex-1 px-6 py-2.5 bg-blue-600 hover:bg-blue-500 disabled:bg-slate-700 rounded-lg text-sm font-bold"
              >
                確認選擇
              </button>
            </div>
          </div>
        </StepPanel>
      )}

      {step === 2 && (
        <StepPanel title="Step 3" sub="確認並開始分析">
          <div className="space-y-4">
            <div className="text-sm">
              股票代碼：<span className="text-blue-300 font-mono">{stockId}</span> ｜ 已選框架：<span className="text-blue-300">{selectedCount}</span> ｜
              AI：<span className="text-blue-300">{settingsStatus?.hasNvidiaKey ? settingsStatus.nvidiaModel || "z-ai/glm-5.2" : "未設定"}</span>
            </div>
            <div className="flex gap-2">
              <button className="px-4 py-2 bg-slate-700 rounded" onClick={() => setStep(1)}>上一步</button>
              <button
                className="px-4 py-2 bg-gradient-to-r from-blue-600 to-indigo-500 rounded"
                onClick={() => void startRun()}
              >
                開始產生 {selectedCount} 份報告
              </button>
            </div>
          </div>
        </StepPanel>
      )}

      {step === 3 && (
        <StepPanel title="分析結果" sub={`完成 ${doneCount}/${selectedCount} ｜ ${elapsed} 秒`}>
          <div className="space-y-4">
            <div className="bg-slate-900 border border-slate-800 p-3 rounded-xl">
              <div className="flex justify-between text-xs text-slate-300">
                <span>Progress</span>
                <span>{progressPct}%</span>
              </div>
              <div className="w-full h-2 bg-slate-700 rounded mt-2">
                <div className="h-full bg-blue-500" style={{ width: `${progressPct}%` }} />
              </div>
            </div>

            <div className="flex justify-end gap-2 text-xs">
              <button
                className="px-3 py-2 bg-slate-700 rounded"
                onClick={() => setStep(0)}
              >
                重設
              </button>
              {loading && (
                <button onClick={() => void stopCurrent()} className="px-3 py-2 bg-rose-700 rounded">
                  <Square size={14} className="inline mr-1" /> 停止
                </button>
              )}
            </div>

            <div className="grid grid-cols-[repeat(auto-fit,minmax(340px,1fr))] gap-2.5">
              {selectedFrameworks.map((f) => {
                const st = statuses[f.id] || "pending";
                const rep = reports[f.id] || "";
                const isExpanded = expanded[f.id];
                const summary = summaries[f.id];
                const cleanedRep = stripEvidenceBlock(rep);
                return (
                  <div key={f.id} className="border border-slate-800 rounded-xl p-3 bg-slate-950">
                    <div className="flex items-center justify-between mb-2">
                      <span className="font-bold">{f.name}</span>
                      <span className="text-xs text-slate-400">
                        {st === "done" ? <CheckCircle2 size={13} /> : st === "running" ? <Clock size={13} /> : st === "error" ? <AlertCircle size={13} /> : <Circle size={13} />}
                      </span>
                    </div>
                    <p className="text-[10px] text-slate-400">{f.desc}</p>

                    {summary && (
                      <div className="mt-3 rounded-lg border border-slate-800 bg-slate-900/70 p-3">
                        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
                          <span className="text-slate-300">可驗證數值陳述：<span className="font-mono text-blue-300">{summary.supportedClaimLines}/{summary.numericClaimLines}</span></span>
                          <span className="text-slate-300">覆蓋率：<span className="font-mono text-blue-300">{summary.coverage}%</span></span>
                          <span className={`rounded-full border px-2 py-0.5 ${coverageQualityClass[summary.quality]}`}>{coverageQualityLabel[summary.quality]}</span>
                        </div>
                        {summary.coverage < 100 && (
                          <div className="mt-2 text-[11px] leading-relaxed text-amber-200">
                            未達 100% 原因：{summary.reasons.length ? summary.reasons.join(" ") : "部分數值陳述缺少可驗證來源。"}
                          </div>
                        )}
                      </div>
                    )}
                    {st === "error" && <p className="text-rose-400 text-[11px]">{errors[f.id] || "執行錯誤"}</p>}
                    {summary?.canRetry && (
                      <button
                        className="text-xs text-blue-300 underline mt-2"
                        onClick={() => void startRun()}
                      >
                        覆蓋率不足，重試一次
                      </button>
                    )}

                    {st === "done" && (
                      <>
                        <button onClick={() => toggleExpand(f.id)} className="mt-2 text-xs px-2 py-1 border rounded">
                          {isExpanded ? <><Minimize2 size={12} /> 收合</> : <><Maximize2 size={12} /> 展開</>}
                        </button>
                        {isExpanded && (
                          <div className="report-markdown mt-3 bg-slate-900 border border-slate-700 rounded-lg p-4 max-h-[36rem] overflow-auto">
                            <ReactMarkdown>{cleanedRep}</ReactMarkdown>
                          </div>
                        )}
                      </>
                    )}
                  </div>
                );
              })}
            </div>

            {loading && (
              <div className="text-center text-slate-300 text-sm p-3">
                <RefreshCw size={16} className="inline animate-spin mr-2" />
                分析中，正在生成 {selectedCount} 份報告
              </div>
            )}
          </div>
        </StepPanel>
      )}

      <div className="bg-slate-900 border border-slate-800 rounded-2xl">
        <button
          className="w-full px-4 py-3 flex items-center justify-between"
          onClick={() => setShowDebug((v) => !v)}
        >
          <span className="flex items-center gap-2"><Settings size={14} /> 除錯面板</span>
          <ChevronDown size={14} className={showDebug ? "rotate-180" : ""} />
        </button>
        {showDebug && (
          <div className="p-4 text-xs text-slate-300 space-y-3">
            <div className="flex items-center justify-between">
              <span>NVIDIA: {settingsStatus?.hasNvidiaKey ? "已設" : "未設"}</span>
              <span>FinMind: {settingsStatus?.hasFinmindKey ? "已設" : "未設"}</span>
              <button className="px-2 py-1 bg-slate-800 rounded" onClick={() => void fetchDebugInfo()}>
                <RefreshCw size={12} className={isRefreshingDebug ? "animate-spin" : ""} />
              </button>
            </div>
            <button
              onClick={async () => {
                const payload = {
                  timestamp: new Date().toISOString(),
                  localTime: new Date().toLocaleString(),
                  currentStock: stockId,
                  activeJobId: jobId,
                  selectedCount,
                  doneCount,
                  progressPct,
                  settings: {
                    hasNvidiaKey: !!settingsStatus?.hasNvidiaKey,
                    nvidiaModel: settingsStatus?.nvidiaModel,
                    hasFinmindKey: !!settingsStatus?.hasFinmindKey,
                  },
                };
                const block = "### AI 問題診斷\n```json\n" + JSON.stringify(payload, null, 2) + "\n```";
                await navigator.clipboard.writeText(block);
                setCopied(true);
                window.setTimeout(() => setCopied(false), 2000);
              }}
              className="px-3 py-2 bg-blue-600 rounded"
            >
              {copied ? <Check size={12} /> : <Copy size={12} />} 複製診斷資訊
            </button>
          </div>
        )}
      </div>
    </div>
  );
}


// StepFlow — 统壹所有 5 页面的执行流程可视化 (Dashboard/Markets/Strategies/Settings/AI 共用)
// 显示: 步骤图标+标签 + 状态 (pending/active/done/error) + 实时日志 + 预估剩馀 + 取消按钮
import React, { useEffect, useRef } from "react";
import { CheckCircle2, Circle, Loader2, XOctagon, Clock, Terminal, Square } from "lucide-react";

export interface StepItem {
  id: string;
  label: string;
  icon?: React.ReactNode;
}

export interface StepStatuses {
  [stepId: string]: "pending" | "active" | "done" | "error";
}

export interface StepFlowProps {
  steps: StepItem[];
  statuses: StepStatuses;  logs?: string[];
  logLimit?: number;
  estimatedSecs?: number;
  elapsedSecs?: number;
  onCancel?: () => void;
  className?: string;
  compact?: boolean; // 竖式卡片 vs 横式 chip
  title?: string;
}

export function StepFlow({
  steps,
  statuses,
  logs = [],
  logLimit = 25,
  estimatedSecs,
  elapsedSecs = 0,
  onCancel,
  className = "",
  compact = false,
  title = "執行流程",
}: StepFlowProps) {
  const logRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => { if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight; }, [logs]);

  if (compact) return <ChipFlow steps={steps} statuses={statuses} className={className} />;

  const remaining = Math.max(0, (estimatedSecs || 0) - elapsedSecs);
  const remainingTxt = remaining >= 60
    ? `${Math.floor(remaining / 60)}m ${remaining % 60}s`
    : `${remaining}s`;
  const doneCount = steps.filter((s) => statuses[s.id] === "done").length;

  return (
    <div className={`bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden ${className}`}>
      <div className="px-5 py-3 bg-slate-950/50 border-b border-slate-800 flex items-center justify-between">
        <h3 className="text-sm font-bold text-white flex items-center gap-1.5">
          <Clock size={14} className="text-blue-400" /> {title}
        </h3>
        <div className="flex items-center gap-3 text-[10px]">
          <span className="text-slate-400">{doneCount}/{steps.length} 完成</span>
          {estimatedSecs ? <span className="text-blue-400 font-mono">剩 ~{remainingTxt}</span> : null}
          {elapsedSecs > 0 ? <span className="text-slate-500 font-mono">經過 {elapsedSecs}s</span> : null}
          {onCancel ? (
            <button onClick={onCancel} className="text-rose-400 hover:text-rose-300 flex items-center gap-1 cursor-pointer ml-2">
              <Square size={10} /> 取消
            </button>
          ) : null}
        </div>
      </div>

      <div className="p-4">
        {/* 横向步骤列 */}
        <div className="flex items-stretch gap-1 mb-3 overflow-x-auto">
          {steps.map((s, i) => {
            const st = statuses[s.id] || "pending";
            return (
              <React.Fragment key={s.id}>
                <div className={`flex-1 min-w-[70px] p-2 rounded-lg border text-center transition-all ${
                  st === "active" ? "bg-blue-500/10 border-blue-500/50 text-blue-400 animate-pulse"
                    : st === "done" ? "bg-emerald-500/5 border-emerald-500/30 text-emerald-400"
                    : st === "error" ? "bg-rose-500/5 border-rose-500/30 text-rose-400"
                      : "bg-slate-950 border-slate-800/80 text-slate-500"
                }`}>
                  <div className="flex justify-center mb-1">
                    {st === "active" ? <Loader2 size={14} className="animate-spin" />
                      : st === "done" ? <CheckCircle2 size={14} />
                      : st === "error" ? <XOctagon size={14} />
                      : s.icon ? s.icon : <Circle size={14} />}
                  </div>
                  <div className="text-[9px] font-bold truncate">{s.label}</div>
                  <div className="text-[8px] opacity-70">{st === "active" ? "執行中..." : st === "done" ? "✓" : st === "error" ? "ERR" : "PENDING"}</div>
                </div>
                {i < steps.length - 1 ? (
                  <div className={`w-2 flex items-center justify-center ${
                    statuses[steps[i].id] === "done" ? "text-emerald-500" : "text-slate-700"
                  }`}>›</div>
                ) : null}
              </React.Fragment>
            );
          })}
        </div>

        {/* 进度条 */}
        <div className="w-full h-1.5 bg-slate-800 rounded-full overflow-hidden mb-3">
          <div className="h-full bg-gradient-to-r from-blue-500 to-indigo-500 transition-all duration-500"
            style={{ width: `${(doneCount / steps.length) * 100}%` }} />
        </div>

        {/* 日志窗 (可选) */}
        {logs.length > 0 ? (
          <div ref={logRef} className="bg-slate-950 border border-slate-800 rounded-lg p-2.5 max-h-28 overflow-y-auto font-mono text-[9px] text-slate-400 space-y-0.5 scrollbar-thin scrollbar-thumb-slate-800">
            {logs.slice(-logLimit).map((l, i) => (
              <div key={i} className={`leading-snug ${
                l.includes("[ERR]") || l.includes("❌") ? "text-rose-400"
                  : l.includes("✅") ? "text-emerald-400"
                  : l.includes("[WARN]") || l.includes("⚠️") ? "text-amber-400"
                  : "text-slate-400"
              }`}>{l}</div>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

// 紧凑 chip 模式 (适合内嵌于现有卡片)
function ChipFlow({ steps, statuses, className = "" }: { steps: StepItem[]; statuses: StepStatuses; className?: string }) {
  const doneCount = steps.filter((s) => statuses[s.id] === "done").length;
  return (
    <div className={`flex items-center gap-2 ${className}`}>
      {steps.map((s) => {
        const st = statuses[s.id] || "pending";
        return (
          <div key={s.id} className={`px-2.5 py-1 rounded-full border text-[10px] font-bold flex items-center gap-1 transition-all ${
            st === "active" ? "bg-blue-500/10 border-blue-500/40 text-blue-400 animate-pulse"
              : st === "done" ? "bg-emerald-500/5 border-emerald-500/30 text-emerald-400"
              : st === "error" ? "bg-rose-500/5 border-rose-500/30 text-rose-400"
                : "bg-slate-900 border-slate-700 text-slate-500"
          }`}>
            {st === "active" ? <Loader2 size={10} className="animate-spin" />
              : st === "done" ? <CheckCircle2 size={10} />
              : st === "error" ? <XOctagon size={10} />
              : <Circle size={10} />}
            {s.label}
          </div>
        );
      })}
      <span className="text-[9px] text-slate-500 ml-auto font-mono">{doneCount}/{steps.length}</span>
    </div>
  );
}

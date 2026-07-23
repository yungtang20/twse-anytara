import React from "react";
import { LayoutDashboard, TrendingUp, BarChart3, Settings, Bot } from "lucide-react";
import { AppView } from "../types";

interface SidebarProps {
  currentView: AppView;
  onViewChange: (view: AppView) => void;
}

export function Sidebar({ currentView, onViewChange }: SidebarProps) {
  return (
    <aside className="flex min-h-screen w-full min-w-0 flex-col overflow-hidden bg-slate-900 border-r border-slate-800">
      <div className="h-12 flex items-center px-3 border-b border-slate-800 cursor-pointer" onClick={() => onViewChange("dashboard")}>
        <h1 className="text-lg font-bold bg-gradient-to-r from-blue-400 to-indigo-500 bg-clip-text text-transparent tracking-tight">
          TRINITY
        </h1>
      </div>
      <nav className="flex-1 px-2 py-3 space-y-1">
        <NavItem id="dashboard" icon={<LayoutDashboard size={18} />} label="儀表板" active={currentView === "dashboard"} onClick={() => onViewChange("dashboard")} />
        <NavItem id="markets" icon={<TrendingUp size={18} />} label="市場分析" active={currentView === "markets"} onClick={() => onViewChange("markets")} />
        <NavItem id="strategies" icon={<BarChart3 size={18} />} label="策略模組" active={currentView === "strategies"} onClick={() => onViewChange("strategies")} />
        <NavItem id="ai-analysis" icon={<Bot size={18} />} label="AI 深度分析" active={currentView === "ai-analysis"} onClick={() => onViewChange("ai-analysis")} />
        <div className="pt-4 pb-1">
          <p className="px-2 text-[10px] font-semibold text-slate-500 uppercase tracking-wider">系統</p>
        </div>
        <NavItem id="settings" icon={<Settings size={18} />} label="設定" active={currentView === "settings"} onClick={() => onViewChange("settings")} />
      </nav>
      <div className="p-2 border-t border-slate-800 text-[10px] text-slate-500 text-center">
        v1.0.0-beta
      </div>
    </aside>
  );
}

function NavItem({ id, icon, label, active = false, onClick }: { id: AppView; icon: React.ReactNode; label: string; active?: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      title={label}
      className={`w-full min-w-0 flex items-center gap-2 px-2 py-2 rounded-lg text-xs font-medium transition-colors ${
        active
          ? "bg-blue-500/10 text-blue-400"
          : "text-slate-400 hover:bg-slate-800/50 hover:text-slate-200"
      }`}
    >
      <span className="flex-shrink-0">{icon}</span>
      <span className="truncate">{label}</span>
    </button>
  );
}

import React from "react";
import { LayoutDashboard, TrendingUp, BarChart3, Settings, Bot } from "lucide-react";
import { AppView } from "../types";

interface BottomNavProps {
  currentView: AppView;
  onViewChange: (view: AppView) => void;
}

export function BottomNav({ currentView, onViewChange }: BottomNavProps) {
  const navItems = [
    { id: 'dashboard', icon: <LayoutDashboard size={20} />, label: "儀表板" },
    { id: 'markets', icon: <TrendingUp size={20} />, label: "分析" },
    { id: 'strategies', icon: <BarChart3 size={20} />, label: "策略" },
    { id: 'ai-analysis', icon: <Bot size={20} />, label: "AI 綜合研究" },
    { id: 'settings', icon: <Settings size={20} />, label: "設定" },
  ] as const;

  return (
    <nav className="md:hidden fixed bottom-0 left-0 right-0 h-[calc(4rem+env(safe-area-inset-bottom))] pb-[env(safe-area-inset-bottom)] bg-slate-900 border-t border-slate-800 flex items-center justify-around z-50">
      {navItems.map((item) => (
        <button
          type="button"
          key={item.id}
          onClick={() => onViewChange(item.id as AppView)}
          aria-current={currentView === item.id ? "page" : undefined}
          className={`flex flex-col items-center justify-center w-full h-16 space-y-1 transition-colors ${
            currentView === item.id 
              ? 'text-blue-400' 
              : 'text-slate-500 hover:text-slate-300'
          }`}
        >
          {item.icon}
          <span className="text-[10px] font-medium">{item.label}</span>
        </button>
      ))}
    </nav>
  );
}

import React, { useCallback, useEffect, useState } from "react";
import { Sidebar } from "./Sidebar";
import { BottomNav } from "./BottomNav";
import { AppView } from "../types";

interface LayoutProps {
  children: React.ReactNode;
  currentView: AppView;
  onViewChange: (view: AppView) => void;
}

const SIDEBAR_MIN = 132;
const SIDEBAR_DEFAULT = 152;
const SIDEBAR_MAX = 320;
const SIDEBAR_STORAGE_KEY = "trinity-sidebar-width-v2";

export function clampSidebarWidth(width: number, viewportWidth: number) {
  return Math.min(Math.max(width, SIDEBAR_MIN), Math.min(SIDEBAR_MAX, viewportWidth * 0.36));
}

export function Layout({ children, currentView, onViewChange }: LayoutProps) {
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const saved = Number(globalThis.localStorage?.getItem(SIDEBAR_STORAGE_KEY));
    return Number.isFinite(saved) && saved > 0 ? saved : SIDEBAR_DEFAULT;
  });
  const [isResizing, setIsResizing] = useState(false);

  const resizeSidebar = useCallback((width: number) => {
    const next = clampSidebarWidth(width, window.innerWidth);
    setSidebarWidth(next);
    localStorage.setItem(SIDEBAR_STORAGE_KEY, String(Math.round(next)));
  }, []);

  useEffect(() => {
    const handleViewportResize = () => resizeSidebar(sidebarWidth);
    window.addEventListener("resize", handleViewportResize);
    return () => window.removeEventListener("resize", handleViewportResize);
  }, [resizeSidebar, sidebarWidth]);

  useEffect(() => {
    if (!isResizing) return;
    const handlePointerMove = (event: PointerEvent) => resizeSidebar(event.clientX);
    const stopResizing = () => setIsResizing(false);
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", stopResizing, { once: true });
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", stopResizing);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, [isResizing, resizeSidebar]);

  const handleSeparatorKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const widths: Record<string, number> = {
      ArrowLeft: sidebarWidth - 16,
      ArrowRight: sidebarWidth + 16,
      Home: SIDEBAR_MIN,
      End: SIDEBAR_MAX,
    };
    if (!(event.key in widths)) return;
    event.preventDefault();
    resizeSidebar(widths[event.key]);
  };

  return (
    <div className="flex min-h-screen bg-slate-950 text-slate-200 selection:bg-blue-500/30">
      <div className="relative hidden min-h-screen flex-shrink-0 md:flex" style={{ width: sidebarWidth }}>
        <Sidebar currentView={currentView} onViewChange={onViewChange} />
        <div
          role="separator"
          aria-label="調整導覽列寬度"
          aria-orientation="vertical"
          aria-valuemin={SIDEBAR_MIN}
          aria-valuemax={Math.round(Math.min(SIDEBAR_MAX, globalThis.innerWidth * 0.45))}
          aria-valuenow={Math.round(sidebarWidth)}
          tabIndex={0}
          onPointerDown={(event) => {
            event.preventDefault();
            setIsResizing(true);
          }}
          onKeyDown={handleSeparatorKeyDown}
          className={`group absolute inset-y-0 -right-1 z-30 w-2 touch-none cursor-col-resize outline-none ${isResizing ? "bg-blue-500/15" : "hover:bg-blue-500/10"}`}
        >
          <span className={`absolute inset-y-0 left-1/2 w-px -translate-x-1/2 transition-colors ${isResizing ? "bg-blue-400" : "bg-slate-800 group-hover:bg-blue-500 group-focus:bg-blue-500"}`} />
        </div>
      </div>
      <div className="min-w-0 flex-1 flex flex-col relative overflow-hidden pb-16 md:pb-0">
        <main className="flex-1 p-1.5 md:p-2 overflow-y-auto w-full">
          <div className="min-w-0 w-full space-y-3">
            {children}
          </div>
        </main>
      </div>
      <BottomNav currentView={currentView} onViewChange={onViewChange} />
    </div>
  );
}

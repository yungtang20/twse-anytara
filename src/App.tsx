/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { Layout } from "./components/Layout";
import { AppView } from "./types";
import { appViewHash, parseAppView } from "./lib/navigation";

const DashboardView = lazy(() => import("./components/views/DashboardView").then((module) => ({ default: module.DashboardView })));
const MarketsView = lazy(() => import("./components/views/MarketsView").then((module) => ({ default: module.MarketsView })));
const StrategiesView = lazy(() => import("./components/views/StrategiesView").then((module) => ({ default: module.StrategiesView })));
const SettingsView = lazy(() => import("./components/views/SettingsView").then((module) => ({ default: module.SettingsView })));
const AIResearchView = lazy(() => import("./components/views/AIResearchView").then((module) => ({ default: module.AIResearchView })));

export default function App() {
  const [currentView, setCurrentView] = useState<AppView>(() =>
    parseAppView(globalThis.location?.hash || "")
  );

  useEffect(() => {
    const handleHashChange = () => setCurrentView(parseAppView(globalThis.location.hash));
    globalThis.addEventListener("hashchange", handleHashChange);
    return () => globalThis.removeEventListener("hashchange", handleHashChange);
  }, []);

  const handleViewChange = useCallback((view: AppView) => {
    setCurrentView(view);
    globalThis.history.replaceState(null, "", appViewHash(view));
  }, []);

  return (
    <Layout currentView={currentView} onViewChange={handleViewChange}>
      <Suspense fallback={<div className="flex min-h-48 items-center justify-center text-sm text-slate-500" role="status">載入功能模組…</div>}>
        {currentView === 'dashboard' && <DashboardView />}
        {currentView === 'markets' && <MarketsView />}
        {currentView === 'strategies' && <StrategiesView />}
        {currentView === 'settings' && <SettingsView />}
        {currentView === 'ai-analysis' && <AIResearchView />}
      </Suspense>
    </Layout>
  );
}

/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useState } from "react";
import { Layout } from "./components/Layout";
import { DashboardView } from "./components/views/DashboardView";
import { MarketsView } from "./components/views/MarketsView";
import { StrategiesView } from "./components/views/StrategiesView";
import { SettingsView } from "./components/views/SettingsView";
import { AIAnalysisView } from "./components/views/AIAnalysisView";
import { AppView } from "./types";
import { appViewHash, parseAppView } from "./lib/navigation";

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
      {currentView === 'dashboard' && <DashboardView />}
      {currentView === 'markets' && <MarketsView />}
      {currentView === 'strategies' && <StrategiesView />}
      {currentView === 'settings' && <SettingsView />}
      {currentView === 'ai-analysis' && <AIAnalysisView />}
    </Layout>
  );
}


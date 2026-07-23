/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState } from "react";
import { Layout } from "./components/Layout";
import { DashboardView } from "./components/views/DashboardView";
import { MarketsView } from "./components/views/MarketsView";
import { StrategiesView } from "./components/views/StrategiesView";
import { SettingsView } from "./components/views/SettingsView";
import { AIAnalysisView } from "./components/views/AIAnalysisView";
import { AppView } from "./types";

export default function App() {
  const [currentView, setCurrentView] = useState<AppView>('ai-analysis');

  return (
    <Layout currentView={currentView} onViewChange={setCurrentView}>
      {currentView === 'dashboard' && <DashboardView />}
      {currentView === 'markets' && <MarketsView />}
      {currentView === 'strategies' && <StrategiesView />}
      {currentView === 'settings' && <SettingsView />}
      {currentView === 'ai-analysis' && <AIAnalysisView />}
    </Layout>
  );
}



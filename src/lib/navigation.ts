import type { AppView } from "../types";

export const DEFAULT_APP_VIEW: AppView = "markets";

const APP_VIEWS = new Set<AppView>([
  "dashboard",
  "markets",
  "strategies",
  "settings",
  "ai-analysis",
]);

export function parseAppView(hash: string): AppView {
  const candidate = hash.replace(/^#\/?/, "") as AppView;
  return APP_VIEWS.has(candidate) ? candidate : DEFAULT_APP_VIEW;
}

export function appViewHash(view: AppView): string {
  return `#/${view}`;
}

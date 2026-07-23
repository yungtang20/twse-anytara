export type AppView = 'dashboard' | 'markets' | 'strategies' | 'settings' | 'ai-analysis';

export interface MarketStat {
  title: string;
  value: string;
  change: number;
  changePercent: number;
}

export interface ChartDataPoint {
  time: string;
  value: number;
}

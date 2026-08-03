export type ResearchSourceProvider = "supabase" | "finmind" | "external-estimate";
export type ResearchSourceStatus = "available" | "unavailable" | "error";
export type StrategyId = "sr" | "ma" | "chips" | "pattern";
export type StrategySignal = "BUY" | "HOLD" | "SELL" | "UNKNOWN";

export interface ResearchSource {
  id: string;
  dataset: string;
  provider: ResearchSourceProvider;
  asOf: string | null;
  retrievedAt: string;
  rowCount: number;
  estimated: boolean;
  status: ResearchSourceStatus;
  error: string | null;
}

export interface ResearchDataset<T> {
  data: T;
  source: ResearchSource;
  sources?: ResearchSource[];
}

export interface StrategyResearchResult {
  strategy: StrategyId;
  status: "ok" | "unavailable" | "error";
  date: string | null;
  score: number | null;
  signal: StrategySignal;
  confidence: number | null;
  summary: string | null;
  details: Record<string, unknown>;
}

export interface ResearchMetric {
  key: string;
  value: number | null;
  available: boolean;
  unit: string;
  period: string | null;
  sourceId: string | null;
}

export interface ResearchContext extends Record<string, unknown> {
  schemaVersion: 1;
  stockId: string;
  asOf: string | null;
  company: { name: string | null; market: string | null; industry: string | null };
  market: {
    latestDate: string | null;
    price: number | null;
    history: Array<Record<string, unknown>>;
  };
  fundamentals: {
    status: "complete" | "partial" | "unavailable";
    metrics: ResearchMetric[];
    missing: string[];
  };
  institutional: {
    dailyFlows: Array<{
      date: string;
      foreignNet: number | null;
      trustNet: number | null;
      dealerNet: number | null;
      institutionalNet: number | null;
    }>;
  };
  tdcc: {
    date: string | null;
    source: string | null;
    totalShares: number | null;
    whaleRatio: number | null;
    retailRatio: number | null;
    totalPeople: number | null;
    whaleShares: number | null;
    whalePeople: number | null;
  };
  tradeRisks: {
    highestLevel: "none" | "medium" | "high" | "critical";
    flags: Array<Record<string, unknown>>;
    dataAsOf: string | null;
  };
  strategies: Record<StrategyId, StrategyResearchResult>;
  quality: {
    status: "complete" | "partial";
    missingDatasets: string[];
    staleDatasets: string[];
    warnings: string[];
  };
  sources: ResearchSource[];
}

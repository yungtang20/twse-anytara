import type {
  AIResearchDataQuality,
  PublishedResearchReport,
  ResearchAuditDraft,
  RenderedResearchClaim,
  ServerCalculatedValuation,
  ServerInvestmentRecommendation,
} from "./aiResearch";
import type { ResearchSourceProvider, StrategyId, StrategyResearchResult } from "./researchContext";

export interface AIResearchReportStrategySummary {
  status: StrategyResearchResult["status"];
  date: string | null;
  signal: StrategyResearchResult["signal"];
}

export interface AIResearchReportSourceSummary {
  id: string;
  dataset: string;
  provider: ResearchSourceProvider;
  asOf: string | null;
  estimated: boolean;
}

export interface AIResearchReportContext {
  dataQuality: AIResearchDataQuality;
  strategies: Record<StrategyId, AIResearchReportStrategySummary>;
  sources: AIResearchReportSourceSummary[];
}

export interface AIResearchReportAuditSummary {
  mechanicalPassed: boolean;
  citationCoverage: number;
  warnings: string[];
  dataQuality: AIResearchDataQuality;
  strategies: AIResearchReportContext["strategies"];
  limitations: string[];
  citations: Array<{ findingId: string; evidenceIds: string[] }>;
  sources: AIResearchReportSourceSummary[];
}

export interface AIResearchReportProviderMetadata {
  provider: "hcnsec" | "custom" | "router" | "fake";
  model: string;
  durationMs: number | null;
  usage: { inputTokens: number | null; outputTokens: number | null };
}

interface AIResearchReportSuccessBase {
  success: true;
  auditSummary: AIResearchReportAuditSummary;
  providerMetadata: AIResearchReportProviderMetadata[];
}

export type AIResearchReportSuccessResponse = AIResearchReportSuccessBase & ({
  publicationReady: true;
  semanticGrounding: "server-grounded";
  publishedReport: PublishedResearchReport;
  draft: null;
  recommendation: null;
  valuation: null;
} | {
  publicationReady: false;
  semanticGrounding: "unverified";
  publishedReport: null;
  draft: ResearchAuditDraft | null;
  recommendation: ServerInvestmentRecommendation | null;
  valuation: ServerCalculatedValuation | null;
});

export type AIResearchReportErrorCode = "invalid_stock_id" | "ai_research_loopback_required"
  | "ai_research_stock_not_eligible" | "ai_research_context_unavailable"
  | "ai_research_insufficient_data" | "ai_research_provider_unavailable"
  | "ai_research_provider_timeout" | "ai_research_provider_response_invalid"
  | "ai_research_provider_rate_limited" | "ai_research_provider_rejected"
  | "ai_research_provider_server_error"
  | "ai_research_model_output_invalid" | "ai_research_aborted" | "ai_research_timeout"
  | "ai_research_contract_error";

export interface AIResearchReportErrorResponse {
  success: false;
  error: AIResearchReportErrorCode;
}

export type AIResearchReportResponse = AIResearchReportSuccessResponse | AIResearchReportErrorResponse;

export type AIResearchPreviewClaim = RenderedResearchClaim;

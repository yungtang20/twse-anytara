import type { ResearchContext, ResearchSource, StrategyId } from "./researchContext";

export type InformationRichnessGrade = "A" | "B" | "C";

export const AI_RESEARCH_NON_CITABLE_PATHS = [
  "schemaVersion", "contextFingerprint", "dataQuality.*", "sources.*", "evidence.*",
  "fundamentals.status", "fundamentals.missing.*",
  "fundamentals.metrics.*.key", "fundamentals.metrics.*.available",
  "fundamentals.metrics.*.unit", "fundamentals.metrics.*.period", "fundamentals.metrics.*.sourceId",
  "strategies.*.strategy",
] as const;

export interface ResearchEvidence {
  id: string;
  dataset: string;
  field: string;
  value: number | string | boolean | null;
  unit: string;
  date: string | null;
  sourceId: string;
  estimated: boolean;
  available: boolean;
}

export type AIResearchDataQuality = ResearchContext["quality"] & {
  informationRichness: InformationRichnessGrade;
};

export interface AIResearchPacket {
  schemaVersion: 1;
  stockId: string;
  asOf: string | null;
  company: ResearchContext["company"];
  market: Pick<ResearchContext["market"], "latestDate" | "price">;
  fundamentals: ResearchContext["fundamentals"];
  institutional: ResearchContext["institutional"];
  tdcc: ResearchContext["tdcc"];
  tradeRisks: ResearchContext["tradeRisks"];
  strategies: ResearchContext["strategies"];
  dataQuality: AIResearchDataQuality;
  sources: ResearchSource[];
  evidence: ResearchEvidence[];
  contextFingerprint: string;
}

export interface InformationRichnessResult {
  grade: InformationRichnessGrade;
  availableDomains: string[];
  unavailableDomains: string[];
  reasons: string[];
}

export type ResearchFindingKind = "company_fact" | "market_snapshot" | "financial_metric"
  | "institutional_flow" | "tdcc_concentration" | "trade_risk" | "strategy_result"
  | "evidence_comparison" | "limitation";
export type ResearchFindingStance = "positive" | "neutral" | "negative" | "insufficient";
export type EvidenceFragmentRole = "subject" | "value" | "current" | "previous" | "date" | "risk"
  | "current_date" | "previous_date";
export type EvidenceFragmentFormat = "value" | "value_with_unit" | "date" | "label";
export type ResearchLimitationReasonCode = "missing_dataset" | "stale_dataset"
  | "unavailable_source" | "insufficient_coverage";

export interface EvidenceFragment {
  evidenceId: string;
  role: EvidenceFragmentRole;
  format: EvidenceFragmentFormat;
}

export interface StructuredResearchLimitation {
  datasetId: string;
  reasonCode: ResearchLimitationReasonCode;
  sourceId: string | null;
  asOf: string | null;
}

export interface StructuredResearchFinding {
  id: string;
  kind: ResearchFindingKind;
  stance: ResearchFindingStance;
  strategyId?: StrategyId;
  fragments: EvidenceFragment[];
  limitation?: StructuredResearchLimitation;
}

export interface RenderedResearchClaim {
  id: string;
  kind: ResearchFindingKind;
  stance: ResearchFindingStance;
  text: string;
  evidenceIds: string[];
  limitations: string[];
  estimated: boolean;
}

export interface StructuredResearchConclusion {
  verdict: "positive" | "neutral" | "negative" | "insufficient-data";
  supportingFindingIds: string[];
  opposingFindingIds: string[];
  limitationFindingIds: string[];
  aiConfidence: number | null;
  investmentCertainty: number | null;
}

export type InvestmentVerdict = "BUY" | "HOLD" | "SELL" | "INSUFFICIENT_DATA";
export type InvestmentRecommendationLabel = "買進" | "持有" | "賣出" | "資料不足";
export type ValuationMethod = "PE" | "PB";
export type InvestmentHorizonMonths = 3 | 6 | 12;

export interface InvestmentRecommendationCandidate {
  verdict: InvestmentVerdict;
  horizonMonths: InvestmentHorizonMonths;
  confidence: number;
  supportingFindingIds: string[];
  opposingFindingIds: string[];
  riskFindingIds: string[];
}

export interface ValuationCandidate {
  method: ValuationMethod;
  horizonMonths: InvestmentHorizonMonths;
  currentPriceEvidenceId: string;
  metricEvidenceId: string;
  scenarios: {
    conservative: { multiple: number };
    base: { multiple: number };
    optimistic: { multiple: number };
  };
}

export interface ServerInvestmentRecommendation extends InvestmentRecommendationCandidate {
  label: InvestmentRecommendationLabel;
}

export interface ServerCalculatedValuationScenario {
  name: "conservative" | "base" | "optimistic";
  multiple: number;
  targetPrice: number;
  expectedReturnRatio: number;
  expectedReturnPercent: number;
}

export interface ServerCalculatedValuation {
  method: ValuationMethod;
  asOf: string;
  currentPrice: number;
  metric: { name: "EPS" | "BVPS"; value: number; period: string; sourceId: string; estimated: boolean };
  scenarios: ServerCalculatedValuationScenario[];
}

export interface PublishedResearchRecommendation extends ServerInvestmentRecommendation {
  confidenceGrounding: "model-estimate-unverified";
}

export interface PublishedResearchValuation extends ServerCalculatedValuation {
  assumptionGrounding: "model-selected-bounded-assumptions";
}

export interface PublishedResearchReport {
  status: "formally-published";
  generatedAt: string;
  semanticGrounding: "server-grounded";
  claims: RenderedResearchClaim[];
  conclusion: string;
  conclusionFindingIds: {
    supporting: string[];
    opposing: string[];
    limitations: string[];
  };
  recommendation: PublishedResearchRecommendation;
  valuation: PublishedResearchValuation;
  grounding: {
    facts: "server-grounded";
    calculations: "server-calculated";
    valuationMultiples: "model-selected-bounded-assumptions";
    recommendationConfidence: "model-estimate-unverified";
  };
}

export interface InvestmentConclusionEvaluation {
  recommendation: ServerInvestmentRecommendation | null;
  valuation: ServerCalculatedValuation | null;
  errors: string[];
}

export interface AIResearchReportCandidate {
  schemaVersion: 1;
  stockId: string;
  asOf: string | null;
  contextFingerprint: string;
  dataQuality: AIResearchDataQuality;
  findings: StructuredResearchFinding[];
  conclusion: StructuredResearchConclusion;
  citations: string[];
  recommendation?: InvestmentRecommendationCandidate;
  valuation?: ValuationCandidate | null;
}

export interface AIResearchFindingCatalogEntry {
  id: string;
  kind: ResearchFindingKind;
  stance: ResearchFindingStance;
  evidenceIds: string[];
}

export type AIResearchModelEvidence = Readonly<AIResearchPacket> & {
  readonly findingCatalog: readonly AIResearchFindingCatalogEntry[];
};

export interface ResearchAuditDraft {
  status: "mechanical-preview-only";
  claims: RenderedResearchClaim[];
  conclusion: string;
}

export interface AuditResult {
  mechanicalPassed: boolean;
  publicationReady: boolean;
  semanticGrounding: "unverified" | "server-grounded";
  citationCoverage: number;
  invalidCitationIds: string[];
  unsupportedFindingIds: string[];
  prohibitedClaims: string[];
  errors: string[];
  warnings: string[];
  draft: ResearchAuditDraft | null;
  publishedReport: PublishedResearchReport | null;
  recommendation?: ServerInvestmentRecommendation | null;
  valuation?: ServerCalculatedValuation | null;
}

export interface AIResearchModelRequest {
  schemaVersion: 1;
  candidateContractVersion: "ai-research-selection.v2";
  systemInstructions: string;
  transportIsolation: "provider_transport_isolation_unverified";
  untrustedEvidence: AIResearchModelEvidence;
}

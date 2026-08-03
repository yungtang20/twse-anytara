import type { AIResearchReportSuccessResponse } from "../../shared/aiResearchReport";
import type { AIResearchRunResult } from "./aiResearchOrchestrator";

type SuccessfulRun = Extract<AIResearchRunResult, { success: true }>;

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

export function presentAIResearchReport(result: SuccessfulRun): AIResearchReportSuccessResponse {
  const formal = result.publicationReady && result.semanticGrounding === "server-grounded"
    && result.publishedReport?.semanticGrounding === "server-grounded"
    && result.publishedReport.status === "formally-published" && result.draft === null;
  const preview = !result.publicationReady && result.semanticGrounding === "unverified"
    && result.publishedReport === null;
  if (!formal && !preview) throw new Error("publication_contract_invariant");
  const claims = result.publishedReport?.claims ?? result.draft?.claims ?? [];
  const quality = result.reportContext.dataQuality;
  const limitations = unique([
    ...claims.filter((claim) => claim.kind === "limitation").map((claim) => claim.text),
    ...quality.missingDatasets.map((dataset) => `缺少資料：${dataset}`),
    ...quality.staleDatasets.map((dataset) => `資料可能過期：${dataset}`),
  ]);
  const common = {
    success: true as const,
    auditSummary: {
      mechanicalPassed: result.audit.mechanicalPassed,
      citationCoverage: result.audit.citationCoverage,
      warnings: [...result.audit.warnings],
      dataQuality: structuredClone(quality),
      strategies: structuredClone(result.reportContext.strategies),
      limitations,
      citations: claims.map((claim) => ({ findingId: claim.id, evidenceIds: [...claim.evidenceIds] })),
      sources: structuredClone(result.reportContext.sources),
    },
    providerMetadata: result.providerMetadata.map((item) => ({
      provider: item.provider, model: item.model, durationMs: item.durationMs, usage: { ...item.usage },
    })),
  };
  if (formal && result.publishedReport) return { ...common, publicationReady: true,
    semanticGrounding: "server-grounded", publishedReport: structuredClone(result.publishedReport),
    draft: null, recommendation: null, valuation: null };
  return { ...common, publicationReady: false, semanticGrounding: "unverified", publishedReport: null,
    draft: result.draft ? structuredClone(result.draft) : null,
    recommendation: result.audit.recommendation ? structuredClone(result.audit.recommendation) : null,
    valuation: result.audit.valuation ? structuredClone(result.audit.valuation) : null };
}

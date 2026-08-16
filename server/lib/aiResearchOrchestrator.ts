import type { ResearchContext } from "../../shared/researchContext";
import type { AuditResult, PublishedResearchReport, ResearchAuditDraft } from "../../shared/aiResearch";
import type { AIResearchReportContext } from "../../shared/aiResearchReport";
import type { ResolvedAIProviderConnection } from "../../shared/aiProvider";
import { buildAIResearchModelRequest } from "./aiResearchModelRequest";
import { buildResearchPacket } from "./aiResearchPacket";
import { evaluateInformationRichness } from "./aiResearchRichness";
import type {
  AIResearchAuditDiagnostics, AIResearchModelRunnerContract,
} from "./aiResearchModelRunner";
import type {
  AIResearchProviderMetadata,
} from "./aiResearchModelGateway";

interface ResearchContextSource {
  aggregate(stockId: string): Promise<ResearchContext>;
}

export type AIResearchRunResult = {
  success: true;
  publicationReady: boolean;
  semanticGrounding: "unverified" | "server-grounded";
  publishedReport: PublishedResearchReport | null;
  draft: ResearchAuditDraft | null;
  audit: AuditResult;
  providerMetadata: AIResearchProviderMetadata[];
  reportContext: AIResearchReportContext;
} | {
  success: false;
  error: "ai_research_stock_not_eligible" | "ai_research_context_unavailable"
    | "ai_research_insufficient_data" | "ai_research_provider_unavailable"
    | "ai_research_provider_timeout" | "ai_research_provider_response_invalid"
    | "ai_research_provider_rate_limited" | "ai_research_provider_rejected"
    | "ai_research_provider_server_error"
    | "ai_research_model_output_invalid"
    | "ai_research_aborted" | "ai_research_contract_error";
  publicationReady: false;
  publishedReport: null;
  auditDiagnostics?: AIResearchAuditDiagnostics;
  providerMetadata?: AIResearchProviderMetadata[];
};

type AIResearchFailureError = Extract<AIResearchRunResult, { success: false }>["error"];

const unavailable = (error: Extract<AIResearchRunResult, { success: false }>["error"],
  auditDiagnostics?: AIResearchAuditDiagnostics,
  providerMetadata?: AIResearchProviderMetadata[]): AIResearchRunResult => ({
  success: false, error, publicationReady: false, publishedReport: null,
  ...(auditDiagnostics ? { auditDiagnostics } : {}),
  ...(providerMetadata ? { providerMetadata } : {}),
});

function mapContextError(error: unknown): AIResearchFailureError {
  const message = error instanceof Error ? error.message : null;
  if (message === "stock_not_eligible_for_research") return "ai_research_stock_not_eligible";
  if (message === "research_context_unavailable") return "ai_research_context_unavailable";
  return "ai_research_contract_error";
}

function buildReportContext(
  packet: ReturnType<typeof buildResearchPacket>,
  audit: AuditResult,
): AIResearchReportContext {
  const claims = audit.publishedReport?.claims ?? audit.draft?.claims ?? [];
  const citedEvidence = new Set(claims.flatMap((claim) => claim.evidenceIds));
  const citedSources = new Set(packet.evidence
    .filter((item) => citedEvidence.has(item.id)).map((item) => item.sourceId));
  const strategies = Object.fromEntries(Object.entries(packet.strategies).map(([id, result]) => [id, {
    status: result.status, date: result.date, signal: result.signal,
  }])) as AIResearchReportContext["strategies"];
  const sources = packet.sources.filter((source) => citedSources.has(source.id)).map((source) => ({
    id: source.id, dataset: source.dataset, provider: source.provider,
    asOf: source.asOf, estimated: source.estimated,
  }));
  return { dataQuality: structuredClone(packet.dataQuality), strategies, sources };
}

export class AIResearchOrchestrator {
  constructor(
    private readonly contexts: ResearchContextSource,
    private readonly runner: AIResearchModelRunnerContract,
  ) {}

  async research(stockId: string, options: {
    signal?: AbortSignal;
    connection?: ResolvedAIProviderConnection;
  } = {}): Promise<AIResearchRunResult> {
    if (options.signal?.aborted) return unavailable("ai_research_aborted");
    let context: ResearchContext;
    try { context = await this.contexts.aggregate(stockId); }
    catch (error) { return unavailable(mapContextError(error)); }
    try {
      const packet = buildResearchPacket(context);
      if (evaluateInformationRichness(packet).grade === "C") {
        return unavailable("ai_research_insufficient_data");
      }
      const request = buildAIResearchModelRequest(packet);
      const result = await this.runner.generateAudited(request, packet, options);
      if (!result.success || !result.audit) {
        return unavailable(result.error ?? "ai_research_provider_unavailable",
          result.auditDiagnostics, result.providerMetadata);
      }
      return { success: true, publicationReady: result.audit.publicationReady,
        semanticGrounding: result.audit.semanticGrounding,
        publishedReport: result.audit.publishedReport, draft: result.audit.draft, audit: result.audit,
        providerMetadata: result.providerMetadata,
        reportContext: buildReportContext(packet, result.audit) };
    } catch { return unavailable("ai_research_contract_error"); }
  }
}

import type { AIResearchModelRequest, AIResearchPacket, AuditResult } from "../../shared/aiResearch";
import {
  AIResearchModelGatewayError,
  sanitizeAIResearchProviderMetadata,
  type AIResearchModelGateway,
  type AIResearchProviderMetadata,
} from "./aiResearchModelGateway";
import { RouterAIResearchModelGateway } from "./aiResearchRouterAdapter";
import { gateResearchPublication } from "./aiResearchPublicationGate";
import { buildAIResearchCorrectionRequest } from "./aiResearchModelRequest";
import { AIResearchSelectionContractError, hydrateAIResearchSelection } from "./aiResearchSelectionContract";

export interface AIResearchModelRunnerResult {
  success: boolean;
  error?: "ai_research_provider_unavailable" | "ai_research_model_output_invalid"
    | "ai_research_provider_timeout" | "ai_research_provider_response_invalid"
    | "ai_research_provider_rate_limited" | "ai_research_provider_rejected"
    | "ai_research_provider_server_error"
    | "ai_research_aborted" | "ai_research_contract_error";
  publicationReady: boolean;
  semanticGrounding?: "unverified" | "server-grounded";
  publishedReport: AuditResult["publishedReport"];
  audit?: AuditResult;
  providerMetadata: AIResearchProviderMetadata[];
  auditDiagnostics?: AIResearchAuditDiagnostics;
}

export interface AIResearchAuditDiagnostics {
  reasonCodes: string[];
  invalidCitationCount: number;
  unsupportedFindingCount: number;
  prohibitedClaimCount: number;
}

export interface AIResearchModelRunnerContract {
  generateAudited(
    request: AIResearchModelRequest,
    packet: AIResearchPacket,
    options?: { signal?: AbortSignal },
  ): Promise<AIResearchModelRunnerResult>;
}

function diagnostics(audit: AuditResult): AIResearchAuditDiagnostics {
  const reasonCodes = audit.errors.map((error) => error.match(/^[a-z][a-z0-9_]*/)?.[0] ?? "unknown_audit_error");
  if (audit.invalidCitationIds.length > 0) reasonCodes.push("invalid_citation");
  if (audit.unsupportedFindingIds.length > 0) reasonCodes.push("unsupported_finding");
  if (audit.prohibitedClaims.length > 0) reasonCodes.push("prohibited_claim");
  return { reasonCodes: [...new Set(reasonCodes)].sort(),
    invalidCitationCount: audit.invalidCitationIds.length,
    unsupportedFindingCount: audit.unsupportedFindingIds.length,
    prohibitedClaimCount: audit.prohibitedClaims.length };
}

function failure(error: AIResearchModelRunnerResult["error"], providerMetadata: AIResearchProviderMetadata[] = [],
  auditDiagnostics?: AIResearchAuditDiagnostics): AIResearchModelRunnerResult {
  return { success: false, error, publicationReady: false, publishedReport: null,
    providerMetadata, ...(auditDiagnostics ? { auditDiagnostics } : {}) };
}

function gatewayFailure(error: AIResearchModelGatewayError): AIResearchModelRunnerResult["error"] {
  if (error.code === "aborted") return "ai_research_aborted";
  if (error.code === "local_contract") return "ai_research_contract_error";
  if (error.code === "timeout") return "ai_research_provider_timeout";
  if (error.code === "invalid_json" || error.code === "empty_response") return "ai_research_provider_response_invalid";
  if (error.code === "rate_limited") return "ai_research_provider_rate_limited";
  if (error.code === "provider_rejected") return "ai_research_provider_rejected";
  if (error.code === "server_error") return "ai_research_provider_server_error";
  return "ai_research_provider_unavailable";
}

export class AIResearchModelRunner implements AIResearchModelRunnerContract {
  constructor(
    private readonly gateway: AIResearchModelGateway,
    private readonly auditor: (candidate: unknown, packet: AIResearchPacket) => AuditResult,
  ) {}

  async generateAudited(request: AIResearchModelRequest, packet: AIResearchPacket,
    options: { signal?: AbortSignal } = {}): Promise<AIResearchModelRunnerResult> {
    if (options.signal?.aborted) return failure("ai_research_aborted");
    const providerMetadata: AIResearchProviderMetadata[] = [];
    let nextRequest = request;
    let lastDiagnostics: AIResearchAuditDiagnostics | undefined;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const generated = await this.gateway.generateCandidate(nextRequest, { signal: options.signal });
        providerMetadata.push(sanitizeAIResearchProviderMetadata(generated));
        if (options.signal?.aborted) return failure("ai_research_aborted", providerMetadata);
        const audit = this.auditor(generated.candidate, packet);
        if (audit.mechanicalPassed) return { success: true, publicationReady: audit.publicationReady,
          semanticGrounding: audit.semanticGrounding, publishedReport: audit.publishedReport,
          audit, providerMetadata };
        lastDiagnostics = diagnostics(audit);
      } catch (error) {
        if (error instanceof AIResearchSelectionContractError) lastDiagnostics = {
          reasonCodes: [error.message.match(/^[a-z][a-z0-9_]*/)?.[0] ?? "selection_contract_invalid"],
          invalidCitationCount: 0, unsupportedFindingCount: 0, prohibitedClaimCount: 0 };
        else if (error instanceof AIResearchModelGatewayError) {
          return failure(gatewayFailure(error), providerMetadata);
        } else return failure("ai_research_contract_error", providerMetadata);
      }
      if (attempt === 0 && lastDiagnostics) {
        nextRequest = buildAIResearchCorrectionRequest(request, lastDiagnostics.reasonCodes);
      }
    }
    return failure("ai_research_model_output_invalid", providerMetadata, lastDiagnostics);
  }
}

export function createAIResearchRouterModelRunner(clock: () => Date = () => new Date()): AIResearchModelRunner {
  return new AIResearchModelRunner(new RouterAIResearchModelGateway(), (candidate, packet) =>
    gateResearchPublication(hydrateAIResearchSelection(candidate, packet), packet, { clock }));
}

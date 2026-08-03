import type { AIResearchModelRequest } from "../../shared/aiResearch";

export type AIResearchProvider = "router" | "fake";
export type AIResearchModelGatewayErrorCode = "not_configured" | "timeout" | "network"
  | "rate_limited" | "server_error" | "empty_response" | "invalid_json"
  | "aborted" | "local_contract" | "provider_rejected";

export interface AIResearchProviderUsage {
  inputTokens: number | null;
  outputTokens: number | null;
}

export interface AIResearchModelGatewayResult {
  candidate: unknown;
  provider: AIResearchProvider;
  model: string;
  durationMs: number | null;
  usage: AIResearchProviderUsage;
}

export interface AIResearchProviderMetadata {
  provider: AIResearchProvider;
  model: string;
  durationMs: number | null;
  usage: AIResearchProviderUsage;
}

function safeTokenCount(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function sanitizeAIResearchProviderUsage(inputTokens: unknown, outputTokens: unknown): AIResearchProviderUsage {
  return { inputTokens: safeTokenCount(inputTokens), outputTokens: safeTokenCount(outputTokens) };
}

export function sanitizeAIResearchDurationMs(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  return Object.is(value, -0) ? 0 : value;
}

export function sanitizeAIResearchProviderMetadata(
  result: Pick<AIResearchModelGatewayResult, "provider" | "model" | "durationMs" | "usage">,
): AIResearchProviderMetadata {
  return { provider: result.provider, model: result.model,
    durationMs: sanitizeAIResearchDurationMs(result.durationMs),
    usage: sanitizeAIResearchProviderUsage(result.usage?.inputTokens, result.usage?.outputTokens) };
}

export interface AIResearchModelGateway {
  generateCandidate(
    request: AIResearchModelRequest,
    options: { signal?: AbortSignal },
  ): Promise<AIResearchModelGatewayResult>;
}

export class AIResearchModelGatewayError extends Error {
  constructor(readonly code: AIResearchModelGatewayErrorCode) {
    super(`ai_research_gateway_${code}`);
    this.name = "AIResearchModelGatewayError";
  }
}

type ScriptedResult = AIResearchModelGatewayResult | Error;

export class InMemoryAIResearchModelGateway implements AIResearchModelGateway {
  readonly calls: AIResearchModelRequest[] = [];

  constructor(private readonly scriptedResults: ScriptedResult[]) {}

  async generateCandidate(
    request: AIResearchModelRequest,
    options: { signal?: AbortSignal },
  ): Promise<AIResearchModelGatewayResult> {
    if (options.signal?.aborted) throw new AIResearchModelGatewayError("aborted");
    this.calls.push(request);
    const result = this.scriptedResults.shift();
    if (!result) throw new AIResearchModelGatewayError("local_contract");
    if (result instanceof Error) throw result;
    const cloned = structuredClone(result);
    if (options.signal?.aborted) throw new AIResearchModelGatewayError("aborted");
    return cloned;
  }
}

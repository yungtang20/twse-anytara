import OpenAI from "openai";
import type { AIResearchModelRequest } from "../../shared/aiResearch";
import { validateEnvValue } from "./security";
import {
  AIResearchModelGatewayError,
  sanitizeAIResearchDurationMs,
  sanitizeAIResearchProviderUsage,
  type AIResearchModelGateway,
  type AIResearchModelGatewayResult,
} from "./aiResearchModelGateway";

export const AI_RESEARCH_ROUTER_BASE_URL = "https://api.hcnsec.cn/v1";
export const AI_RESEARCH_ROUTER_MODEL = "glm-5.2";
const AI_RESEARCH_MAX_TOKENS = 16384;

type Env = Record<string, string | undefined>;
interface CompletionResponse {
  choices?: Array<{ message?: { content?: unknown } }>;
  usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
}
interface RouterClient {
  chat: { completions: { create(
    parameters: Record<string, unknown>,
    options: { signal: AbortSignal },
  ): Promise<CompletionResponse> } };
}
interface RouterClientOptions { apiKey: string; baseURL: string; maxRetries: 0 }
interface RouterAdapterOptions {
  env?: Env;
  clientFactory?: (options: RouterClientOptions) => RouterClient;
  nowMs?: () => number;
  timeoutMs?: number;
}

function throwIfCallerAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new AIResearchModelGatewayError("aborted");
}

function parseCandidate(value: unknown): unknown {
  if (typeof value !== "string" || value.trim() === "") throw new AIResearchModelGatewayError("empty_response");
  try { return JSON.parse(value) as unknown; }
  catch { throw new AIResearchModelGatewayError("invalid_json"); }
}

function classify(error: unknown, callerAborted: boolean, timedOut: boolean): AIResearchModelGatewayError {
  if (callerAborted) return new AIResearchModelGatewayError("aborted");
  if (timedOut) return new AIResearchModelGatewayError("timeout");
  const status = typeof error === "object" && error !== null && "status" in error
    ? Number((error as { status: unknown }).status) : null;
  if (status === 429) return new AIResearchModelGatewayError("rate_limited");
  if (status !== null && status >= 500) return new AIResearchModelGatewayError("server_error");
  if (status !== null && status >= 400) return new AIResearchModelGatewayError("provider_rejected");
  return new AIResearchModelGatewayError("network");
}

export class RouterAIResearchModelGateway implements AIResearchModelGateway {
  private readonly env: Env;
  private readonly clientFactory: (options: RouterClientOptions) => RouterClient;
  private readonly nowMs: () => number;
  private readonly timeoutMs: number;

  constructor(options: RouterAdapterOptions = {}) {
    this.env = options.env ?? process.env;
    this.clientFactory = options.clientFactory ?? ((clientOptions) =>
      new OpenAI(clientOptions) as unknown as RouterClient);
    this.nowMs = options.nowMs ?? (() => performance.now());
    this.timeoutMs = options.timeoutMs ?? 300_000;
  }

  async generateCandidate(
    request: AIResearchModelRequest,
    options: { signal?: AbortSignal },
  ): Promise<AIResearchModelGatewayResult> {
    throwIfCallerAborted(options.signal);
    const keyValue = this.env.AI_RESEARCH_API_KEY;
    if (!keyValue) throw new AIResearchModelGatewayError("not_configured");
    const apiKey = validateEnvValue("AI_RESEARCH_API_KEY", keyValue);
    const client = this.clientFactory({ apiKey, baseURL: AI_RESEARCH_ROUTER_BASE_URL, maxRetries: 0 });
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    const started = this.nowMs();
    let response: CompletionResponse;
    try {
      response = await client.chat.completions.create({
        model: AI_RESEARCH_ROUTER_MODEL,
        messages: [
          { role: "system", content: request.systemInstructions },
          { role: "user", content: JSON.stringify({
            candidateContractVersion: request.candidateContractVersion,
            untrustedEvidence: request.untrustedEvidence,
          }) },
        ],
        max_tokens: AI_RESEARCH_MAX_TOKENS,
        stream: false,
        response_format: { type: "json_object" },
      }, { signal });
    } catch (error) {
      throw classify(error, Boolean(options.signal?.aborted), timeout.aborted);
    }
    throwIfCallerAborted(options.signal);
    const candidate = parseCandidate(response.choices?.[0]?.message?.content);
    throwIfCallerAborted(options.signal);
    return { candidate, provider: "router", model: AI_RESEARCH_ROUTER_MODEL,
      durationMs: sanitizeAIResearchDurationMs(this.nowMs() - started),
      usage: sanitizeAIResearchProviderUsage(response.usage?.prompt_tokens, response.usage?.completion_tokens) };
  }
}

import type { AIResearchModelRequest } from "../../shared/aiResearch";
import type { ResolvedAIProviderConnection } from "../../shared/aiProvider";
import {
  AIResearchModelGatewayError,
  sanitizeAIResearchDurationMs,
  sanitizeAIResearchProviderUsage,
  type AIResearchModelGateway,
  type AIResearchModelGatewayErrorCode,
  type AIResearchModelGatewayResult,
} from "./aiResearchModelGateway";
import {
  OpenAICompatibleTransportError,
  postChatCompletion,
} from "./openAICompatibleTransport";

interface CompletionResponse {
  choices?: Array<{ finish_reason?: unknown; message?: { content?: unknown } }>;
  usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
  model?: unknown;
}

interface RouterAdapterOptions {
  postCompletion?: typeof postChatCompletion;
  nowMs?: () => number;
}

function parseCandidate(value: unknown): unknown {
  if (typeof value !== "string" || value.trim() === "") {
    throw new AIResearchModelGatewayError("empty_response");
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new AIResearchModelGatewayError("invalid_json");
  }
}

function provider(connection: ResolvedAIProviderConnection): "hcnsec" | "custom" {
  try {
    return new URL(connection.baseUrl).hostname.toLowerCase() === "api.hcnsec.cn"
      ? "hcnsec" : "custom";
  } catch {
    return "custom";
  }
}

function safeModel(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() && value.length <= 128 && !/[\r\n\0]/.test(value)
    ? value.trim() : fallback;
}

function transportCode(error: OpenAICompatibleTransportError): AIResearchModelGatewayErrorCode {
  if (error.code === "provider_aborted") return "aborted";
  if (error.code === "provider_timeout") return "timeout";
  if (error.code === "provider_rate_limited") return "rate_limited";
  if (error.code === "provider_server_error") return "server_error";
  if (error.code === "provider_rejected" || error.code === "provider_redirect_forbidden") {
    return "provider_rejected";
  }
  if (error.code === "provider_invalid_json" || error.code === "provider_response_too_large") {
    return "invalid_json";
  }
  return "network";
}

export class RouterAIResearchModelGateway implements AIResearchModelGateway {
  private readonly postCompletion: typeof postChatCompletion;
  private readonly nowMs: () => number;

  constructor(options: RouterAdapterOptions = {}) {
    this.postCompletion = options.postCompletion ?? postChatCompletion;
    this.nowMs = options.nowMs ?? (() => performance.now());
  }

  async generateCandidate(
    request: AIResearchModelRequest,
    options: { signal?: AbortSignal; connection?: ResolvedAIProviderConnection },
  ): Promise<AIResearchModelGatewayResult> {
    if (options.signal?.aborted) throw new AIResearchModelGatewayError("aborted");
    const connection = options.connection;
    if (!connection) throw new AIResearchModelGatewayError("local_contract");
    const started = this.nowMs();
    let response: CompletionResponse;
    try {
      response = await this.postCompletion(connection, {
        model: connection.model,
        messages: [
          { role: "system", content: request.systemInstructions },
          { role: "user", content: JSON.stringify({
            candidateContractVersion: request.candidateContractVersion,
            untrustedEvidence: request.untrustedEvidence,
          }) },
        ],
        max_tokens: connection.maxOutputTokens,
        stream: false,
        response_format: { type: "json_object" },
      }, { signal: options.signal }) as CompletionResponse;
    } catch (error) {
      if (error instanceof OpenAICompatibleTransportError) {
        throw new AIResearchModelGatewayError(transportCode(error));
      }
      throw new AIResearchModelGatewayError("network");
    }
    if (options.signal?.aborted) throw new AIResearchModelGatewayError("aborted");
    const choice = response.choices?.[0];
    if (choice?.finish_reason === "length") throw new AIResearchModelGatewayError("truncated");
    const candidate = parseCandidate(choice?.message?.content);
    return {
      candidate,
      provider: provider(connection),
      model: safeModel(response.model, connection.model),
      durationMs: sanitizeAIResearchDurationMs(this.nowMs() - started),
      usage: sanitizeAIResearchProviderUsage(
        response.usage?.prompt_tokens,
        response.usage?.completion_tokens,
      ),
    };
  }
}

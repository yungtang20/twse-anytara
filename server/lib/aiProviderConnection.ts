import type { AIProviderOverride, ResolvedAIProviderConnection } from "../../shared/aiProvider";

const DEFAULT_HCNSEC_BASE_URL = "https://api.hcnsec.cn/v1";
const DEFAULT_HCNSEC_MODEL = "auto";
const DEFAULT_MAX_OUTPUT_TOKENS = 65_536;
const MIN_MAX_OUTPUT_TOKENS = 16_384;

type ProviderConnectionErrorCode = "provider_input_invalid" | "custom_key_required"
  | "hcnsec_privacy_ack_required" | "default_key_not_configured"
  | "max_output_tokens_invalid";

type Env = Record<string, string | undefined>;

export class AIProviderConnectionError extends Error {
  constructor(readonly code: ProviderConnectionErrorCode) {
    super(code);
    this.name = "AIProviderConnectionError";
  }
}

function optionalField(value: unknown, maxLength: number): string {
  if (value === undefined) return "";
  if (typeof value !== "string") throw new AIProviderConnectionError("provider_input_invalid");
  const trimmed = value.trim();
  if (trimmed.length > maxLength || /[\r\n\0]/.test(trimmed)) {
    throw new AIProviderConnectionError("provider_input_invalid");
  }
  return trimmed;
}

function maxOutputTokens(env: Env): number {
  const raw = env.HCNSEC_MAX_OUTPUT_TOKENS?.trim();
  if (!raw) return DEFAULT_MAX_OUTPUT_TOKENS;
  if (!/^\d+$/.test(raw)) throw new AIProviderConnectionError("max_output_tokens_invalid");
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < MIN_MAX_OUTPUT_TOKENS
    || value > DEFAULT_MAX_OUTPUT_TOKENS) {
    throw new AIProviderConnectionError("max_output_tokens_invalid");
  }
  return value;
}

function isHcnsec(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).hostname.toLowerCase() === "api.hcnsec.cn";
  } catch {
    return false;
  }
}

export function resolveAIProviderConnection(
  input: AIProviderOverride | undefined,
  env: Env = process.env,
): ResolvedAIProviderConnection {
  if (input !== undefined && (typeof input !== "object" || input === null || Array.isArray(input))) {
    throw new AIProviderConnectionError("provider_input_invalid");
  }
  if (input?.privacyAccepted !== undefined && typeof input.privacyAccepted !== "boolean") {
    throw new AIProviderConnectionError("provider_input_invalid");
  }
  const suppliedBaseUrl = optionalField(input?.baseUrl, 2048);
  const suppliedApiKey = optionalField(input?.apiKey, 4096);
  const suppliedModel = optionalField(input?.model, 128);
  const configuredBaseUrl = optionalField(env.HCNSEC_BASE_URL, 2048) || DEFAULT_HCNSEC_BASE_URL;
  const configuredModel = optionalField(env.HCNSEC_MODEL, 128) || DEFAULT_HCNSEC_MODEL;

  if (suppliedBaseUrl && !suppliedApiKey) {
    throw new AIProviderConnectionError("custom_key_required");
  }
  const source = suppliedApiKey ? "visitor" : "default";
  const apiKey = suppliedApiKey || optionalField(env.HCNSEC_API_KEY, 4096);
  if (!apiKey) throw new AIProviderConnectionError("default_key_not_configured");
  const baseUrl = suppliedBaseUrl || configuredBaseUrl;
  const privacyAccepted = input?.privacyAccepted === true;
  if (isHcnsec(baseUrl) && !privacyAccepted) {
    throw new AIProviderConnectionError("hcnsec_privacy_ack_required");
  }
  return {
    source,
    apiKey,
    baseUrl,
    model: suppliedModel || configuredModel,
    maxOutputTokens: maxOutputTokens(env),
    privacyAccepted,
  };
}

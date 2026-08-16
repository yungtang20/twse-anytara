import type { AIProviderOverride } from "../../shared/aiProvider";

export const AI_PROVIDER_STORAGE_KEY = "trinity.aiProviderOverride";
export const HCNSEC_PRIVACY_STORAGE_KEY = "trinity.hcnsecPrivacyAccepted";

export type AIProviderSessionOverride = Pick<AIProviderOverride, "baseUrl" | "apiKey" | "model">;

function session(): Storage | null {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}

function cleanField(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error("invalid_ai_provider_settings");
  const trimmed = value.trim();
  return trimmed || undefined;
}

export function loadAIProviderOverride(): AIProviderSessionOverride {
  const storage = session();
  const raw = storage?.getItem(AI_PROVIDER_STORAGE_KEY);
  if (!raw) return {};
  try {
    const value = JSON.parse(raw) as unknown;
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error("invalid_ai_provider_settings");
    }
    const record = value as Record<string, unknown>;
    const baseUrl = cleanField(record.baseUrl);
    const apiKey = cleanField(record.apiKey);
    const model = cleanField(record.model);
    return { ...(baseUrl ? { baseUrl } : {}), ...(apiKey ? { apiKey } : {}),
      ...(model ? { model } : {}) };
  } catch {
    storage?.removeItem(AI_PROVIDER_STORAGE_KEY);
    return {};
  }
}

export function saveAIProviderOverride(input: AIProviderSessionOverride): void {
  const storage = session();
  if (!storage) return;
  const baseUrl = cleanField(input.baseUrl);
  const apiKey = cleanField(input.apiKey);
  const model = cleanField(input.model);
  const value = { ...(baseUrl ? { baseUrl } : {}), ...(apiKey ? { apiKey } : {}),
    ...(model ? { model } : {}) };
  if (Object.keys(value).length === 0) storage.removeItem(AI_PROVIDER_STORAGE_KEY);
  else storage.setItem(AI_PROVIDER_STORAGE_KEY, JSON.stringify(value));
}

export function clearAIProviderOverride(): void {
  session()?.removeItem(AI_PROVIDER_STORAGE_KEY);
}

export function readHcnsecPrivacyAccepted(): boolean {
  return session()?.getItem(HCNSEC_PRIVACY_STORAGE_KEY) === "true";
}

export function setHcnsecPrivacyAccepted(accepted: boolean): void {
  const storage = session();
  if (!storage) return;
  if (accepted) storage.setItem(HCNSEC_PRIVACY_STORAGE_KEY, "true");
  else storage.removeItem(HCNSEC_PRIVACY_STORAGE_KEY);
}

export interface AIProviderOverride {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  privacyAccepted?: boolean;
}

export interface ResolvedAIProviderConnection {
  source: "default" | "visitor";
  apiKey: string;
  baseUrl: string;
  model: string;
  maxOutputTokens: number;
  privacyAccepted: boolean;
}

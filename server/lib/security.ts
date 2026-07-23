import type { Request } from "express";

const LONGCAT_ORIGIN = "https://api.longcat.chat";
const LONGCAT_PATHS = new Set(["", "/", "/openai", "/openai/v1", "/openai/v1/chat/completions"]);

export function normalizeLongcatBaseUrl(value?: string): string {
  const url = new URL((value || LONGCAT_ORIGIN).trim());
  const path = url.pathname.replace(/\/$/, "");
  if (
    url.origin !== LONGCAT_ORIGIN ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !LONGCAT_PATHS.has(path)
  ) {
    throw new Error("LongCat Base URL 必須使用 https://api.longcat.chat 官方端點");
  }
  return `${LONGCAT_ORIGIN}${path}`;
}

export function resolveLongcatCompletionsUrl(value?: string): string {
  const baseUrl = normalizeLongcatBaseUrl(value);
  if (baseUrl.endsWith("/chat/completions")) return baseUrl;
  if (baseUrl.endsWith("/openai")) return `${baseUrl}/v1/chat/completions`;
  if (baseUrl.endsWith("/openai/v1")) return `${baseUrl}/chat/completions`;
  return `${LONGCAT_ORIGIN}/openai/v1/chat/completions`;
}

export function isLoopbackAddress(address?: string): boolean {
  if (!address) return false;
  return address === "::1" || address === "127.0.0.1" || address.startsWith("::ffff:127.");
}

export function isLoopbackRequest(req: Request): boolean {
  return isLoopbackAddress(req.socket.remoteAddress);
}

export function validateEnvValue(name: string, value: unknown, maxLength = 4096): string {
  if (typeof value !== "string") throw new Error(`${name} 必須是字串`);
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLength || /[\r\n\0]/.test(trimmed)) {
    throw new Error(`${name} 格式無效`);
  }
  return trimmed;
}

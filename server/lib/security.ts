import type { Request } from "express";

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

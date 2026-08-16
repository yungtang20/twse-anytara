import type { Request } from "express";
import type { NextFunction, Response } from "express";
import { timingSafeEqual } from "node:crypto";

export const ADMIN_TOKEN_HEADER = "x-trinity-admin-token";

export interface AdminAuthorizationResult {
  allowed: boolean;
  status: 401 | 403 | 503;
  error: "admin_token_invalid" | "admin_token_not_configured" | "admin_loopback_required"
    | "admin_proxy_headers_forbidden" | "admin_origin_forbidden";
}

export function isLoopbackAddress(address?: string): boolean {
  if (!address) return false;
  return address === "::1" || address === "127.0.0.1" || address.startsWith("::ffff:127.");
}

export function isLoopbackRequest(req: Request): boolean {
  return isLoopbackAddress(req.socket.remoteAddress);
}

function header(req: Request, name: string): string {
  return req.get(name)?.trim() || "";
}

export function isLoopbackHost(host: string): boolean {
  if (!host) return false;
  try {
    const hostname = new URL(`http://${host}`).hostname.toLowerCase();
    return hostname === "localhost" || hostname === "[::1]" || hostname === "::1"
      || /^127(?:\.[0-9]{1,3}){3}$/.test(hostname);
  } catch {
    return false;
  }
}

function equalSecret(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual, "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

function failure(
  status: AdminAuthorizationResult["status"],
  error: AdminAuthorizationResult["error"],
): AdminAuthorizationResult {
  return { allowed: false, status, error };
}

/**
 * Authorize a local administrative request. Socket, Host/Origin and Fetch
 * Metadata checks close proxy, DNS-rebinding and browser-CSRF shortcuts; the
 * independent token is the application authentication factor.
 */
export function authorizeAdminRequest(
  req: Request,
  expectedToken = process.env.TRINITY_ADMIN_TOKEN?.trim() || "",
): AdminAuthorizationResult | { allowed: true } {
  if (!isLoopbackRequest(req) || !isLoopbackHost(header(req, "host"))) {
    return failure(403, "admin_loopback_required");
  }
  if (["forwarded", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto"]
    .some((name) => header(req, name))) {
    return failure(403, "admin_proxy_headers_forbidden");
  }
  const origin = header(req, "origin");
  if (origin) {
    try {
      if (!isLoopbackHost(new URL(origin).host)) return failure(403, "admin_origin_forbidden");
    } catch {
      return failure(403, "admin_origin_forbidden");
    }
  }
  const fetchSite = header(req, "sec-fetch-site").toLowerCase();
  if (fetchSite === "cross-site") return failure(403, "admin_origin_forbidden");
  if (!expectedToken) return failure(503, "admin_token_not_configured");
  if (!equalSecret(header(req, ADMIN_TOKEN_HEADER), expectedToken)) {
    return failure(401, "admin_token_invalid");
  }
  return { allowed: true };
}

export function isAuthorizedAdminRequest(req: Request): boolean {
  return authorizeAdminRequest(req).allowed;
}

export function requireAdminRequest(req: Request, res: Response, next: NextFunction) {
  const result = authorizeAdminRequest(req);
  if (!result.allowed) return res.status(result.status).json({ success: false, error: result.error });
  return next();
}

export function validateEnvValue(name: string, value: unknown, maxLength = 4096): string {
  if (typeof value !== "string") throw new Error(`${name} 必須是字串`);
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLength || /[\r\n\0]/.test(trimmed)) {
    throw new Error(`${name} 格式無效`);
  }
  return trimmed;
}

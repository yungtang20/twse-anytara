import assert from "node:assert/strict";
import test from "node:test";
import { authorizeAdminRequest } from "../server/lib/security.js";

function request(options: {
  address?: string;
  host?: string;
  origin?: string;
  token?: string;
  forwarded?: string;
  fetchSite?: string;
} = {}) {
  const headers: Record<string, string> = {
    host: options.host ?? "127.0.0.1:3000",
    origin: options.origin ?? "http://127.0.0.1:3000",
    "x-trinity-admin-token": options.token ?? "correct-token",
    "sec-fetch-site": options.fetchSite ?? "same-origin",
  };
  if (options.forwarded) headers.forwarded = options.forwarded;
  return {
    socket: { remoteAddress: options.address ?? "127.0.0.1" },
    get(name: string) { return headers[name.toLowerCase()]; },
  } as never;
}

test("admin authorization requires independent token and loopback request metadata", () => {
  assert.deepEqual(authorizeAdminRequest(request(), "correct-token"), { allowed: true });
  assert.deepEqual(authorizeAdminRequest(request({ token: "wrong" }), "correct-token"), {
    allowed: false, status: 401, error: "admin_token_invalid",
  });
  assert.deepEqual(authorizeAdminRequest(request(), ""), {
    allowed: false, status: 503, error: "admin_token_not_configured",
  });
  assert.deepEqual(authorizeAdminRequest(request({ address: "203.0.113.8" }), "correct-token"), {
    allowed: false, status: 403, error: "admin_loopback_required",
  });
});

test("admin authorization rejects proxy and cross-site shortcuts", () => {
  assert.deepEqual(authorizeAdminRequest(request({ forwarded: "for=203.0.113.8" }), "correct-token"), {
    allowed: false, status: 403, error: "admin_proxy_headers_forbidden",
  });
  assert.deepEqual(authorizeAdminRequest(request({ origin: "https://attacker.example" }), "correct-token"), {
    allowed: false, status: 403, error: "admin_origin_forbidden",
  });
  assert.deepEqual(authorizeAdminRequest(request({ fetchSite: "cross-site" }), "correct-token"), {
    allowed: false, status: 403, error: "admin_origin_forbidden",
  });
});

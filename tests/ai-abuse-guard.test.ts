import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  AIAbuseGuard,
  AIAbuseGuardError,
  createAIAbuseGuard,
} from "../server/lib/aiAbuseGuard";

function code(run: () => unknown): string | null {
  try {
    run();
    return null;
  } catch (error) {
    return error instanceof AIAbuseGuardError ? error.code : "unexpected_error";
  }
}

test("guard enforces a fixed per-client window and resets after expiry", () => {
  const guard = new AIAbuseGuard({ requestsPerWindow: 2, windowMs: 1_000,
    sharedDailyLimit: 100, maxConcurrency: 10 });
  guard.acquire({ clientId: "client-a", usesSharedProvider: false, nowMs: 0 })();
  guard.acquire({ clientId: "client-a", usesSharedProvider: false, nowMs: 100 })();
  assert.equal(code(() => guard.acquire({ clientId: "client-a",
    usesSharedProvider: false, nowMs: 999 })), "ai_rate_limited");
  guard.acquire({ clientId: "client-a", usesSharedProvider: false, nowMs: 1_000 })();
});

test("shared daily allowance excludes visitor credentials and rolls over by UTC day", () => {
  const guard = new AIAbuseGuard({ requestsPerWindow: 10, windowMs: 1_000,
    sharedDailyLimit: 2, maxConcurrency: 10 });
  guard.acquire({ clientId: "a", usesSharedProvider: true, nowMs: 0 })();
  guard.acquire({ clientId: "b", usesSharedProvider: true, nowMs: 0 })();
  guard.acquire({ clientId: "visitor", usesSharedProvider: false, nowMs: 0 })();
  assert.equal(code(() => guard.acquire({ clientId: "c", usesSharedProvider: true, nowMs: 0 })),
    "ai_shared_daily_limit");
  guard.acquire({ clientId: "c", usesSharedProvider: true, nowMs: 86_400_000 })();
});

test("global concurrency is released exactly once on every completion path", () => {
  const guard = new AIAbuseGuard({ requestsPerWindow: 10, windowMs: 1_000,
    sharedDailyLimit: 100, maxConcurrency: 1 });
  const release = guard.acquire({ clientId: "a", usesSharedProvider: false, nowMs: 0 });
  assert.equal(code(() => guard.acquire({ clientId: "b", usesSharedProvider: false, nowMs: 0 })),
    "ai_concurrency_limit");
  release();
  release();
  guard.acquire({ clientId: "b", usesSharedProvider: false, nowMs: 0 })();
});

test("environment configuration fails closed instead of disabling protection", () => {
  assert.throws(() => createAIAbuseGuard({ AI_RATE_LIMIT_REQUESTS: "0" }),
    (error: unknown) => error instanceof AIAbuseGuardError && error.code === "ai_guard_config_invalid");
  assert.throws(() => createAIAbuseGuard({ AI_MAX_CONCURRENCY: "not-a-number" }),
    (error: unknown) => error instanceof AIAbuseGuardError && error.code === "ai_guard_config_invalid");
  assert.doesNotThrow(() => createAIAbuseGuard({
    AI_RATE_LIMIT_REQUESTS: "10",
    AI_RATE_LIMIT_WINDOW_MS: "600000",
    AI_SHARED_DAILY_LIMIT: "100",
    AI_MAX_CONCURRENCY: "2",
  }));
});

test("client identity rejects blank control-character and oversized values", () => {
  const guard = new AIAbuseGuard({ requestsPerWindow: 10, windowMs: 1_000,
    sharedDailyLimit: 100, maxConcurrency: 2 });
  for (const clientId of ["", "client\nforged", "x".repeat(257)]) {
    assert.equal(code(() => guard.acquire({ clientId, usesSharedProvider: false, nowMs: 0 })),
      "ai_client_invalid");
  }
});

test("production server trusts exactly one Render proxy hop before mounting routes", () => {
  const source = readFileSync(new URL("../server.ts", import.meta.url), "utf8");
  const trust = source.indexOf('app.set("trust proxy", 1)');
  const routes = source.indexOf("app.use(apiRouter)");
  assert.ok(trust >= 0, "production proxy trust must be configured");
  assert.ok(trust < routes, "proxy trust must be configured before routes");
  assert.match(source, /if \(process\.env\.NODE_ENV === "production"\) \{\s*app\.set\("trust proxy", 1\);\s*\}/);
});

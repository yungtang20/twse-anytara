import assert from "node:assert/strict";
import test from "node:test";
import {
  AIResearchModelGatewayError,
  InMemoryAIResearchModelGateway,
  sanitizeAIResearchProviderMetadata,
} from "../server/lib/aiResearchModelGateway.js";
import type { AIResearchModelRequest } from "../shared/aiResearch.js";

const request: AIResearchModelRequest = {
  schemaVersion: 1, candidateContractVersion: "ai-research-selection.v2",
  systemInstructions: "trusted", transportIsolation: "provider_transport_isolation_unverified",
  untrustedEvidence: {} as never,
};

test("in-memory ModelGateway preserves the generic seam and honors pre-abort", async () => {
  const gateway = new InMemoryAIResearchModelGateway([{
    candidate: { ok: true }, provider: "fake", model: "deterministic",
    durationMs: 1, usage: { inputTokens: 1, outputTokens: 1 },
  }]);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(() => gateway.generateCandidate(request, { signal: controller.signal }),
    (error: unknown) => error instanceof AIResearchModelGatewayError && error.code === "aborted");
  assert.equal(gateway.calls.length, 0);
});

test("provider metadata sanitizer allowlists fields and rejects unsafe counters and durations", () => {
  const raw = {
    candidate: { raw: "secret-candidate" }, provider: "router", model: "safe-model",
    durationMs: Number.NaN, usage: { inputTokens: -1, outputTokens: Number.MAX_SAFE_INTEGER + 1 },
    prompt: "secret-prompt", apiKey: "secret-key",
  };
  const sanitized = sanitizeAIResearchProviderMetadata(raw as never);
  assert.deepEqual(sanitized, { provider: "router", model: "safe-model", durationMs: null,
    usage: { inputTokens: null, outputTokens: null } });
  assert.doesNotMatch(JSON.stringify(sanitized), /secret-candidate|secret-prompt|secret-key/);
  assert.deepEqual(sanitizeAIResearchProviderMetadata({ ...raw, durationMs: -0,
    usage: { inputTokens: 0, outputTokens: Number.MAX_SAFE_INTEGER } } as never), {
    provider: "router", model: "safe-model", durationMs: 0,
    usage: { inputTokens: 0, outputTokens: Number.MAX_SAFE_INTEGER },
  });
});

import assert from "node:assert/strict";
import test from "node:test";
import {
  AIProviderConnectionError,
  resolveAIProviderConnection,
} from "../server/lib/aiProviderConnection";

function errorCode(run: () => unknown): string | null {
  try {
    run();
    return null;
  } catch (error) {
    return error instanceof AIProviderConnectionError ? error.code : "unexpected_error";
  }
}

test("blank provider fields select the server-side HCNSEC connection", () => {
  assert.deepEqual(resolveAIProviderConnection({ privacyAccepted: true }, {
    HCNSEC_API_KEY: "server-key",
  }), {
    source: "default",
    apiKey: "server-key",
    baseUrl: "https://api.hcnsec.cn/v1",
    model: "auto",
    maxOutputTokens: 65_536,
    privacyAccepted: true,
  });
});

test("a visitor key without a base URL overrides only the HCNSEC key", () => {
  assert.deepEqual(resolveAIProviderConnection({
    apiKey: "visitor-key",
    privacyAccepted: true,
  }, { HCNSEC_API_KEY: "server-key" }), {
    source: "visitor",
    apiKey: "visitor-key",
    baseUrl: "https://api.hcnsec.cn/v1",
    model: "auto",
    maxOutputTokens: 65_536,
    privacyAccepted: true,
  });
});

test("a custom base URL always requires the visitor's own key", () => {
  assert.equal(errorCode(() => resolveAIProviderConnection({
    baseUrl: "https://example.com/v1",
    privacyAccepted: true,
  }, { HCNSEC_API_KEY: "server-key" })), "custom_key_required");

  assert.deepEqual(resolveAIProviderConnection({
    baseUrl: "https://example.com/v1",
    apiKey: "visitor-key",
    model: "model-a",
  }, { HCNSEC_API_KEY: "server-key" }), {
    source: "visitor",
    apiKey: "visitor-key",
    baseUrl: "https://example.com/v1",
    model: "model-a",
    maxOutputTokens: 65_536,
    privacyAccepted: false,
  });
});

test("HCNSEC requires privacy acknowledgement and a configured default key", () => {
  assert.equal(errorCode(() => resolveAIProviderConnection({}, {
    HCNSEC_API_KEY: "server-key",
  })), "hcnsec_privacy_ack_required");
  assert.equal(errorCode(() => resolveAIProviderConnection({ privacyAccepted: true }, {})),
    "default_key_not_configured");
});

test("provider values reject control characters and unsafe lengths", () => {
  assert.equal(errorCode(() => resolveAIProviderConnection({
    apiKey: "visitor\nkey",
    privacyAccepted: true,
  }, { HCNSEC_API_KEY: "server-key" })), "provider_input_invalid");
  assert.equal(errorCode(() => resolveAIProviderConnection({
    apiKey: "x".repeat(4097),
    privacyAccepted: true,
  }, { HCNSEC_API_KEY: "server-key" })), "provider_input_invalid");
  assert.equal(errorCode(() => resolveAIProviderConnection({
    model: "x".repeat(129),
    privacyAccepted: true,
  }, { HCNSEC_API_KEY: "server-key" })), "provider_input_invalid");
});

test("HCNSEC output ceiling defaults high and accepts only the approved range", () => {
  assert.equal(resolveAIProviderConnection({ privacyAccepted: true }, {
    HCNSEC_API_KEY: "server-key",
    HCNSEC_MAX_OUTPUT_TOKENS: "32768",
  }).maxOutputTokens, 32_768);
  assert.equal(errorCode(() => resolveAIProviderConnection({ privacyAccepted: true }, {
    HCNSEC_API_KEY: "server-key",
    HCNSEC_MAX_OUTPUT_TOKENS: "131072",
  })), "max_output_tokens_invalid");
  assert.equal(errorCode(() => resolveAIProviderConnection({ privacyAccepted: true }, {
    HCNSEC_API_KEY: "server-key",
    HCNSEC_MAX_OUTPUT_TOKENS: "not-a-number",
  })), "max_output_tokens_invalid");
});

// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runAIResearch, testAIProviderConnection } from "./api";
import {
  clearAIProviderOverride,
  saveAIProviderOverride,
  setHcnsecPrivacyAccepted,
} from "./aiProviderSettings";

function response(payload: unknown) {
  return { ok: true, status: 200, json: async () => payload } as Response;
}

describe("AI provider request serialization", () => {
  beforeEach(() => {
    sessionStorage.clear();
    clearAIProviderOverride();
    vi.restoreAllMocks();
  });

  it("sends session-only visitor settings and never sends an admin token", async () => {
    saveAIProviderOverride({ baseUrl: "https://provider.example/v1", apiKey: "visitor-key", model: "model-a" });
    setHcnsecPrivacyAccepted(true);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(response({ success: true }));

    await runAIResearch("2330");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain("/api/ai-research/stocks/2330/report");
    expect(init?.headers).toEqual({ "Content-Type": "application/json" });
    expect(JSON.parse(String(init?.body))).toEqual({ provider: {
      baseUrl: "https://provider.example/v1",
      apiKey: "visitor-key",
      model: "model-a",
      privacyAccepted: true,
    } });
    expect(JSON.stringify(init)).not.toContain("X-Trinity-Admin-Token");
  });

  it("tests the effective default connection with blank visitor settings", async () => {
    setHcnsecPrivacyAccepted(true);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(response({
      success: true, modelCount: 12,
    }));
    await expect(testAIProviderConnection()).resolves.toEqual({ modelCount: 12 });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain("/api/ai-provider/test");
    expect(JSON.parse(String(init?.body))).toEqual({ provider: { privacyAccepted: true } });
  });
});

// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AI_PROVIDER_STORAGE_KEY,
  HCNSEC_PRIVACY_STORAGE_KEY,
  clearAIProviderOverride,
  loadAIProviderOverride,
  readHcnsecPrivacyAccepted,
  saveAIProviderOverride,
  setHcnsecPrivacyAccepted,
} from "./aiProviderSettings";

describe("session-only AI provider settings", () => {
  beforeEach(() => {
    sessionStorage.clear();
    localStorage.clear();
  });

  it("trims and stores only nonblank visitor override fields in sessionStorage", () => {
    saveAIProviderOverride({
      baseUrl: " https://provider.example/v1 ",
      apiKey: " visitor-key ",
      model: " model-a ",
    });
    expect(loadAIProviderOverride()).toEqual({
      baseUrl: "https://provider.example/v1",
      apiKey: "visitor-key",
      model: "model-a",
    });
    expect(localStorage.length).toBe(0);
  });

  it("removes malformed data and never returns arbitrary stored types", () => {
    sessionStorage.setItem(AI_PROVIDER_STORAGE_KEY, "not-json");
    const remove = vi.spyOn(Storage.prototype, "removeItem");
    expect(loadAIProviderOverride()).toEqual({});
    expect(remove).toHaveBeenCalledWith(AI_PROVIDER_STORAGE_KEY);

    sessionStorage.setItem(AI_PROVIDER_STORAGE_KEY, JSON.stringify({ apiKey: 123 }));
    expect(loadAIProviderOverride()).toEqual({});
    expect(sessionStorage.getItem(AI_PROVIDER_STORAGE_KEY)).toBeNull();
  });

  it("clears blank overrides rather than persisting default server settings", () => {
    saveAIProviderOverride({ baseUrl: " ", apiKey: "", model: " " });
    expect(sessionStorage.getItem(AI_PROVIDER_STORAGE_KEY)).toBeNull();
    clearAIProviderOverride();
    expect(loadAIProviderOverride()).toEqual({});
  });

  it("stores HCNSEC privacy acknowledgement separately for the current session", () => {
    expect(readHcnsecPrivacyAccepted()).toBe(false);
    setHcnsecPrivacyAccepted(true);
    expect(readHcnsecPrivacyAccepted()).toBe(true);
    expect(sessionStorage.getItem(HCNSEC_PRIVACY_STORAGE_KEY)).toBe("true");
    setHcnsecPrivacyAccepted(false);
    expect(readHcnsecPrivacyAccepted()).toBe(false);
  });
});

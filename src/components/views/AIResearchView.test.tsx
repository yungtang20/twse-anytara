// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  readHcnsecPrivacyAccepted,
  saveAIProviderOverride,
} from "../../lib/aiProviderSettings";
import { AIResearchView } from "./AIResearchView";

const runResearch = vi.fn();
vi.mock("../../lib/api", () => ({
  runAIResearch: (...args: unknown[]) => runResearch(...args),
}));

describe("AIResearchView provider consent", () => {
  beforeEach(() => {
    sessionStorage.clear();
    runResearch.mockReset().mockResolvedValue(undefined);
  });
  afterEach(cleanup);

  it("blocks default HCNSEC until the visitor accepts the third-party retention notice", async () => {
    const user = userEvent.setup();
    render(<AIResearchView />);
    expect(screen.getByText(/免費 HCNSEC/)).toBeInTheDocument();
    expect(screen.getByText(/至少保留 180 天/)).toBeInTheDocument();
    expect(screen.getByText(/請求時間、IP、裝置資料、提示內容與回應內容/)).toBeInTheDocument();
    expect(screen.getByText(/個人資料、機密資訊、身分驗證資訊或未公開商業資訊/)).toBeInTheDocument();
    const submit = screen.getByRole("button", { name: "產生 AI 綜合研究" });
    expect(submit).toBeDisabled();
    await user.click(screen.getByRole("checkbox", { name: /我了解：HCNSEC/ }));
    expect(readHcnsecPrivacyAccepted()).toBe(true);
    expect(submit).toBeEnabled();
    await user.click(submit);
    await waitFor(() => expect(runResearch).toHaveBeenCalledWith("2330", expect.any(AbortSignal)));
  });

  it("does not require HCNSEC consent for a custom non-HCNSEC provider", () => {
    saveAIProviderOverride({ baseUrl: "https://provider.example/v1", apiKey: "visitor-key" });
    render(<AIResearchView />);
    expect(screen.getByText(/個人 AI 供應商/)).toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: /我了解並同意/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "產生 AI 綜合研究" })).toBeEnabled();
  });
});

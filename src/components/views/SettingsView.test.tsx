// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AI_PROVIDER_STORAGE_KEY } from "../../lib/aiProviderSettings";
import { SettingsView } from "./SettingsView";

const testConnection = vi.fn();
vi.mock("../../lib/api", () => ({
  testAIProviderConnection: (...args: unknown[]) => testConnection(...args),
}));

describe("SettingsView visitor AI settings", () => {
  afterEach(cleanup);
  beforeEach(() => {
    sessionStorage.clear();
    testConnection.mockReset();
  });

  it("offers free HCNSEC and session-only BYOK without administrator or FinMind controls", () => {
    render(<SettingsView />);
    expect(screen.getByText("預設模式：免費 HCNSEC")).toBeInTheDocument();
    expect(screen.getByLabelText("Base URL（選填）")).toBeInTheDocument();
    expect(screen.getByLabelText("API Key（選填）")).toHaveAttribute("type", "password");
    expect(screen.getByLabelText("Model（選填）")).toBeInTheDocument();
    expect(screen.getByText(/至少保留 180 天/)).toBeInTheDocument();
    expect(screen.getByText(/個人資料、機密資訊、身分驗證資訊或未公開商業資訊/)).toBeInTheDocument();
    expect(screen.queryByText(/管理憑證|FinMind|\.env/)).not.toBeInTheDocument();
  });

  it("saves trimmed visitor settings only in sessionStorage and can clear them", async () => {
    const user = userEvent.setup();
    render(<SettingsView />);
    await user.type(screen.getByLabelText("Base URL（選填）"), " https://provider.example/v1 ");
    await user.type(screen.getByLabelText("API Key（選填）"), " visitor-key ");
    await user.type(screen.getByLabelText("Model（選填）"), " model-a ");
    await user.click(screen.getByRole("button", { name: "儲存至本次工作階段" }));
    expect(JSON.parse(sessionStorage.getItem(AI_PROVIDER_STORAGE_KEY) || "{}")).toEqual({
      baseUrl: "https://provider.example/v1", apiKey: "visitor-key", model: "model-a",
    });
    await user.click(screen.getByRole("button", { name: "清除個人設定" }));
    expect(sessionStorage.getItem(AI_PROVIDER_STORAGE_KEY)).toBeNull();
  });

  it("tests the saved effective connection through the public probe", async () => {
    testConnection.mockResolvedValue({ modelCount: 5 });
    const user = userEvent.setup();
    render(<SettingsView />);
    await user.click(screen.getByRole("checkbox"));
    await user.click(screen.getByRole("button", { name: "測試連線" }));
    expect(testConnection).toHaveBeenCalledTimes(1);
    expect(await screen.findByText("連線成功，可用模型 5 個")).toBeInTheDocument();
  });
});

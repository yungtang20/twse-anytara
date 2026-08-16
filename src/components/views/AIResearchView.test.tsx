// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  readHcnsecPrivacyAccepted,
  saveAIProviderOverride,
} from "../../lib/aiProviderSettings";
import type { AIResearchReportSuccessResponse } from "../../lib/api";
import { AIResearchView, ReportView } from "./AIResearchView";

const runResearch = vi.fn();
vi.mock("../../lib/api", () => ({
  runAIResearch: (...args: unknown[]) => runResearch(...args),
}));

const publishedReportFixture = {
  success: true,
  publicationReady: true,
  semanticGrounding: "server-grounded",
  draft: null,
  recommendation: null,
  valuation: null,
  auditSummary: {
    mechanicalPassed: true,
    citationCoverage: 1,
    warnings: [],
    dataQuality: { status: "complete", missingDatasets: [], staleDatasets: [], warnings: [], informationRichness: "A" },
    strategies: {
      sr: { status: "ok", date: "2026-08-15", signal: "SELL" },
      ma: { status: "ok", date: "2026-08-15", signal: "HOLD" },
      chips: { status: "ok", date: "2026-08-15", signal: "HOLD" },
      pattern: { status: "ok", date: "2026-08-15", signal: "HOLD" },
    },
    limitations: [],
    citations: [{ findingId: "finding:sell", evidenceIds: ["ev:signal"] }],
    sources: [{ id: "supabase:stock_price", dataset: "stock_price", provider: "supabase", asOf: "2026-08-15", estimated: false }],
  },
  providerMetadata: [{ provider: "hcnsec", model: "a-very-long-model-name-that-must-wrap", durationMs: null,
    usage: { inputTokens: 100, outputTokens: 200 } }],
  publishedReport: {
    status: "formally-published",
    generatedAt: "2026-08-16T01:02:03.000Z",
    semanticGrounding: "server-grounded",
    claims: [{ id: "finding:sell", kind: "strategy_result", stance: "negative",
      text: "截至 2026-08-15，支撐壓力策略訊號為 SELL", evidenceIds: ["ev:signal"],
      limitations: [], estimated: false }],
    conclusion: "伺服器落地結論",
    conclusionFindingIds: { supporting: [], opposing: ["finding:sell"], limitations: [] },
    recommendation: { verdict: "SELL", label: "賣出", horizonMonths: 12, confidence: 0.65,
      supportingFindingIds: [], opposingFindingIds: ["finding:sell"], riskFindingIds: [],
      confidenceGrounding: "model-estimate-unverified" },
    valuation: { method: "PE", asOf: "2026-08-15", currentPrice: 100,
      metric: { name: "EPS", value: 5, period: "2025Q4", sourceId: "supabase:eps", estimated: false },
      scenarios: [
        { name: "conservative", multiple: 10, targetPrice: 50, expectedReturnRatio: -0.5, expectedReturnPercent: -50 },
        { name: "base", multiple: 12, targetPrice: 60, expectedReturnRatio: -0.4, expectedReturnPercent: -40 },
        { name: "optimistic", multiple: 14, targetPrice: 70, expectedReturnRatio: -0.3, expectedReturnPercent: -30 },
      ], assumptionGrounding: "model-selected-bounded-assumptions" },
    grounding: { facts: "server-grounded", calculations: "server-calculated",
      valuationMultiples: "model-selected-bounded-assumptions",
      recommendationConfidence: "model-estimate-unverified" },
  },
} satisfies AIResearchReportSuccessResponse;

const limitationReportFixture = structuredClone(publishedReportFixture) as AIResearchReportSuccessResponse & {
  publicationReady: true;
  publishedReport: NonNullable<AIResearchReportSuccessResponse["publishedReport"]>;
};
limitationReportFixture.publishedReport.claims.push({
  id: "finding:limitation", kind: "limitation", stance: "insufficient",
  text: "月營收資料涵蓋不足", evidenceIds: [], limitations: ["月營收資料涵蓋不足"], estimated: false,
});
limitationReportFixture.publishedReport.conclusionFindingIds.limitations = ["finding:limitation"];

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

  it.each(["constructor", "wire-error"])("shows a neutral error for the unsafe wire code %s", async (wireCode) => {
    saveAIProviderOverride({ baseUrl: "https://provider.example/v1", apiKey: "visitor-key" });
    runResearch.mockRejectedValueOnce(new Error(wireCode));
    const user = userEvent.setup();
    render(<AIResearchView />);

    await user.click(screen.getByRole("button", { name: "產生 AI 綜合研究" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("研究流程目前無法完成，請稍後再試");
    expect(alert).not.toHaveTextContent(wireCode);
  });
});

describe("ReportView", () => {
  afterEach(cleanup);

  it("renders a localized formal report without mislabelling empty risk findings", async () => {
    const user = userEvent.setup();
    render(<ReportView report={publishedReportFixture} />);
    expect(screen.getByText("資料完整度")).toBeInTheDocument();
    expect(screen.getByText("AI 服務資訊")).toBeInTheDocument();
    expect(screen.getByText("a-very-long-model-name-that-must-wrap")).toHaveClass("min-w-0", "break-words");
    expect(screen.getByText("處理時間未知")).toHaveClass("shrink-0", "whitespace-nowrap");
    expect(screen.getByText(/模型自評信心 65%/)).toHaveTextContent("未經外部驗證，不代表歷史準確率");
    expect(screen.getByText("風險與資料限制：")).toBeInTheDocument();
    expect(screen.getByText("本次未列入需關注的主要風險或資料限制")).toBeInTheDocument();
    expect(screen.queryByText(/^Data quality$/)).not.toBeInTheDocument();
    expect(screen.getAllByText(/事實已由伺服器資料驗證/).length).toBeGreaterThan(0);
    const summary = screen.getByText("查看技術詳細資料").closest("summary");
    expect(summary).toBeInTheDocument();
    const details = summary?.closest("details");
    expect(details).toBeInTheDocument();
    if (!summary || !details) throw new Error("expected native provenance disclosure");

    await user.tab();
    expect(summary).toHaveFocus();
    await user.keyboard("{Enter}");
    if (!details.hasAttribute("open")) await user.click(summary);
    expect(details).toHaveAttribute("open");

    const technicalDetails = within(details);
    for (const rawValue of [
      "finding:sell", "ev:signal", "supabase:stock_price", "stock_price", "supabase", "2026-08-15",
      "hcnsec", "a-very-long-model-name-that-must-wrap", "supabase:eps",
    ]) expect(technicalDetails.getAllByText(new RegExp(rawValue.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))).length).toBeGreaterThan(0);
  });

  it("shows conclusion limitations instead of the empty risk state", () => {
    render(<ReportView report={limitationReportFixture} />);
    const riskAndLimitationRow = screen.getByText("風險與資料限制：").closest("p");
    expect(riskAndLimitationRow).toBeInTheDocument();
    if (!riskAndLimitationRow) throw new Error("expected combined risk and limitation row");
    expect(within(riskAndLimitationRow).getByText("月營收資料涵蓋不足")).toBeInTheDocument();
    expect(screen.queryByText("本次未列入需關注的主要風險或資料限制")).not.toBeInTheDocument();
  });

  it("uses neutral labels for reserved and unknown strategy, signal, and scenario wire values", () => {
    const unsafeReport = structuredClone(publishedReportFixture) as unknown as Record<string, unknown>;
    const auditSummary = unsafeReport.auditSummary as Record<string, unknown>;
    auditSummary.strategies = JSON.parse(`{
      "constructor":{"status":"ok","date":"2026-08-15","signal":"__proto__"},
      "wire-strategy":{"status":"ok","date":"2026-08-15","signal":"wire-signal"}
    }`);
    const publishedReport = unsafeReport.publishedReport as Record<string, unknown>;
    const valuation = publishedReport.valuation as Record<string, unknown>;
    valuation.scenarios = [
      { name: "constructor", multiple: 10, targetPrice: 50, expectedReturnRatio: -0.5, expectedReturnPercent: -50 },
      { name: "wire-scenario", multiple: 12, targetPrice: 60, expectedReturnRatio: -0.4, expectedReturnPercent: -40 },
    ];

    render(<ReportView report={unsafeReport as unknown as AIResearchReportSuccessResponse} />);

    expect(screen.getAllByText("策略名稱未知")).toHaveLength(2);
    expect(screen.getAllByText("訊號未判定")).toHaveLength(2);
    expect(screen.getAllByText("估值情境未知")).toHaveLength(2);
    for (const rawValue of ["constructor", "wire-strategy", "__proto__", "wire-signal", "wire-scenario"]) {
      expect(screen.queryByText(rawValue)).not.toBeInTheDocument();
    }
  });
});

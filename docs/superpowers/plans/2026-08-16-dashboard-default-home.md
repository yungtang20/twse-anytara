# Dashboard and AI Report Presentation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Open TRINITY on the dashboard and turn the AI research report into a clear Chinese-language, traceable, production-ready interface without weakening its publication safeguards.

**Architecture:** Keep route fallback in `src/lib/navigation.ts`, presentation-only translation in a focused frontend helper, and deterministic strategy wording in the existing server finding policy. Shared response contracts, Supabase, the model selection contract, auditor, and publication gate remain unchanged.

**Tech Stack:** TypeScript 5.8, React 19, Tailwind CSS 4, Node.js 24, Vitest/Testing Library, Node test runner through `tsx`, Vite 6, GitHub Actions, Render.

## Global Constraints

- Do not add or upgrade dependencies.
- Do not change Supabase schema, data, migrations, RLS, credentials, synchronization, or production-data state.
- Do not add the cancelled anti-gambling integration.
- Do not change provider configuration, AI request limits, or report transport contracts.
- Do not change `PublishedResearchRecommendation.confidenceGrounding` from `model-estimate-unverified`.
- Do not weaken the AI report auditor, selection contract, finding-policy allowlist, or publication gate.
- Do not let the model author factual report text or technical evidence identifiers.
- Preserve every explicit supported hash route.
- Preserve technical provenance in an accessible keyboard-operable disclosure.
- Do not stage or commit existing unrelated working-tree files.
- An unexecuted check is `未驗證`, never `通過` or `失敗`.

---

## File Structure

- Modify `src/lib/navigation.ts`: continue owning empty/unsupported hash fallback.
- Modify `index.html`: own the static browser document title.
- Modify `tests/self-check.ts`: cover the route fallback and title regression.
- Modify `server/lib/aiResearchFindingPolicy.ts`: map strategy signal evidence paths to deterministic Chinese field labels.
- Modify `tests/ai-research-selection-contract.test.ts`: prove SELL remains publishable with verified no canonical trade risk and renders readable strategy text.
- Create `src/lib/aiResearchPresentation.ts`: own frontend-only label maps and formatting fallbacks.
- Modify `src/components/views/AIResearchView.tsx`: consume presentation helpers, improve layout/copy, and expose provenance through an accessible disclosure.
- Modify `src/components/views/AIResearchView.test.tsx`: behavior-test the formal report, empty risk list, layout states, and technical disclosure.
- Modify `tests/ai-research-report-ui.test.ts`: replace source assertions that currently require the problematic English labels.
- Modify `tests/ai-research-recommendation-ui.test.ts`: lock the clarified confidence and risk copy.

### Task 1: Default dashboard and TRINITY browser title

**Files:**
- Modify: `tests/self-check.ts:418-421`
- Modify: `src/lib/navigation.ts:3`
- Modify: `index.html:41`
- Test: `tests/self-check.ts`

**Interfaces:**
- Consumes: `parseAppView(hash: string): AppView` and `appViewHash(view: AppView): string`.
- Produces: `DEFAULT_APP_VIEW: AppView = "dashboard"` and document title `TRINITY 台股決策研究平台`.

- [ ] **Step 1: Write the failing route and title assertions**

Replace the navigation assertion block and add the title check:

```ts
assert.equal(parseAppView(""), "dashboard");
assert.equal(parseAppView("#/dashboard"), "dashboard");
assert.equal(parseAppView("#/markets"), "markets");
assert.equal(parseAppView("#/strategies"), "strategies");
assert.equal(parseAppView("#/ai-analysis"), "ai-analysis");
assert.equal(parseAppView("#/settings"), "settings");
assert.equal(parseAppView("#/unknown"), "dashboard");
assert.equal(appViewHash("markets"), "#/markets");

const indexHtml = readFileSync(path.join(process.cwd(), "index.html"), "utf8");
assert.match(indexHtml, /<title>TRINITY 台股決策研究平台<\/title>/);
assert.doesNotMatch(indexHtml, /My Google AI Studio App/);
```

- [ ] **Step 2: Run the focused check and confirm the expected failure**

Run:

```powershell
npx tsx tests/self-check.ts
```

Expected: non-zero exit because the fallback still returns `markets`; after only that assertion is temporarily isolated or fixed, the title assertion also fails against the template title.

- [ ] **Step 3: Make the minimal production changes**

Change `src/lib/navigation.ts`:

```ts
export const DEFAULT_APP_VIEW: AppView = "dashboard";
```

Change `index.html`:

```html
<title>TRINITY 台股決策研究平台</title>
```

Do not add startup redirects or special cases in `App.tsx`.

- [ ] **Step 4: Re-run the focused check**

Run:

```powershell
npx tsx tests/self-check.ts
```

Expected: exit code `0` and the existing self-check completion message.

- [ ] **Step 5: Review and commit only Task 1**

Run:

```powershell
git diff --check -- index.html src/lib/navigation.ts tests/self-check.ts
git diff -- index.html src/lib/navigation.ts tests/self-check.ts
git add -- index.html src/lib/navigation.ts tests/self-check.ts
git diff --cached --name-only
git commit -m "fix: open TRINITY on dashboard"
```

Expected staged names: `index.html`, `src/lib/navigation.ts`, and `tests/self-check.ts` only.

### Task 2: Deterministic Chinese strategy-signal wording

**Files:**
- Modify: `tests/ai-research-selection-contract.test.ts:152-179`
- Modify: `server/lib/aiResearchFindingPolicy.ts:42-56`
- Test: `tests/ai-research-selection-contract.test.ts`

**Interfaces:**
- Consumes: evidence fields matching `strategies.<StrategyId>.signal` and the existing trusted `renderDated` path.
- Produces: `fieldLabel(field: string): string` labels `支撐壓力策略訊號`, `均線策略訊號`, `籌碼策略訊號`, or `型態策略訊號`; no model-authored text is introduced.

- [ ] **Step 1: Extend the existing SELL publication test before implementation**

In `server verdict policy keeps a two-domain one-sided SELL aligned with deep valuation downside`, add:

```ts
assert.equal(packet.tradeRisks.highestLevel, "none");
assert.deepEqual(result.publishedReport?.recommendation.riskFindingIds, []);
const strategyClaim = result.publishedReport?.claims.find((claim) => claim.kind === "strategy_result");
assert.ok(strategyClaim);
assert.match(strategyClaim.text, /支撐壓力策略訊號為 SELL/);
assert.doesNotMatch(strategyClaim.text, /signal為/);
```

This locks the valid `SELL + highestLevel none + empty riskFindingIds` case and the readable server-rendered claim.

- [ ] **Step 2: Run the focused test and confirm the wording assertion fails**

Run:

```powershell
npx tsx --test tests/ai-research-selection-contract.test.ts
```

Expected: non-zero exit at the new strategy text assertion because the current renderer emits `signal為 SELL`.

- [ ] **Step 3: Add the narrow strategy field mapping**

Add immediately before `fieldLabel`:

```ts
const STRATEGY_SIGNAL_LABELS: Record<string, string> = {
  sr: "支撐壓力策略訊號",
  ma: "均線策略訊號",
  chips: "籌碼策略訊號",
  pattern: "型態策略訊號",
};
```

Start `fieldLabel` with:

```ts
const strategySignal = /^strategies\.([^.]+)\.signal$/.exec(field);
if (strategySignal) return STRATEGY_SIGNAL_LABELS[strategySignal[1]] ?? "策略訊號";
```

Leave the finding allowlist, evidence resolution, numeric policy, and render templates unchanged.

- [ ] **Step 4: Re-run the focused tests**

Run:

```powershell
npx tsx --test tests/ai-research-selection-contract.test.ts tests/ai-research-publication-gate.test.ts tests/ai-research-structured-findings.test.ts
```

Expected: all tests exit `0`, including the existing rule that a non-`none` canonical trade risk cannot be omitted.

- [ ] **Step 5: Review and commit only Task 2**

Run:

```powershell
git diff --check -- server/lib/aiResearchFindingPolicy.ts tests/ai-research-selection-contract.test.ts
git diff -- server/lib/aiResearchFindingPolicy.ts tests/ai-research-selection-contract.test.ts
git add -- server/lib/aiResearchFindingPolicy.ts tests/ai-research-selection-contract.test.ts
git diff --cached --name-only
git commit -m "fix: clarify AI strategy findings"
```

### Task 3: Localized and traceable AI report presentation

**Files:**
- Create: `src/lib/aiResearchPresentation.ts`
- Modify: `src/components/views/AIResearchView.tsx:111-273`
- Modify: `src/components/views/AIResearchView.test.tsx`
- Modify: `tests/ai-research-report-ui.test.ts:52-66`
- Modify: `tests/ai-research-recommendation-ui.test.ts:17-26`
- Test: the four files above

**Interfaces:**
- Consumes: string enum values already present in `AIResearchReportSuccessResponse`.
- Produces:
  - `informationRichnessLabel(value: string): string`
  - `qualityStatusLabel(value: string): string`
  - `claimKindLabel(value: string): string`
  - `claimStanceLabel(value: string): string`
  - `groundingLabel(value: string): string`
  - `providerLabel(value: string): string`
  - `datasetLabel(value: string): string`
  - `formatDuration(durationMs: number | null): string`
- Unknown values return neutral Chinese fallbacks and never throw. Raw values remain available only inside the technical disclosure.

- [ ] **Step 1: Add a typed published-report fixture and failing behavior test**

Export `ReportView` from `AIResearchView.tsx` for direct component testing. In `AIResearchView.test.tsx`, import `type AIResearchReportSuccessResponse` and add this fixture:

```ts
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
```

Add the test:

```tsx
it("renders a localized formal report without mislabelling empty risk findings", () => {
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
  const disclosure = screen.getByText("查看技術詳細資料");
  expect(disclosure.closest("summary")).toBeInTheDocument();
});
```

Add a second fixture and test for a formal report that has a conclusion limitation but no risk finding:

```tsx
const limitationReportFixture: AIResearchReportSuccessResponse = structuredClone(publishedReportFixture);
limitationReportFixture.publishedReport.claims.push({
  id: "finding:limitation", kind: "limitation", stance: "insufficient",
  text: "月營收資料涵蓋不足", evidenceIds: [], limitations: ["月營收資料涵蓋不足"], estimated: false,
});
limitationReportFixture.publishedReport.conclusionFindingIds.limitations = ["finding:limitation"];

it("shows conclusion limitations instead of the empty risk state", () => {
  render(<ReportView report={limitationReportFixture} />);
  expect(screen.getAllByText("月營收資料涵蓋不足").length).toBeGreaterThan(0);
  expect(screen.queryByText("本次未列入需關注的主要風險或資料限制")).not.toBeInTheDocument();
});
```

- [ ] **Step 2: Update source-policy assertions before implementation**

In `tests/ai-research-report-ui.test.ts`, require `資料完整度`, `AI 服務資訊`, `資料來源與佐證`, `查看技術詳細資料`, and the existing preview/formal sections. Add negative assertions for primary raw labels:

```ts
assert.doesNotMatch(view, /title="Data quality"|title="Provider \/ Model"|title="Citations \/ 來源識別"/);
assert.match(view, /<details/);
assert.match(view, /<summary/);
assert.match(view, /groundingLabel\(published\.semanticGrounding\)/);
```

Delete the old `assert.match(view, /server-grounded/)` source assertion. The typed response and publication-gate tests continue to lock the raw contract value; the component behavior test now locks its Chinese presentation.

In `tests/ai-research-recommendation-ui.test.ts`, replace `主要風險` with these required strings:

```ts
"模型自評信心", "未經外部驗證，不代表歷史準確率",
"風險與資料限制", "本次未列入需關注的主要風險或資料限制"
```

- [ ] **Step 3: Run the focused tests and confirm failure**

Run:

```powershell
npm run test:ui -- src/components/views/AIResearchView.test.tsx
npx tsx --test tests/ai-research-report-ui.test.ts tests/ai-research-recommendation-ui.test.ts
```

Expected: both commands report failures against the current English labels, old confidence wording, old risk empty state, and missing disclosure.

- [ ] **Step 4: Create the presentation helper**

Create `src/lib/aiResearchPresentation.ts` with readonly label records for all current values:

```ts
const CLAIM_KIND_LABELS: Record<string, string> = {
  company_fact: "公司資料", market_snapshot: "市場快照", financial_metric: "財務指標",
  institutional_flow: "法人動向", tdcc_concentration: "股權集中度", trade_risk: "交易風險",
  strategy_result: "策略結果", evidence_comparison: "資料比較", limitation: "資料限制",
};
const CLAIM_STANCE_LABELS: Record<string, string> = {
  positive: "正向", neutral: "中性", negative: "負向", insufficient: "資料不足",
};
const GROUNDING_LABELS: Record<string, string> = {
  "server-grounded": "事實已由伺服器資料驗證",
  "server-calculated": "數值由伺服器計算",
  "model-selected-bounded-assumptions": "模型選擇的有界假設",
  "model-estimate-unverified": "模型估計，未經外部驗證",
  unverified: "尚未完成語意發布驗證",
};
const PROVIDER_LABELS: Record<string, string> = {
  hcnsec: "HCNSEC", custom: "個人 AI 供應商", router: "AI 路由服務", fake: "測試服務",
  supabase: "Supabase", finmind: "FinMind", "external-estimate": "外部估算來源",
};
const DATASET_LABELS: Record<string, string> = {
  stock_meta: "公司基本資料", financials: "財務資料", eps: "每股盈餘資料",
  TaiwanStockFinancialStatements: "財務報表", TaiwanStockBalanceSheet: "資產負債表",
  TaiwanStockCashFlowsStatement: "現金流量表", TaiwanStockMonthRevenue: "月營收資料",
  TaiwanStockPER: "估值資料", TaiwanStockDividend: "股利資料", stock_price: "行情資料",
  stock_institutional: "法人資料", tdcc_shareholding: "TDCC 資料",
  stock_trade_risk: "交易風險資料", strategy_sr: "支撐壓力策略",
  strategy_ma: "均線策略", strategy_chips: "籌碼策略", strategy_pattern: "型態策略",
};
```

Use these exact functions and fallback rules:

```ts
export const informationRichnessLabel = (value: string) => ({ A: "資訊豐富", B: "資訊足夠", C: "資訊有限" }[value] ?? "資訊等級未知");
export const qualityStatusLabel = (value: string) => ({ complete: "資料完整", partial: "部分資料" }[value] ?? "資料狀態未知");
export const claimKindLabel = (value: string) => CLAIM_KIND_LABELS[value] ?? "其他研究發現";
export const claimStanceLabel = (value: string) => CLAIM_STANCE_LABELS[value] ?? "方向未分類";
export const groundingLabel = (value: string) => GROUNDING_LABELS[value] ?? "驗證狀態未知";
export const providerLabel = (value: string) => PROVIDER_LABELS[value] ?? "其他 AI 服務";
export const datasetLabel = (value: string) => DATASET_LABELS[value] ?? "其他資料來源";
export const formatDuration = (durationMs: number | null) => durationMs === null
  ? "處理時間未知" : `處理時間約 ${(durationMs / 1000).toFixed(1)} 秒`;
```

Do not put raw IDs in fallback labels.

- [ ] **Step 5: Apply the helpers and accessible layout in `AIResearchView`**

Make these bounded changes:

- `QualityPanel`: title `資料完整度`; render `informationRichnessLabel` and `qualityStatusLabel`.
- `ProviderPanel`: title `AI 服務資訊`; each row uses `flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between`; render the model in a `span` using `min-w-0 break-words`; duration uses `shrink-0 whitespace-nowrap` and `formatDuration`.
- `PreviewPanel` and `PublishedReportPanel`: render `claimKindLabel` and `claimStanceLabel`; use `groundingLabel` instead of raw `server-grounded`.
- `PublishedReportPanel`: state that facts and calculations are verified but the recommendation confidence remains a model self-assessment.
- `RecommendationPanel`: use separate helpers for ordinary empty lists and the risk/limitation empty state. For a formal report, merge and de-duplicate `recommendation.riskFindingIds` with `publishedReport.conclusionFindingIds.limitations`; for a preview, use `recommendation.riskFindingIds`. Render all resolved risk and limitation claims, then show `本次未列入需關注的主要風險或資料限制` only when the combined list is empty. Render `模型自評信心 N%（未經外部驗證，不代表歷史準確率）` and label the line `風險與資料限制`.
- `ValuationPanel`: rename `source` to `資料來源` and `as-of` to `資料日期`; keep raw source ID in the technical disclosure rather than the primary line.
- `ProvenancePanel`: title `資料來源與佐證`; show human-readable dataset/provider/date summaries first, then add native `<details><summary>查看技術詳細資料</summary>...</details>` containing raw finding IDs, evidence IDs, source IDs, dataset enums, provider enums, and as-of values.
- Export `ReportView` for the behavior test; do not change the API response type.

- [ ] **Step 6: Re-run focused tests and type checking**

Run:

```powershell
npm run test:ui -- src/components/views/AIResearchView.test.tsx
npx tsx --test tests/ai-research-report-ui.test.ts tests/ai-research-recommendation-ui.test.ts
npm run typecheck
```

Expected: all three commands exit `0`.

- [ ] **Step 7: Review and commit only Task 3**

Run:

```powershell
git diff --check -- src/lib/aiResearchPresentation.ts src/components/views/AIResearchView.tsx src/components/views/AIResearchView.test.tsx tests/ai-research-report-ui.test.ts tests/ai-research-recommendation-ui.test.ts
git diff -- src/lib/aiResearchPresentation.ts src/components/views/AIResearchView.tsx src/components/views/AIResearchView.test.tsx tests/ai-research-report-ui.test.ts tests/ai-research-recommendation-ui.test.ts
git add -- src/lib/aiResearchPresentation.ts src/components/views/AIResearchView.tsx src/components/views/AIResearchView.test.tsx tests/ai-research-report-ui.test.ts tests/ai-research-recommendation-ui.test.ts
git diff --cached --name-only
git commit -m "fix: localize AI research report"
```

### Task 4: Full verification and independent release review

**Files:**
- No planned source modifications.
- Verify: all Task 1-3 files and the canonical project checks.

**Interfaces:**
- Consumes: the three independently committed implementation tasks.
- Produces: evidence that the complete branch satisfies the approved specification and has no release-blocking regression.

- [ ] **Step 1: Run focused regression commands independently**

```powershell
npx tsx tests/self-check.ts
npx tsx --test tests/ai-research-selection-contract.test.ts tests/ai-research-publication-gate.test.ts tests/ai-research-structured-findings.test.ts
npm run test:ui -- src/components/views/AIResearchView.test.tsx
npx tsx --test tests/ai-research-report-ui.test.ts tests/ai-research-recommendation-ui.test.ts
```

Expected: each executed command exits `0`.

- [ ] **Step 2: Run canonical release checks independently**

```powershell
npm run typecheck
npm test
npm run test:ui
npm run test:eval
npm run build
```

Expected: each executed command exits `0`. If any fails, stop publication, diagnose the root cause, and never weaken a gate or test merely to obtain a pass.

- [ ] **Step 3: Verify exact scope and working-tree isolation**

```powershell
git diff --check origin/main...HEAD
git diff --name-status origin/main...HEAD
git status --short
```

Expected: approved commits contain only the design, plan, Task 1-3 implementation, and directly related tests. Pre-existing unrelated files remain unstaged and unchanged by this work.

- [ ] **Step 4: Dispatch final independent review**

Provide the final reviewer with the approved specification, this plan, the base commit, the implementation commits, all executed command outputs, and `git diff origin/main...HEAD`. The reviewer must explicitly check route behavior, title, user-facing copy, confidence semantics, empty-risk semantics, strategy renderer trust boundary, provenance accessibility, Supabase non-modification, and test adequacy.

Expected: no unresolved critical, high, or medium finding before publication.

### Task 5: GitHub, Render, and live browser acceptance

**Files:**
- No source files modified.
- Verify: GitHub pull request, Render deployment, and `https://twse-app.onrender.com/`.

**Interfaces:**
- Consumes: a cleanly reviewed feature branch with passing canonical checks.
- Produces: merged GitHub commits and a live Render deployment verified against the approved user experience.

- [ ] **Step 1: Reconfirm publication evidence**

```powershell
git status --short
git log --oneline origin/main..HEAD
git diff --name-status origin/main...HEAD
```

Expected: no implementation file remains unstaged; unrelated pre-existing files are visibly excluded.

- [ ] **Step 2: Push the current branch and create or update the pull request**

```powershell
git push -u origin codex/supabase-sync-hardening
gh pr view codex/supabase-sync-hardening --repo yungtang20/twse-anytara --json number,url
```

If no pull request exists, create one with an accurate title/body covering the dashboard, title, and AI report presentation. Expected: GitHub returns the branch and pull-request URL.

- [ ] **Step 3: Require green checks and merge**

```powershell
$trinityPr = gh pr view codex/supabase-sync-hardening --repo yungtang20/twse-anytara --json number --jq '.number'
gh pr checks $trinityPr --repo yungtang20/twse-anytara --watch
gh pr merge $trinityPr --repo yungtang20/twse-anytara --merge --delete-branch=false
```

Expected: required checks complete successfully before merge. Do not merge while checks are pending, failing, or unavailable.

- [ ] **Step 4: Deploy the merged commit to Render**

Because `render.yaml` has `autoDeploy: false`, trigger a manual deployment of the existing `twse-app` service. Record the merged commit and deployed commit and wait for Render to report a successful live state.

- [ ] **Step 5: Perform live browser acceptance**

Verify:

```text
https://twse-app.onrender.com/
https://twse-app.onrender.com/#/markets
https://twse-app.onrender.com/#/ai-analysis
```

Acceptance criteria:

- bare URL visibly opens the dashboard and the document title is `TRINITY 台股決策研究平台`;
- `#/markets` still opens market analysis;
- AI analysis displays the Chinese labels, wrapping provider/model/time layout, clarified confidence warning, correct empty-risk wording, readable strategy signal, and keyboard-operable provenance details;
- deployed assets and health endpoint return success;
- browser console contains no application error;
- no Supabase mutation is performed for this acceptance.

- [ ] **Step 6: Report exact final evidence**

Report implementation commits, pull-request URL, merged commit, Render deployment status/commit, live observations for all three URLs, and browser-console result. Mark any unexecuted or unavailable check `未驗證`.

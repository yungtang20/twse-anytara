import assert from "node:assert/strict";
import { buildStockSnapshot, type SnapshotDatasetInput } from "../server/lib/stockSnapshot";
import { validateEvidenceReport } from "../server/lib/evidenceReport";
import { evaluateFrameworkEligibility, FRAMEWORK_CONTRACTS } from "../server/lib/frameworkEligibility";

// Synthetic, deterministic fixtures only. They verify contracts and formulas and
// must never be presented as real market observations.
const start = new Date("2025-09-01T00:00:00Z");
const prices = Array.from({ length: 260 }, (_, index) => {
  const date = new Date(start.getTime() + index * 86_400_000).toISOString().slice(0, 10);
  const close = 100 + index * 0.5;
  return { date, open: close - 0.5, max: close + 1, min: close - 1, close, Trading_Volume: 1_000_000 + index };
});
const quarterDates = ["2025-06-30", "2025-09-30", "2025-12-31", "2026-03-31"];

function completeInputs(): SnapshotDatasetInput[] {
  const statements = quarterDates.flatMap((date, index) => [
    { date, type: "Revenue", value: 100 + index * 10 },
    { date, type: "GrossProfit", value: 50 + index * 5 },
    { date, type: "IncomeAfterTaxes", value: 10 + index * 2 },
    { date, type: "EPS", value: 1 + index * 0.2 },
  ]);
  const balanceDates = ["2025-03-31", ...quarterDates];
  const balance = balanceDates.flatMap((date, index) => [
    { date, type: "Equity", value: 200 + index * 10 },
    { date, type: "Liabilities", value: 100 + index * 5 },
  ]);
  const cashFlows = quarterDates.flatMap((date) => [
    { date, type: "CashFlowsFromOperatingActivities", value: 20 },
    { date, type: "PropertyAndPlantAndEquipment", value: -5 },
  ]);
  return [
    { dataset: "TaiwanStockPrice", rows: prices },
    { dataset: "TaiwanStockMonthRevenue", rows: [
      { date: "2025-04-01", revenue_year: 2025, revenue_month: 4, revenue: 100 },
      { date: "2026-04-01", revenue_year: 2026, revenue_month: 4, revenue: 120 },
    ] },
    { dataset: "TaiwanStockPER", rows: [{ date: "2026-05-18", PER: 20, PBR: 3, dividend_yield: 2.5 }] },
    { dataset: "TaiwanStockFinancialStatements", rows: statements },
    { dataset: "TaiwanStockBalanceSheet", rows: balance },
    { dataset: "TaiwanStockCashFlowsStatement", rows: cashFlows },
    { dataset: "TaiwanStockInstitutionalInvestorsBuySell", rows: [{ date: "2026-05-18", name: "Foreign_Investor", buy: 10, sell: 5 }] },
    { dataset: "TaiwanStockMarginPurchaseShortSale", rows: [{ date: "2026-05-18", MarginPurchaseTodayBalance: 100 }] },
    { dataset: "TaiwanStockDividend", rows: [{ date: "2025-07-01", CashEarningsDistribution: 2.5 }] },
    { dataset: "TaiwanStockShareholding", rows: [{ date: "2026-05-18", ForeignInvestmentSharesRatio: 40 }] },
    { dataset: "TDCCShareholding", source: "tdcc_sqlite", rows: [{ date: "2026-05-16", total_shares: 1_000, whale_ratio: 60, retail_ratio: 10 }] },
  ];
}

function etfInputs(): SnapshotDatasetInput[] {
  return completeInputs().filter((input) => ["TaiwanStockPrice", "TaiwanStockPER", "TaiwanStockDividend"].includes(input.dataset));
}

const cases = [
  { category: "electronics", stockId: "9001", industry: "電子", framework: "berkshire", inputs: completeInputs(), eligible: true },
  { category: "financial", stockId: "9002", industry: "金融", framework: "jpmorgan", inputs: completeInputs(), eligible: true },
  { category: "shipping", stockId: "9003", industry: "航運", framework: "bridgewater", inputs: completeInputs(), eligible: true },
  { category: "biotech", stockId: "9004", industry: "生技", framework: "morgan_stanley", inputs: completeInputs(), eligible: true },
  { category: "traditional", stockId: "9005", industry: "傳產", framework: "industry", inputs: completeInputs(), eligible: true },
  { category: "etf", stockId: "00900", industry: "ETF", framework: "vanguard", inputs: etfInputs(), eligible: true },
  { category: "insufficient", stockId: "9007", industry: "新上市", framework: "berkshire", inputs: [{ dataset: "TaiwanStockPrice", rows: prices.slice(-10) }], eligible: false, retrievedAt: "2027-05-19T00:00:00.000Z" },
] as const;

let eligiblePasses = 0;
let evidencePasses = 0;
let staleWarningPasses = 0;
let maxMetricDeviation = 0;
for (const testCase of cases) {
  const snapshot = buildStockSnapshot(
    testCase.stockId,
    [...testCase.inputs],
    { companyName: `EVAL_ONLY_${testCase.category}`, market: "TEST", industry: testCase.industry },
    "retrievedAt" in testCase ? testCase.retrievedAt : "2026-05-19T00:00:00.000Z",
  );
  assert.equal(snapshot.quality.isMock, false);
  const eligibility = evaluateFrameworkEligibility(snapshot, testCase.framework);
  assert.equal(eligibility.eligible, testCase.eligible, `${testCase.category} eligibility mismatch`);
  eligiblePasses++;

  if (testCase.eligible) {
    const report = validateEvidenceReport([
      `最新收盤價為 ${snapshot.metrics.latest_close.display} 元 [[metric:latest_close]]`,
      `RSI14 為 ${snapshot.metrics.rsi14.display} [[metric:rsi14]]`,
    ].join("\n"), snapshot);
    assert.equal(report.summary.coverage, 1);
    assert.equal(report.summary.redactedLines, 0);
    evidencePasses++;
  } else {
    assert.ok(eligibility.missingDatasets.length > 0 || eligibility.missingMetrics.length > 0 || eligibility.staleDatasets.length > 0);
    assert.ok(snapshot.quality.staleDatasets.includes("TaiwanStockPrice"));
    staleWarningPasses++;
  }

  if (testCase.inputs.length > 3) {
    const expected = { latest_close: 229.5, monthly_revenue_yoy: 20, net_income_ttm: 52, eps_ttm: 5.2, free_cash_flow_ttm: 60, gross_margin: 50, rsi14: 100 };
    for (const [metric, value] of Object.entries(expected)) {
      const deviation = Math.abs(snapshot.metrics[metric].value - value);
      maxMetricDeviation = Math.max(maxMetricDeviation, deviation);
      assert.ok(deviation < 1e-9, `${testCase.category}:${metric} deviation=${deviation}`);
    }
  }
}

const referenceSnapshot = buildStockSnapshot("9999", completeInputs(), {}, "2026-05-19T00:00:00.000Z");
const beforeEligibility = JSON.stringify(referenceSnapshot);
for (const frameworkId of Object.keys(FRAMEWORK_CONTRACTS)) {
  const eligibility = evaluateFrameworkEligibility(referenceSnapshot, frameworkId);
  assert.equal(eligibility.eligible, true, `${frameworkId} contract should accept the complete fixture`);
  assert.ok(eligibility.limitations.length > 0, `${frameworkId} must declare known data limitations`);
}
assert.equal(JSON.stringify(referenceSnapshot), beforeEligibility, "framework eligibility must not mutate the shared snapshot");
const negativeControl = validateEvidenceReport("無證據目標價為 999 元", referenceSnapshot);
assert.equal(negativeControl.summary.redactedLines, 1);
assert.doesNotMatch(negativeControl.markdown, /999/);

console.log("ai-evaluation:", JSON.stringify({
  cases: cases.length,
  eligibilityPassRate: eligiblePasses / cases.length,
  evidenceCoveragePassRate: evidencePasses / cases.filter((item) => item.eligible).length,
  staleWarningPassRate: staleWarningPasses,
  maxMetricDeviation,
  unsupportedNumericRedaction: true,
  sharedSnapshotMutation: false,
}));

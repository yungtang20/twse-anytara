import type { SnapshotDatasetInput, SnapshotRow } from "./stockSnapshot";

export const FINANCIAL_DATASETS = [
  "TaiwanStockFinancialStatements",
  "TaiwanStockBalanceSheet",
  "TaiwanStockCashFlowsStatement",
  "TaiwanStockMonthRevenue",
  "TaiwanStockPER",
  "TaiwanStockDividend",
] as const;

export type FinancialPeriodBasis = "single-quarter" | "ytd-cumulative" | "point-in-time" | "ttm";
export type NormalizedFinancialMetricId =
  | "revenue" | "grossProfit" | "operatingIncome" | "netIncome" | "eps"
  | "operatingCashFlow" | "capitalExpenditure" | "freeCashFlow"
  | "currentAssets" | "currentLiabilities" | "liabilities" | "equity" | "cash"
  | "grossMargin" | "operatingMargin" | "netMargin"
  | "currentRatio" | "debtRatio" | "debtToEquity" | "cashRatio";

export interface FinancialSourceRef {
  dataset: string;
  type: string;
  originName: string;
  reportDate: string;
  rawValue: number;
  periodBasis: FinancialPeriodBasis;
}

export interface NormalizedFinancialValue {
  value: number | null;
  formula: string;
  periodBasis: FinancialPeriodBasis;
  stale: boolean;
  missingReason: string | null;
  sources: FinancialSourceRef[];
}

export interface NormalizedFinancialQuarter {
  date: string;
  label: string;
  metrics: Record<NormalizedFinancialMetricId, NormalizedFinancialValue>;
}

export interface NormalizedFinancialSnapshot {
  asOf: string | null;
  fetchedAt: string;
  source: "FinMind";
  stale: boolean;
  missingDatasets: string[];
  isFinancialIndustry: boolean;
  industryReason: string | null;
  periodPolicies: {
    incomeStatement: FinancialPeriodBasis;
    cashFlowStatement: FinancialPeriodBasis;
    balanceSheet: "point-in-time";
  };
  quarters: NormalizedFinancialQuarter[];
  ttm: Record<"revenue" | "netIncome" | "eps" | "operatingCashFlow" | "freeCashFlow" | "roe", NormalizedFinancialValue>;
}

interface MetricDefinition {
  dataset: string;
  candidates: Array<{ type: string; originPatterns?: string[] }>;
}

interface SelectedRaw {
  date: string;
  type: string;
  originName: string;
  value: number;
  dataset: string;
  row: SnapshotRow;
}

const INCOME = "TaiwanStockFinancialStatements";
const BALANCE = "TaiwanStockBalanceSheet";
const CASH_FLOW = "TaiwanStockCashFlowsStatement";
const DEFINITIONS: Record<Exclude<NormalizedFinancialMetricId, "freeCashFlow" | "grossMargin" | "operatingMargin" | "netMargin" | "currentRatio" | "debtRatio" | "debtToEquity" | "cashRatio">, MetricDefinition> = {
  revenue: { dataset: INCOME, candidates: [{ type: "Revenue", originPatterns: ["營業收入", "收入合計"] }] },
  grossProfit: { dataset: INCOME, candidates: [{ type: "GrossProfit", originPatterns: ["營業毛利"] }] },
  operatingIncome: { dataset: INCOME, candidates: [{ type: "OperatingIncome", originPatterns: ["營業利益"] }] },
  netIncome: { dataset: INCOME, candidates: [
    { type: "IncomeAfterTaxes", originPatterns: ["本期淨利", "稅後淨利"] },
    { type: "IncomeFromContinuingOperations", originPatterns: ["繼續營業單位本期淨利"] },
  ] },
  eps: { dataset: INCOME, candidates: [{ type: "EPS", originPatterns: ["基本每股盈餘", "每股盈餘"] }] },
  operatingCashFlow: { dataset: CASH_FLOW, candidates: [
    { type: "CashFlowsFromOperatingActivities", originPatterns: ["營業活動之淨現金流入"] },
    { type: "NetCashInflowFromOperatingActivities", originPatterns: ["營業活動之淨現金流入"] },
  ] },
  capitalExpenditure: { dataset: CASH_FLOW, candidates: [
    { type: "PropertyAndPlantAndEquipment", originPatterns: ["取得不動產", "購置不動產"] },
  ] },
  currentAssets: { dataset: BALANCE, candidates: [{ type: "CurrentAssets", originPatterns: ["流動資產"] }] },
  currentLiabilities: { dataset: BALANCE, candidates: [{ type: "CurrentLiabilities", originPatterns: ["流動負債"] }] },
  liabilities: { dataset: BALANCE, candidates: [{ type: "Liabilities", originPatterns: ["負債總額", "負債合計"] }] },
  equity: { dataset: BALANCE, candidates: [{ type: "Equity", originPatterns: ["權益總額", "權益合計"] }] },
  cash: { dataset: BALANCE, candidates: [{ type: "CashAndCashEquivalents", originPatterns: ["現金及約當現金"] }] },
};

function numeric(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = Number(value.replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function validDate(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function originRank(originName: string, patterns: string[] = []): number {
  const index = patterns.findIndex((pattern) => originName.includes(pattern));
  return index < 0 ? patterns.length : index;
}

function selectMetric(inputs: SnapshotDatasetInput[], definition: MetricDefinition): Map<string, SelectedRaw> {
  const input = inputs.find((item) => item.dataset === definition.dataset);
  const candidates: Array<SelectedRaw & { candidateRank: number; originRank: number }> = [];
  for (const row of input?.rows || []) {
    if (!validDate(row.date)) continue;
    const value = numeric(row.value);
    const candidateRank = definition.candidates.findIndex((candidate) => candidate.type === row.type);
    if (value == null || candidateRank < 0) continue;
    const originName = typeof row.origin_name === "string" ? row.origin_name : "";
    candidates.push({
      date: row.date, type: String(row.type), originName, value,
      dataset: definition.dataset, row, candidateRank,
      originRank: originRank(originName, definition.candidates[candidateRank].originPatterns),
    });
  }
  candidates.sort((a, b) => a.date.localeCompare(b.date)
    || a.candidateRank - b.candidateRank
    || a.originRank - b.originRank
    || Math.abs(b.value) - Math.abs(a.value)
    || a.originName.localeCompare(b.originName));
  const selected = new Map<string, SelectedRaw>();
  for (const candidate of candidates) if (!selected.has(candidate.date)) selected.set(candidate.date, candidate);
  return selected;
}

function declaredBasis(rows: SnapshotRow[]): FinancialPeriodBasis | null {
  for (const row of rows) {
    const marker = String(row.period_type ?? row.periodType ?? row.period ?? row.is_cumulative ?? row.isCumulative ?? "").toLowerCase();
    const originName = String(row.origin_name || "");
    if (/ytd|cumulative|累計|true/.test(marker) || originName.includes("累計")) return "ytd-cumulative";
    if (/quarter|single|單季|false/.test(marker)) return "single-quarter";
  }
  return null;
}

export function detectStatementBasis(dataset: string, rows: SnapshotRow[]): FinancialPeriodBasis {
  const declared = declaredBasis(rows);
  if (declared) return declared;
  // FinMind v4 rows do not currently expose a period flag. Comparison with
  // published quarterly reports verifies income rows as single-quarter and
  // cash-flow rows as fiscal-year-to-date; balance-sheet rows are period-end stocks.
  if (dataset === CASH_FLOW) return "ytd-cumulative";
  if (dataset === BALANCE) return "point-in-time";
  return "single-quarter";
}

function quarterIndex(date: string): number {
  return Number(date.slice(0, 4)) * 4 + Math.ceil(Number(date.slice(5, 7)) / 3) - 1;
}

function quarterLabel(date: string): string {
  return `${date.slice(0, 4)} Q${Math.ceil(Number(date.slice(5, 7)) / 3)}`;
}

function sourceRef(raw: SelectedRaw, basis: FinancialPeriodBasis): FinancialSourceRef {
  return { dataset: raw.dataset, type: raw.type, originName: raw.originName, reportDate: raw.date, rawValue: raw.value, periodBasis: basis };
}

function missing(formula: string, basis: FinancialPeriodBasis, reason: string, sources: FinancialSourceRef[] = []): NormalizedFinancialValue {
  return { value: null, formula, periodBasis: basis, stale: false, missingReason: reason, sources };
}

function datasetStale(input: SnapshotDatasetInput | undefined, fetchedAt: string): boolean {
  const dates = (input?.rows || []).map((row) => validDate(row.date) ? row.date : null).filter((date): date is string => Boolean(date)).sort();
  const asOf = dates.at(-1);
  if (!asOf) return false;
  return new Date(fetchedAt).getTime() - new Date(`${asOf}T23:59:59+08:00`).getTime() > 150 * 86_400_000;
}

function normalizeSelected(selected: Map<string, SelectedRaw>, basis: FinancialPeriodBasis, stale: boolean): Map<string, NormalizedFinancialValue> {
  const result = new Map<string, NormalizedFinancialValue>();
  const byQuarter = new Map([...selected.values()].map((raw) => [quarterIndex(raw.date), raw]));
  for (const raw of selected.values()) {
    const currentRef = sourceRef(raw, basis);
    if (basis !== "ytd-cumulative" || Math.ceil(Number(raw.date.slice(5, 7)) / 3) === 1) {
      result.set(raw.date, { value: raw.value, formula: basis === "ytd-cumulative" ? "Q1 = Q1 YTD" : "FinMind reported single quarter", periodBasis: "single-quarter", stale, missingReason: null, sources: [currentRef] });
      continue;
    }
    const previous = byQuarter.get(quarterIndex(raw.date) - 1);
    if (!previous || previous.date.slice(0, 4) !== raw.date.slice(0, 4)) {
      result.set(raw.date, missing("single quarter = current YTD - previous-quarter YTD", "single-quarter", "missing_previous_cumulative_quarter", [currentRef]));
      continue;
    }
    result.set(raw.date, {
      value: raw.value - previous.value,
      formula: "single quarter = current YTD - previous-quarter YTD",
      periodBasis: "single-quarter", stale,
      missingReason: null, sources: [currentRef, sourceRef(previous, basis)],
    });
  }
  return result;
}

function pointInTime(selected: Map<string, SelectedRaw>, stale: boolean): Map<string, NormalizedFinancialValue> {
  return new Map([...selected].map(([date, raw]) => [date, {
    value: raw.value, formula: "FinMind period-end balance (no quarter subtraction)",
    periodBasis: "point-in-time" as const, stale, missingReason: null,
    sources: [sourceRef(raw, "point-in-time")],
  }]));
}

function derived(
  formula: string,
  inputs: NormalizedFinancialValue[],
  calculate: (values: number[]) => number | null,
  reason = "missing_input",
  periodBasis: FinancialPeriodBasis = "single-quarter",
): NormalizedFinancialValue {
  if (inputs.some((input) => input.value == null)) return missing(formula, periodBasis, reason, inputs.flatMap((input) => input.sources));
  const value = calculate(inputs.map((input) => input.value as number));
  return { value, formula, periodBasis, stale: inputs.some((input) => input.stale), missingReason: value == null ? "invalid_denominator" : null, sources: inputs.flatMap((input) => input.sources) };
}

function notApplicable(formula: string, basis: FinancialPeriodBasis = "single-quarter"): NormalizedFinancialValue {
  return missing(formula, basis, "not_applicable_financial_industry");
}

function valueAt(series: Map<string, NormalizedFinancialValue>, date: string, name: string, basis: FinancialPeriodBasis = "single-quarter"): NormalizedFinancialValue {
  return series.get(date) || missing(name, basis, "missing_source_value");
}

function isFinancialIndustry(stockId: string, identity: { companyName?: string | null; industry?: string | null }): { value: boolean; reason: string | null } {
  const text = `${identity.industry || ""} ${identity.companyName || ""}`;
  const match = text.match(/金融|金控|銀行|證券|保險|票券|金\s*$/);
  if (match) return { value: true, reason: `matched:${match[0].trim()}` };
  return /^28\d{2}$/.test(stockId)
    ? { value: true, reason: "matched:TWSE financial stock-id range" }
    : { value: false, reason: null };
}

function sumTtm(quarters: NormalizedFinancialQuarter[], key: NormalizedFinancialMetricId): NormalizedFinancialValue {
  const tail = quarters.slice(-4);
  const formula = `TTM = sum(last 4 single-quarter ${key})`;
  if (tail.length !== 4 || tail.some((quarter, index) => index > 0 && quarterIndex(quarter.date) !== quarterIndex(tail[index - 1].date) + 1)) {
    return missing(formula, "ttm", "insufficient_consecutive_quarters");
  }
  const values = tail.map((quarter) => quarter.metrics[key]);
  if (values.some((value) => value.value == null)) return missing(formula, "ttm", "missing_quarter_for_ttm", values.flatMap((value) => value.sources));
  return { value: values.reduce((sum, item) => sum + (item.value as number), 0), formula, periodBasis: "ttm", stale: values.some((item) => item.stale), missingReason: null, sources: values.flatMap((item) => item.sources) };
}

function calculateRoe(quarters: NormalizedFinancialQuarter[], netIncomeTtm: NormalizedFinancialValue): NormalizedFinancialValue {
  const formula = "ROE TTM = net income TTM / average(beginning equity, ending equity) × 100";
  if (quarters.length < 5 || netIncomeTtm.value == null) return missing(formula, "ttm", "insufficient_equity_history", netIncomeTtm.sources);
  const beginning = quarters[quarters.length - 5].metrics.equity;
  const ending = quarters.at(-1)!.metrics.equity;
  return derived(
    formula,
    [netIncomeTtm, beginning, ending],
    ([income, start, end]) => (start + end) === 0 ? null : income / ((start + end) / 2) * 100,
    "missing_input",
    "ttm",
  );
}

export function normalizeFinancialSnapshot(
  stockId: string,
  inputs: SnapshotDatasetInput[],
  identity: { companyName?: string | null; industry?: string | null } = {},
  fetchedAt = new Date().toISOString(),
): NormalizedFinancialSnapshot {
  const incomeInput = inputs.find((item) => item.dataset === INCOME);
  const balanceInput = inputs.find((item) => item.dataset === BALANCE);
  const cashInput = inputs.find((item) => item.dataset === CASH_FLOW);
  const incomeBasis = detectStatementBasis(INCOME, incomeInput?.rows || []);
  const cashBasis = detectStatementBasis(CASH_FLOW, cashInput?.rows || []);
  const selected = Object.fromEntries(Object.entries(DEFINITIONS).map(([key, definition]) => [key, selectMetric(inputs, definition)])) as Record<keyof typeof DEFINITIONS, Map<string, SelectedRaw>>;
  const incomeStale = datasetStale(incomeInput, fetchedAt);
  const cashStale = datasetStale(cashInput, fetchedAt);
  const balanceStale = datasetStale(balanceInput, fetchedAt);
  const normalized = {
    revenue: normalizeSelected(selected.revenue, incomeBasis, incomeStale),
    grossProfit: normalizeSelected(selected.grossProfit, incomeBasis, incomeStale),
    operatingIncome: normalizeSelected(selected.operatingIncome, incomeBasis, incomeStale),
    netIncome: normalizeSelected(selected.netIncome, incomeBasis, incomeStale),
    eps: normalizeSelected(selected.eps, incomeBasis, incomeStale),
    operatingCashFlow: normalizeSelected(selected.operatingCashFlow, cashBasis, cashStale),
    capitalExpenditure: normalizeSelected(selected.capitalExpenditure, cashBasis, cashStale),
    currentAssets: pointInTime(selected.currentAssets, balanceStale),
    currentLiabilities: pointInTime(selected.currentLiabilities, balanceStale),
    liabilities: pointInTime(selected.liabilities, balanceStale),
    equity: pointInTime(selected.equity, balanceStale),
    cash: pointInTime(selected.cash, balanceStale),
  };
  const dates = [...new Set(Object.values(selected).flatMap((series) => [...series.keys()]))].sort().slice(-16);
  const financial = isFinancialIndustry(stockId, identity);
  const quarters = dates.map((date): NormalizedFinancialQuarter => {
    const revenue = valueAt(normalized.revenue, date, "Revenue");
    const grossProfit = valueAt(normalized.grossProfit, date, "GrossProfit");
    const operatingIncome = valueAt(normalized.operatingIncome, date, "OperatingIncome");
    const netIncome = valueAt(normalized.netIncome, date, "IncomeAfterTaxes");
    const cfo = valueAt(normalized.operatingCashFlow, date, "OperatingCashFlow");
    const rawCapex = valueAt(normalized.capitalExpenditure, date, "CapitalExpenditure");
    const capex = rawCapex.value == null ? rawCapex : { ...rawCapex, value: Math.abs(rawCapex.value), formula: `normalized CapEx outflow = abs(${rawCapex.formula})` };
    const fcf = financial.value ? notApplicable("FCF is not applied to financial institutions") : derived("FCF = OperatingCashFlow - abs(CapitalExpenditure)", [cfo, capex], ([operating, investment]) => operating - investment);
    const currentAssets = valueAt(normalized.currentAssets, date, "CurrentAssets", "point-in-time");
    const currentLiabilities = valueAt(normalized.currentLiabilities, date, "CurrentLiabilities", "point-in-time");
    const liabilities = valueAt(normalized.liabilities, date, "Liabilities", "point-in-time");
    const equity = valueAt(normalized.equity, date, "Equity", "point-in-time");
    const cash = valueAt(normalized.cash, date, "CashAndCashEquivalents", "point-in-time");
    const ratio = (
      formula: string,
      numerator: NormalizedFinancialValue,
      denominator: NormalizedFinancialValue,
      basis: FinancialPeriodBasis = "single-quarter",
    ) => derived(formula, [numerator, denominator], ([a, b]) => b === 0 ? null : a / b * 100, "missing_input", basis);
    return { date, label: quarterLabel(date), metrics: {
      revenue, grossProfit, operatingIncome, netIncome, eps: valueAt(normalized.eps, date, "EPS"),
      operatingCashFlow: cfo, capitalExpenditure: capex, freeCashFlow: fcf,
      currentAssets, currentLiabilities, liabilities, equity, cash,
      grossMargin: financial.value ? notApplicable("gross margin is not meaningful for financial institutions") : ratio("GrossProfit / Revenue × 100", grossProfit, revenue),
      operatingMargin: ratio("OperatingIncome / Revenue × 100", operatingIncome, revenue),
      netMargin: ratio("NetIncome / Revenue × 100", netIncome, revenue),
      currentRatio: financial.value ? notApplicable("current ratio is not applied to financial institutions", "point-in-time") : ratio("CurrentAssets / CurrentLiabilities × 100", currentAssets, currentLiabilities, "point-in-time"),
      debtRatio: financial.value ? notApplicable("traditional debt ratio is not applied to financial institutions", "point-in-time") : derived("Liabilities / (Liabilities + Equity) × 100", [liabilities, equity], ([debt, capital]) => debt + capital === 0 ? null : debt / (debt + capital) * 100, "missing_input", "point-in-time"),
      debtToEquity: financial.value ? notApplicable("traditional debt-to-equity interpretation is not applied to financial institutions", "point-in-time") : ratio("Liabilities / Equity × 100", liabilities, equity, "point-in-time"),
      cashRatio: financial.value ? notApplicable("cash ratio is not applied to financial institutions", "point-in-time") : ratio("CashAndCashEquivalents / CurrentLiabilities × 100", cash, currentLiabilities, "point-in-time"),
    } };
  });
  const netIncomeTtm = sumTtm(quarters, "netIncome");
  const missingDatasets = FINANCIAL_DATASETS.filter((dataset) => !inputs.find((input) => input.dataset === dataset)?.rows.length);
  return {
    asOf: quarters.at(-1)?.date || null, fetchedAt, source: "FinMind",
    stale: quarters.some((quarter) => Object.values(quarter.metrics).some((metric) => metric.stale)),
    missingDatasets, isFinancialIndustry: financial.value, industryReason: financial.reason,
    periodPolicies: { incomeStatement: incomeBasis, cashFlowStatement: cashBasis, balanceSheet: "point-in-time" },
    quarters,
    ttm: {
      revenue: sumTtm(quarters, "revenue"), netIncome: netIncomeTtm, eps: sumTtm(quarters, "eps"),
      operatingCashFlow: sumTtm(quarters, "operatingCashFlow"), freeCashFlow: financial.value ? notApplicable("FCF TTM is not applied to financial institutions", "ttm") : sumTtm(quarters, "freeCashFlow"),
      roe: calculateRoe(quarters, netIncomeTtm),
    },
  };
}

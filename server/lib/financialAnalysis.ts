import type {
  FinancialPeriodBasis,
  FinancialSourceRef,
  NormalizedFinancialQuarter,
  NormalizedFinancialValue,
} from "./financialNormalization";
import type { StockSnapshot } from "./stockSnapshot";

export type FinancialTabId = "operations" | "profitability" | "health";
export type FinancialMetricQuality = "good" | "stale" | "partial" | "no_data" | "not_applicable";

export interface FinancialKpi {
  id: string;
  label: string;
  value: number | null;
  display: string;
  unit: string;
  period: string;
  source: string;
  quality: FinancialMetricQuality;
  formula: string;
  dataset: string;
  type: string;
  originName: string;
  reportDate: string;
  periodBasis: FinancialPeriodBasis;
  stale: boolean;
  missingReason: string | null;
  lineage: FinancialSourceRef[];
}

export interface FinancialTrendPoint {
  period: string;
  date: string;
  revenue: number | null;
  netIncome: number | null;
  operatingCashFlow: number | null;
  freeCashFlow: number | null;
  grossMargin: number | null;
  operatingMargin: number | null;
  netMargin: number | null;
  eps: number | null;
  equity: number | null;
  currentRatio: number | null;
  debtRatio: number | null;
  debtToEquity: number | null;
  cashRatio: number | null;
}

export interface FinancialTabAnalysis {
  id: FinancialTabId;
  kpis: FinancialKpi[];
  trend: FinancialTrendPoint[];
  summaries: string[];
  period: string;
  sources: string[];
  quality: FinancialMetricQuality;
}

export interface CompanyFinancialAnalysis {
  stockId: string;
  companyName: string | null;
  asOf: string | null;
  retrievedAt: string;
  fetchedAt: string;
  source: "FinMind";
  stale: boolean;
  missingDatasets: string[];
  isFinancialIndustry: boolean;
  periodPolicies: StockSnapshot["financials"]["periodPolicies"];
  tabs: Record<FinancialTabId, FinancialTabAnalysis>;
  quality: StockSnapshot["quality"] & { status: FinancialMetricQuality };
}

function inBillions(value: number | null): number | null {
  return value == null ? null : value / 100_000_000;
}

function format(value: number | null, unit: string, reason: string | null): string {
  if (value == null) return reason === "not_applicable_financial_industry" ? "N/A" : "無資料";
  if (unit === "億元") return value.toLocaleString("zh-TW", { maximumFractionDigits: 1 });
  if (unit === "元") return value.toFixed(2);
  return `${value.toFixed(2)}${unit === "%" ? "%" : ""}`;
}

function quality(metric: NormalizedFinancialValue): FinancialMetricQuality {
  if (metric.missingReason === "not_applicable_financial_industry") return "not_applicable";
  if (metric.value == null) return "no_data";
  return metric.stale ? "stale" : "good";
}

function sourceSummary(lineage: FinancialSourceRef[]): string {
  const datasets = [...new Set(lineage.map((item) => item.dataset))];
  return datasets.length ? `FinMind · ${datasets.join(" + ")}` : "FinMind";
}

function kpi(id: string, label: string, metric: NormalizedFinancialValue, unit: string, period: string): FinancialKpi {
  const reportDate = metric.sources.map((item) => item.reportDate).sort().at(-1) || "無資料";
  const adjustedValue = unit === "億元" ? inBillions(metric.value) : metric.value;
  return {
    id, label, value: adjustedValue, display: format(adjustedValue, unit, metric.missingReason), unit, period,
    source: sourceSummary(metric.sources), quality: quality(metric), formula: metric.formula,
    dataset: [...new Set(metric.sources.map((item) => item.dataset))].join(" + ") || "無資料",
    type: [...new Set(metric.sources.map((item) => item.type))].join(" + ") || "無資料",
    originName: [...new Set(metric.sources.map((item) => item.originName).filter(Boolean))].join(" + ") || "無資料",
    reportDate, periodBasis: metric.periodBasis,
    stale: metric.stale, missingReason: metric.missingReason, lineage: metric.sources,
  };
}

function derivedChange(current: NormalizedFinancialValue, previous: NormalizedFinancialValue | undefined, formula: string): NormalizedFinancialValue {
  const sources = [...current.sources, ...(previous?.sources || [])];
  if (current.value == null || previous?.value == null || previous.value === 0) {
    return { value: null, formula, periodBasis: "single-quarter", stale: current.stale || Boolean(previous?.stale), missingReason: "missing_comparison_quarter", sources };
  }
  return { value: (current.value / previous.value - 1) * 100, formula, periodBasis: "single-quarter", stale: current.stale || previous.stale, missingReason: null, sources };
}

function trendPoint(quarter: NormalizedFinancialQuarter): FinancialTrendPoint {
  const metric = quarter.metrics;
  return {
    period: quarter.label, date: quarter.date,
    revenue: inBillions(metric.revenue.value), netIncome: inBillions(metric.netIncome.value),
    operatingCashFlow: inBillions(metric.operatingCashFlow.value), freeCashFlow: inBillions(metric.freeCashFlow.value),
    grossMargin: metric.grossMargin.value, operatingMargin: metric.operatingMargin.value,
    netMargin: metric.netMargin.value, eps: metric.eps.value, equity: inBillions(metric.equity.value),
    currentRatio: metric.currentRatio.value, debtRatio: metric.debtRatio.value,
    debtToEquity: metric.debtToEquity.value, cashRatio: metric.cashRatio.value,
  };
}

function tabQuality(kpis: FinancialKpi[]): FinancialMetricQuality {
  const applicable = kpis.filter((item) => item.quality !== "not_applicable");
  if (!applicable.length) return "not_applicable";
  if (applicable.every((item) => item.quality === "no_data")) return "no_data";
  if (applicable.some((item) => item.quality === "stale")) return "stale";
  return applicable.some((item) => item.quality !== "good") ? "partial" : "good";
}

function summary(item: FinancialKpi, direction?: number | null): string {
  if (item.value == null) return `${item.label}：${item.display}${item.missingReason ? `（${item.missingReason}）` : ""}。`;
  const movement = direction == null ? "" : direction > 0 ? "，較去年同期上升" : direction < 0 ? "，較去年同期下降" : "，與去年同期持平";
  const suffix = item.unit === "%" ? "" : item.unit;
  return `${item.label}為 ${item.display}${suffix}${movement}。`;
}

function buildTabs(snapshot: StockSnapshot, trend: FinancialTrendPoint[], period: string): Record<FinancialTabId, FinancialTabAnalysis> {
  const financials = snapshot.financials;
  const latest = financials.quarters.at(-1);
  const yearAgo = financials.quarters.at(-5);
  const label = latest?.label || "無資料";
  const empty = (name: string) => ({ value: null, formula: name, periodBasis: "single-quarter" as const, stale: false, missingReason: "missing_source_value", sources: [] });
  const metric = latest?.metrics;
  const revenueYoy = derivedChange(metric?.revenue || empty("Revenue"), yearAgo?.metrics.revenue, "(latest quarter revenue / same quarter last year revenue - 1) × 100");
  const operationsKpis = financials.isFinancialIndustry
    ? [kpi("net_income", "單季淨利", metric?.netIncome || empty("NetIncome"), "億元", label), kpi("eps", "單季 EPS", metric?.eps || empty("EPS"), "元", label), kpi("net_income_ttm", "近四季淨利", financials.ttm.netIncome, "億元", "TTM"), kpi("roe_ttm", "近四季 ROE", financials.ttm.roe, "%", "TTM")]
    : [kpi("revenue", "單季營收", metric?.revenue || empty("Revenue"), "億元", label), kpi("revenue_yoy", "營收年增率", revenueYoy, "%", label), kpi("operating_cash_flow", "單季營業現金流", metric?.operatingCashFlow || empty("OperatingCashFlow"), "億元", label), kpi("free_cash_flow", "單季自由現金流", metric?.freeCashFlow || empty("FreeCashFlow"), "億元", label), kpi("revenue_ttm", "近四季營收", financials.ttm.revenue, "億元", "TTM")];
  const profitabilityKpis = financials.isFinancialIndustry
    ? [kpi("eps", "單季 EPS", metric?.eps || empty("EPS"), "元", label), kpi("eps_ttm", "近四季 EPS", financials.ttm.eps, "元", "TTM"), kpi("net_income_ttm", "近四季淨利", financials.ttm.netIncome, "億元", "TTM"), kpi("roe_ttm", "近四季 ROE", financials.ttm.roe, "%", "TTM"), kpi("gross_margin", "毛利率", metric?.grossMargin || empty("GrossMargin"), "%", label)]
    : [kpi("gross_margin", "毛利率", metric?.grossMargin || empty("GrossMargin"), "%", label), kpi("operating_margin", "營業利益率", metric?.operatingMargin || empty("OperatingMargin"), "%", label), kpi("net_margin", "淨利率", metric?.netMargin || empty("NetMargin"), "%", label), kpi("eps", "單季 EPS", metric?.eps || empty("EPS"), "元", label), kpi("eps_ttm", "近四季 EPS", financials.ttm.eps, "元", "TTM")];
  const healthKpis = financials.isFinancialIndustry
    ? [kpi("equity", "期末淨值", metric?.equity || empty("Equity"), "億元", label), kpi("roe_ttm", "近四季 ROE", financials.ttm.roe, "%", "TTM"), kpi("current_ratio", "流動比率", metric?.currentRatio || empty("CurrentRatio"), "%", label), kpi("debt_ratio", "傳統負債比率", metric?.debtRatio || empty("DebtRatio"), "%", label)]
    : [kpi("current_ratio", "流動比率", metric?.currentRatio || empty("CurrentRatio"), "%", label), kpi("debt_ratio", "負債比率", metric?.debtRatio || empty("DebtRatio"), "%", label), kpi("debt_to_equity", "負債權益比", metric?.debtToEquity || empty("DebtToEquity"), "%", label), kpi("cash_ratio", "現金比率", metric?.cashRatio || empty("CashRatio"), "%", label)];
  const makeTab = (id: FinancialTabId, kpis: FinancialKpi[]): FinancialTabAnalysis => ({ id, kpis, trend, period, sources: [...new Set(kpis.map((item) => item.source))], quality: tabQuality(kpis), summaries: kpis.slice(0, 3).map((item) => summary(item)) });
  return { operations: makeTab("operations", operationsKpis), profitability: makeTab("profitability", profitabilityKpis), health: makeTab("health", healthKpis) };
}

export function buildCompanyFinancialAnalysis(snapshot: StockSnapshot, sqliteCompanyName?: string | null): CompanyFinancialAnalysis {
  const financials = snapshot.financials;
  const quarters = financials.quarters.slice(-12);
  const trend = quarters.map(trendPoint);
  const period = quarters.length ? `${quarters[0].label}–${quarters.at(-1)?.label}（最近 ${quarters.length} 季）` : "無資料";
  const tabs = buildTabs(snapshot, trend, period);
  const status = tabQuality(Object.values(tabs).flatMap((tab) => tab.kpis));
  return {
    stockId: snapshot.stockId, companyName: sqliteCompanyName || snapshot.companyName,
    asOf: financials.asOf, retrievedAt: snapshot.retrievedAt, fetchedAt: financials.fetchedAt,
    source: "FinMind", stale: financials.stale, missingDatasets: financials.missingDatasets,
    isFinancialIndustry: financials.isFinancialIndustry, periodPolicies: financials.periodPolicies,
    tabs, quality: { ...snapshot.quality, status },
  };
}

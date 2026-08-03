import { calcMA, calcMACD, calcRSI } from "../../src/lib/indicators";
import {
  normalizeFinancialSnapshot,
  type NormalizedFinancialSnapshot,
  type NormalizedFinancialValue,
} from "./financialNormalization";

export type SnapshotRow = Record<string, unknown>;
export type SnapshotSource = "finmind" | "sqlite" | "tdcc_sqlite" | "supabase" | "tdcc_supabase";

export interface SnapshotSeries {
  dataset: string;
  source: SnapshotSource;
  asOf: string | null;
  retrievedAt: string;
  rowCount: number;
  isMock: false;
  errors: string[];
  rows: SnapshotRow[];
}

export interface EvidenceRef {
  id: string;
  dataset: string;
  date: string | null;
  field: string;
  value: number | string;
  unit: string;
}

export interface DeterministicMetric {
  id: string;
  label: string;
  value: number;
  display: string;
  unit: string;
  asOf: string | null;
  formula: string;
  evidenceIds: string[];
}

export interface StockSnapshot {
  schemaVersion: 1;
  stockId: string;
  companyName: string | null;
  market: string | null;
  industry: string | null;
  asOf: string | null;
  retrievedAt: string;
  financials: NormalizedFinancialSnapshot;
  series: Record<string, SnapshotSeries>;
  metrics: Record<string, DeterministicMetric>;
  evidence: Record<string, EvidenceRef>;
  quality: {
    isMock: false;
    missingDatasets: string[];
    staleDatasets: string[];
    warnings: string[];
  };
}

export interface SnapshotDatasetInput {
  dataset: string;
  source?: SnapshotSource;
  rows: SnapshotRow[];
  error?: string;
}

const DAY_MS = 86_400_000;
// ponytail: These publication-calendar buffers avoid false stale flags without a
// market-calendar service. Upgrade to per-dataset expected-release dates if alerts
// ever need exchange-grade timeliness.
const STALE_AFTER_DAYS: Record<string, number> = {
  TaiwanStockPrice: 14,
  TaiwanStockMonthRevenue: 62,
  TaiwanStockPER: 14,
  TaiwanStockFinancialStatements: 150,
  TaiwanStockBalanceSheet: 150,
  TaiwanStockCashFlowsStatement: 150,
  TaiwanStockInstitutionalInvestorsBuySell: 14,
  TaiwanStockMarginPurchaseShortSale: 14,
  TaiwanStockShareholding: 14,
  TaiwanStockDividend: 550,
  TDCCShareholding: 14,
};

function numberValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value.replace(/,/g, ""));
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function rowDate(row: SnapshotRow): string | null {
  const date = row.date;
  return typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null;
}

function latestDate(rows: SnapshotRow[]): string | null {
  return rows.map(rowDate).filter((date): date is string => Boolean(date)).sort().at(-1) || null;
}

function evidenceId(dataset: string, date: string | null, field: string): string {
  return `${dataset}:${date || "undated"}:${field}`.replace(/[^A-Za-z0-9:._-]/g, "_");
}

function formatNumber(value: number, unit: string): string {
  if (unit === "%") return `${value.toFixed(2)}%`;
  if (unit === "TWD" || unit === "shares") return Math.round(value).toLocaleString("en-US");
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

function sampleStd(values: number[]): number | null {
  if (values.length < 2) return null;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

function pctChange(current: number | null, previous: number | null): number | null {
  if (current == null || previous == null || previous === 0) return null;
  return (current / previous - 1) * 100;
}

export function buildStockSnapshot(
  stockId: string,
  inputs: SnapshotDatasetInput[],
  identity: { companyName?: string | null; market?: string | null; industry?: string | null } = {},
  retrievedAt = new Date().toISOString(),
  normalizedFinancials?: NormalizedFinancialSnapshot,
): StockSnapshot {
  const series: Record<string, SnapshotSeries> = {};
  for (const input of inputs) {
    const rows = [...input.rows].sort((a, b) => String(a.date || "").localeCompare(String(b.date || "")));
    series[input.dataset] = {
      dataset: input.dataset,
      source: input.source || "finmind",
      asOf: latestDate(rows),
      retrievedAt,
      rowCount: rows.length,
      isMock: false,
      errors: input.error ? [input.error] : [],
      rows,
    };
  }

  const evidence: Record<string, EvidenceRef> = {};
  const metrics: Record<string, DeterministicMetric> = {};
  const addEvidence = (dataset: string, row: SnapshotRow, field: string, unit: string, valueOverride?: number | string): string | null => {
    const rawValue = valueOverride ?? row[field];
    const value = typeof rawValue === "string" ? rawValue : numberValue(rawValue);
    if (value == null) return null;
    const date = rowDate(row);
    const id = evidenceId(dataset, date, field);
    evidence[id] = { id, dataset, date, field, value, unit };
    return id;
  };
  const addMetric = (id: string, label: string, value: number | null, unit: string, asOf: string | null, formula: string, evidenceIds: Array<string | null>) => {
    if (value == null || !Number.isFinite(value)) return;
    metrics[id] = {
      id,
      label,
      value,
      display: formatNumber(value, unit),
      unit,
      asOf,
      formula,
      evidenceIds: evidenceIds.filter((evidenceId): evidenceId is string => Boolean(evidenceId)),
    };
  };
  const financials = normalizedFinancials || normalizeFinancialSnapshot(stockId, inputs, identity, retrievedAt);
  const addNormalizedMetric = (id: string, label: string, metric: NormalizedFinancialValue, unit: string, asOf: string | null) => {
    const refs = metric.sources.map((source) => {
      const evidenceKey = evidenceId(source.dataset, source.reportDate, source.type);
      evidence[evidenceKey] = {
        id: evidenceKey, dataset: source.dataset, date: source.reportDate,
        field: `${source.type}:${source.originName}`, value: source.rawValue, unit,
      };
      return evidenceKey;
    });
    addMetric(id, label, metric.value, unit, asOf, metric.formula, refs);
  };

  const priceRows = series.TaiwanStockPrice?.rows || [];
  const validPrices = priceRows.filter((row) => numberValue(row.close) != null && rowDate(row));
  const latestPrice = validPrices.at(-1);
  if (latestPrice) {
    const close = numberValue(latestPrice.close)!;
    const closeEvidence = addEvidence("TaiwanStockPrice", latestPrice, "close", "TWD");
    addMetric("latest_close", "最新收盤價", close, "TWD", rowDate(latestPrice), "close", [closeEvidence]);

    const returns: number[] = [];
    for (let index = 1; index < validPrices.length; index++) {
      const previous = numberValue(validPrices[index - 1].close)!;
      const current = numberValue(validPrices[index].close)!;
      if (previous > 0) returns.push(current / previous - 1);
    }
    const oneYearReturns = returns.slice(-252);
    const volatility = sampleStd(oneYearReturns);
    addMetric("annualized_volatility_1y", "近一年年化波動率", volatility == null ? null : volatility * Math.sqrt(252) * 100, "%", rowDate(latestPrice), "sample_std(daily_returns) * sqrt(252)", [closeEvidence]);
    if (oneYearReturns.length >= 20) {
      const sorted = [...oneYearReturns].sort((a, b) => a - b);
      const var95 = sorted[Math.max(0, Math.floor(sorted.length * 0.05) - 1)] * 100;
      addMetric("historical_var_95_1d", "歷史法一日 95% VaR", var95, "%", rowDate(latestPrice), "5th_percentile(daily_returns)", [closeEvidence]);
    }
    const oneYearPrices = validPrices.slice(-253);
    if (oneYearPrices.length >= 20) {
      let peak = -Infinity;
      let maxDrawdown = 0;
      for (const row of oneYearPrices) {
        const value = numberValue(row.close)!;
        peak = Math.max(peak, value);
        maxDrawdown = Math.min(maxDrawdown, value / peak - 1);
      }
      addMetric("max_drawdown_1y", "近一年最大回撤", maxDrawdown * 100, "%", rowDate(latestPrice), "min(close / running_peak - 1)", [closeEvidence]);
    }
    for (const [id, days, label] of [["return_1m", 21, "近一月報酬"], ["return_6m", 126, "近六月報酬"], ["return_12m", 252, "近十二月報酬"]] as const) {
      if (validPrices.length > days) {
        const baseRow = validPrices[validPrices.length - 1 - days];
        const base = numberValue(baseRow.close)!;
        const baseEvidence = addEvidence("TaiwanStockPrice", baseRow, "close", "TWD");
        addMetric(id, label, base > 0 ? (close / base - 1) * 100 : null, "%", rowDate(latestPrice), `(latest_close / close_${days}_sessions_ago - 1) * 100`, [closeEvidence, baseEvidence]);
      }
    }
    if (validPrices.length >= 15) {
      const tail = validPrices.slice(-15);
      const trueRanges = tail.slice(1).map((row, index) => Math.max(
        numberValue(row.max)! - numberValue(row.min)!,
        Math.abs(numberValue(row.max)! - numberValue(tail[index].close)!),
        Math.abs(numberValue(row.min)! - numberValue(tail[index].close)!),
      ));
      const atr14 = trueRanges.every(Number.isFinite) ? trueRanges.reduce((sum, value) => sum + value, 0) / trueRanges.length : null;
      addMetric("atr14", "ATR14", atr14, "TWD", rowDate(latestPrice), "mean(last_14_true_ranges)", [closeEvidence]);
    }
    const closes = validPrices.map((row) => numberValue(row.close)!);
    if (closes.length >= 20) {
      addMetric("ma20", "20 日移動平均", calcMA(closes, 20).at(-1) ?? null, "TWD", rowDate(latestPrice), "mean(last_20_closes)", [closeEvidence]);
    }
    if (closes.length >= 60) {
      addMetric("ma60", "60 日移動平均", calcMA(closes, 60).at(-1) ?? null, "TWD", rowDate(latestPrice), "mean(last_60_closes)", [closeEvidence]);
    }
    if (closes.length >= 20) {
      const ma20 = calcMA(closes, 20).at(-1) ?? null;
      const last20Rows = validPrices.slice(-20);
      const last20Closes = last20Rows.map((row) => numberValue(row.close)!).filter(Number.isFinite);
      const std20 = sampleStd(last20Closes);
      if (ma20 && ma20 !== 0) {
        addMetric("ma20_distance_pct", "收盤價與 MA20 乖離率", ((close - ma20) / ma20) * 100, "%", rowDate(latestPrice), "(latest_close - ma20) / ma20 * 100", [closeEvidence]);
      }
      if (std20 != null && ma20 != null) {
        const upper = ma20 + 2 * std20;
        const lower = ma20 - 2 * std20;
        addMetric("bollinger_std20", "布林帶 20 日標準差", std20, "TWD", rowDate(latestPrice), "sample_std(last_20_closes)", [closeEvidence]);
        addMetric("bollinger_upper", "布林帶上軌", upper, "TWD", rowDate(latestPrice), "ma20 + 2 * sample_std(last_20_closes)", [closeEvidence]);
        addMetric("bollinger_lower", "布林帶下軌", lower, "TWD", rowDate(latestPrice), "ma20 - 2 * sample_std(last_20_closes)", [closeEvidence]);
        addMetric("bollinger_width_pct", "布林帶寬度百分比", ma20 !== 0 ? ((upper - lower) / ma20) * 100 : null, "%", rowDate(latestPrice), "(bollinger_upper - bollinger_lower) / ma20 * 100", [closeEvidence]);
        addMetric("bollinger_position_pct", "收盤價布林帶位置", upper !== lower ? ((close - lower) / (upper - lower)) * 100 : null, "%", rowDate(latestPrice), "(latest_close - bollinger_lower) / (bollinger_upper - bollinger_lower) * 100", [closeEvidence]);
      }
      const volumes20 = last20Rows.map((row) => numberValue(row.Trading_Volume)).filter((value): value is number => value != null);
      if (volumes20.length === 20) {
        addMetric("volume20_avg", "20 日平均成交量", volumes20.reduce((sum, value) => sum + value, 0) / volumes20.length, "shares", rowDate(latestPrice), "mean(last_20_Trading_Volume)", [closeEvidence]);
      }
    }
    if (closes.length >= 60) {
      const ma60 = calcMA(closes, 60).at(-1) ?? null;
      if (ma60 && ma60 !== 0) {
        addMetric("ma60_distance_pct", "收盤價與 MA60 乖離率", ((close - ma60) / ma60) * 100, "%", rowDate(latestPrice), "(latest_close - ma60) / ma60 * 100", [closeEvidence]);
      }
    }
    if (closes.length >= 15) {
      addMetric("rsi14", "RSI14", calcRSI(closes, 14).at(-1) ?? null, "index", rowDate(latestPrice), "Wilder_RSI_14(closes)", [closeEvidence]);
    }
    if (closes.length >= 35) {
      const macd = calcMACD(closes);
      addMetric("macd_dif", "MACD DIF", macd.dif.at(-1) ?? null, "TWD", rowDate(latestPrice), "EMA12(close) - EMA26(close)", [closeEvidence]);
      addMetric("macd_signal", "MACD Signal", macd.dea.at(-1) ?? null, "TWD", rowDate(latestPrice), "EMA9(MACD_DIF)", [closeEvidence]);
      addMetric("macd_histogram", "MACD Histogram", macd.macd.at(-1) ?? null, "TWD", rowDate(latestPrice), "2 * (MACD_DIF - MACD_Signal)", [closeEvidence]);
    }
  }

  const revenueRows = series.TaiwanStockMonthRevenue?.rows || [];
  const latestRevenue = revenueRows.filter((row) => numberValue(row.revenue) != null).at(-1);
  if (latestRevenue) {
    const latestValue = numberValue(latestRevenue.revenue)!;
    const latestEvidence = addEvidence("TaiwanStockMonthRevenue", latestRevenue, "revenue", "TWD");
    addMetric("monthly_revenue", "最新月營收", latestValue, "TWD", rowDate(latestRevenue), "revenue", [latestEvidence]);
    const year = numberValue(latestRevenue.revenue_year);
    const month = numberValue(latestRevenue.revenue_month);
    const previousYear = revenueRows.find((row) => numberValue(row.revenue_year) === (year == null ? null : year - 1) && numberValue(row.revenue_month) === month);
    if (previousYear) {
      const previousValue = numberValue(previousYear.revenue)!;
      const previousEvidence = addEvidence("TaiwanStockMonthRevenue", previousYear, "revenue", "TWD");
      addMetric("monthly_revenue_yoy", "最新月營收年增率", previousValue > 0 ? (latestValue / previousValue - 1) * 100 : null, "%", rowDate(latestRevenue), "(latest_month_revenue / same_month_last_year - 1) * 100", [latestEvidence, previousEvidence]);
    }
  }

  const perRow = (series.TaiwanStockPER?.rows || []).at(-1);
  if (perRow) {
    for (const [field, id, label, unit] of [["PER", "pe", "本益比", "x"], ["PBR", "pb", "股價淨值比", "x"], ["dividend_yield", "dividend_yield", "殖利率", "%"]] as const) {
      const value = numberValue(perRow[field]);
      const ref = addEvidence("TaiwanStockPER", perRow, field, unit);
      addMetric(id, label, value, unit, rowDate(perRow), field, [ref]);
    }
  }

  const dividendRows = (series.TaiwanStockDividend?.rows || [])
    .filter((row) => numberValue(row.CashEarningsDistribution) != null && rowDate(row))
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const latestDividend = dividendRows.at(-1);
  if (latestDividend) {
    const latestCashDividend = numberValue(latestDividend.CashEarningsDistribution)!;
    const latestDividendRef = addEvidence("TaiwanStockDividend", latestDividend, "CashEarningsDistribution", "TWD/share");
    addMetric("latest_cash_dividend", "最新現金股利", latestCashDividend, "TWD/share", rowDate(latestDividend), "CashEarningsDistribution", [latestDividendRef]);
    const totalShares = numberValue(latestDividend.ParticipateDistributionOfTotalShares);
    const totalSharesRef = addEvidence("TaiwanStockDividend", latestDividend, "ParticipateDistributionOfTotalShares", "shares");
    addMetric("latest_cash_dividend_total", "最新現金股利總額", totalShares == null ? null : latestCashDividend * totalShares, "TWD", rowDate(latestDividend), "CashEarningsDistribution * ParticipateDistributionOfTotalShares", [latestDividendRef, totalSharesRef]);

    const lastFiveDividendRows = dividendRows.slice(-5);
    const lastFiveDividends = lastFiveDividendRows.map((row) => numberValue(row.CashEarningsDistribution)).filter((value): value is number => value != null);
    const lastFiveRefs = lastFiveDividendRows.map((row) => addEvidence("TaiwanStockDividend", row, "CashEarningsDistribution", "TWD/share"));
    if (lastFiveDividends.length >= 3) {
      const avg = lastFiveDividends.reduce((sum, value) => sum + value, 0) / lastFiveDividends.length;
      const std = sampleStd(lastFiveDividends);
      addMetric("cash_dividend_5y_avg", "近五年平均現金股利", avg, "TWD/share", rowDate(latestDividend), "mean(last_5_CashEarningsDistribution)", lastFiveRefs);
      addMetric("cash_dividend_5y_std", "近五年現金股利標準差", std, "TWD/share", rowDate(latestDividend), "sample_std(last_5_CashEarningsDistribution)", lastFiveRefs);
      addMetric("cash_dividend_5y_cv_pct", "近五年現金股利變異係數", std == null || avg === 0 ? null : (std / avg) * 100, "%", rowDate(latestDividend), "sample_std(last_5_CashEarningsDistribution) / mean(last_5_CashEarningsDistribution) * 100", lastFiveRefs);
      addMetric("cash_dividend_5y_change_pct", "近五年現金股利變化", pctChange(lastFiveDividends.at(-1) ?? null, lastFiveDividends.at(0) ?? null), "%", rowDate(latestDividend), "(latest_CashEarningsDistribution / first_of_last_5_CashEarningsDistribution - 1) * 100", lastFiveRefs);
    }
    const lastTenDividendRows = dividendRows.slice(-10);
    if (lastTenDividendRows.length >= 5) {
      addMetric("cash_dividend_10y_total", "近十年累計現金股利", lastTenDividendRows.reduce((sum, row) => sum + numberValue(row.CashEarningsDistribution)!, 0), "TWD/share", rowDate(latestDividend), "sum(last_10_CashEarningsDistribution)", lastTenDividendRows.map((row) => addEvidence("TaiwanStockDividend", row, "CashEarningsDistribution", "TWD/share")));
    }
  }

  const latestQuarter = financials.quarters.at(-1);
  const previousQuarter = financials.quarters.at(-2);
  const yearAgoQuarter = financials.quarters.at(-5);
  const reportDate = latestQuarter?.date || null;
  if (latestQuarter) {
    addNormalizedMetric("quarterly_revenue", "最新季營收", latestQuarter.metrics.revenue, "TWD", reportDate);
    addNormalizedMetric("quarterly_net_income", "最新季淨利", latestQuarter.metrics.netIncome, "TWD", reportDate);
    addNormalizedMetric("quarterly_eps", "最新季 EPS", latestQuarter.metrics.eps, "TWD/share", reportDate);
    addNormalizedMetric("gross_margin", "最新季毛利率", latestQuarter.metrics.grossMargin, "%", reportDate);
    addNormalizedMetric("operating_margin", "單季營業利益率", latestQuarter.metrics.operatingMargin, "%", reportDate);
    addNormalizedMetric("net_margin", "單季淨利率", latestQuarter.metrics.netMargin, "%", reportDate);
    addNormalizedMetric("liabilities_to_equity", "負債權益比", latestQuarter.metrics.debtToEquity, "%", reportDate);
  }
  const addChangeMetric = (id: string, label: string, current: NormalizedFinancialValue | undefined, previous: NormalizedFinancialValue | undefined, formula: string) => {
    const value = pctChange(current?.value ?? null, previous?.value ?? null);
    const sources = [...(current?.sources || []), ...(previous?.sources || [])];
    addNormalizedMetric(id, label, { value, formula, periodBasis: "single-quarter", stale: Boolean(current?.stale || previous?.stale), missingReason: value == null ? "missing_comparison_quarter" : null, sources }, "%", reportDate);
  };
  addChangeMetric("revenue_qoq_pct", "單季營收季增率", latestQuarter?.metrics.revenue, previousQuarter?.metrics.revenue, "(latest quarter revenue / previous quarter revenue - 1) × 100");
  addChangeMetric("revenue_yoy_pct", "單季營收年增率", latestQuarter?.metrics.revenue, yearAgoQuarter?.metrics.revenue, "(latest quarter revenue / same quarter last year revenue - 1) × 100");
  addChangeMetric("eps_qoq_pct", "單季 EPS 季增率", latestQuarter?.metrics.eps, previousQuarter?.metrics.eps, "(latest quarter EPS / previous quarter EPS - 1) × 100");
  addChangeMetric("eps_yoy_pct", "單季 EPS 年增率", latestQuarter?.metrics.eps, yearAgoQuarter?.metrics.eps, "(latest quarter EPS / same quarter last year EPS - 1) × 100");
  addNormalizedMetric("net_income_ttm", "近四季淨利", financials.ttm.netIncome, "TWD", reportDate);
  addNormalizedMetric("eps_ttm", "近四季 EPS", financials.ttm.eps, "TWD/share", reportDate);
  addNormalizedMetric("roe_ttm", "近四季 ROE", financials.ttm.roe, "%", reportDate);
  addNormalizedMetric("free_cash_flow_ttm", "近四季自由現金流", financials.ttm.freeCashFlow, "TWD", reportDate);

  const latestCashDividend = metrics.latest_cash_dividend?.value ?? null;
  const latestCashDividendTotal = metrics.latest_cash_dividend_total?.value ?? null;
  const epsTtm = metrics.eps_ttm?.value ?? null;
  const freeCashFlowTtm = metrics.free_cash_flow_ttm?.value ?? null;
  addMetric("dividend_payout_ratio_ttm", "現金股利盈餘配發率", latestCashDividend != null && epsTtm != null ? (latestCashDividend / epsTtm) * 100 : null, "%", metrics.latest_cash_dividend?.asOf ?? null, "latest_cash_dividend / eps_ttm * 100", [...(metrics.latest_cash_dividend?.evidenceIds || []), ...(metrics.eps_ttm?.evidenceIds || [])]);
  addMetric("dividend_fcf_coverage_ratio", "自由現金流覆蓋現金股利倍數", latestCashDividendTotal != null && freeCashFlowTtm != null && latestCashDividendTotal !== 0 ? freeCashFlowTtm / latestCashDividendTotal : null, "x", metrics.free_cash_flow_ttm?.asOf ?? null, "free_cash_flow_ttm / latest_cash_dividend_total", [...(metrics.free_cash_flow_ttm?.evidenceIds || []), ...(metrics.latest_cash_dividend_total?.evidenceIds || [])]);

  const tdccRows = series.TDCCShareholding?.rows || [];
  const latestTdcc = tdccRows.at(-1);
  if (latestTdcc) {
    for (const [field, id, label] of [["whale_ratio", "tdcc_whale_ratio", "大戶持股比率"], ["retail_ratio", "tdcc_retail_ratio", "散戶持股比率"]] as const) {
      addMetric(id, label, numberValue(latestTdcc[field]), "%", rowDate(latestTdcc), field, [addEvidence("TDCCShareholding", latestTdcc, field, "%")]);
    }
  }

  const allSeries = Object.values(series);
  const asOf = allSeries.map((item) => item.asOf).filter((date): date is string => Boolean(date)).sort().at(-1) || null;
  const now = new Date(retrievedAt).getTime();
  const staleDatasets = allSeries
    .filter((item) => !item.asOf || now - new Date(`${item.asOf}T23:59:59+08:00`).getTime() > (STALE_AFTER_DAYS[item.dataset] ?? 45) * DAY_MS)
    .map((item) => item.dataset);
  const missingDatasets = allSeries.filter((item) => item.rowCount === 0).map((item) => item.dataset);
  return {
    schemaVersion: 1,
    stockId,
    companyName: identity.companyName || null,
    market: identity.market || null,
    industry: identity.industry || null,
    asOf,
    retrievedAt,
    financials,
    series,
    metrics,
    evidence,
    quality: {
      isMock: false,
      missingDatasets,
      staleDatasets,
      warnings: [...missingDatasets.map((dataset) => `missing:${dataset}`), ...staleDatasets.map((dataset) => `stale:${dataset}`)],
    },
  };
}

const LONG_FORM_FIELDS: Record<string, Set<string>> = {
  TaiwanStockFinancialStatements: new Set(["Revenue", "GrossProfit", "OperatingIncome", "IncomeAfterTaxes", "EPS"]),
  TaiwanStockBalanceSheet: new Set(["CashAndCashEquivalents", "CurrentAssets", "TotalAssets", "CurrentLiabilities", "Liabilities", "Equity"]),
  TaiwanStockCashFlowsStatement: new Set(["CashFlowsFromOperatingActivities", "PropertyAndPlantAndEquipment", "Depreciation", "AmortizationExpense"]),
};

export function formatSnapshotForPrompt(
  snapshot: StockSnapshot,
  selection?: { datasets?: string[]; metrics?: string[] },
): string {
  const selectedDatasets = selection?.datasets ? new Set(selection.datasets) : null;
  const selectedMetrics = selection?.metrics ? new Set(selection.metrics) : null;
  const metrics = Object.values(snapshot.metrics)
    .filter((metric) => !selectedMetrics || selectedMetrics.has(metric.id))
    .map((metric) => ({
    citation: `metric:${metric.id}`,
    label: metric.label,
    value: metric.display,
    asOf: metric.asOf,
    formula: metric.formula,
    evidence: metric.evidenceIds,
  }));
  const sourceSummary = Object.values(snapshot.series)
    .filter(({ dataset }) => !selectedDatasets || selectedDatasets.has(dataset))
    .map(({ dataset, source, asOf, rowCount, errors }) => ({ dataset, source, asOf, rowCount, errors }));
  const excerpts: Record<string, SnapshotRow[]> = {};
  for (const [dataset, item] of Object.entries(snapshot.series)) {
    if (selectedDatasets && !selectedDatasets.has(dataset)) continue;
    const allowedTypes = LONG_FORM_FIELDS[dataset];
    const rows = allowedTypes ? item.rows.filter((row) => typeof row.type === "string" && allowedTypes.has(row.type)) : item.rows;
    const limit = dataset === "TaiwanStockPrice" ? 30 : dataset.includes("Financial") || dataset.includes("Balance") || dataset.includes("CashFlows") ? 40 : 20;
    excerpts[dataset] = rows.slice(-limit);
  }
  return [
    `# Canonical StockSnapshot v${snapshot.schemaVersion}`,
    JSON.stringify({ stockId: snapshot.stockId, companyName: snapshot.companyName, market: snapshot.market, industry: snapshot.industry, asOf: snapshot.asOf, retrievedAt: snapshot.retrievedAt, quality: snapshot.quality }),
    "## Deterministic metrics (引用格式：[[metric:<id>]])",
    JSON.stringify(metrics),
    "## Source provenance",
    JSON.stringify(sourceSummary),
    "## Bounded raw excerpts (引用格式：[[<dataset>:<date>:<field>]])",
    JSON.stringify(excerpts),
  ].join("\n");
}

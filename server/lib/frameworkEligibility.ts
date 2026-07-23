import type { StockSnapshot } from "./stockSnapshot";

export interface FrameworkContract {
  datasets: string[];
  metrics: string[];
  limitations: string[];
}

export interface FrameworkEligibility {
  eligible: boolean;
  missingDatasets: string[];
  missingMetrics: string[];
  staleDatasets: string[];
  limitations: string[];
}

const PRICE = "TaiwanStockPrice";
const FINANCIALS = "TaiwanStockFinancialStatements";
const BALANCE = "TaiwanStockBalanceSheet";
const CASH_FLOW = "TaiwanStockCashFlowsStatement";
const INSTITUTIONAL = "TaiwanStockInstitutionalInvestorsBuySell";

export const FRAMEWORK_CONTRACTS: Record<string, FrameworkContract> = {
  berkshire: {
    datasets: [PRICE, FINANCIALS, BALANCE, CASH_FLOW],
    metrics: ["latest_close", "roe_ttm", "free_cash_flow_ttm", "liabilities_to_equity", "eps_ttm", "gross_margin", "net_margin"],
    limitations: ["不提供主觀折現率或無來源 DCF 目標價"],
  },
  goldman: {
    datasets: [PRICE, FINANCIALS, BALANCE, CASH_FLOW],
    metrics: ["latest_close", "eps_ttm", "quarterly_revenue", "quarterly_eps", "revenue_qoq_pct", "revenue_yoy_pct", "eps_qoq_pct", "eps_yoy_pct", "free_cash_flow_ttm", "liabilities_to_equity"],
    limitations: ["沒有市場共識與同業估值資料時不得產出 Football Field 目標價"],
  },
  morgan_stanley: {
    datasets: [PRICE],
    metrics: [
      "ma20",
      "ma60",
      "ma20_distance_pct",
      "ma60_distance_pct",
      "bollinger_upper",
      "bollinger_lower",
      "bollinger_width_pct",
      "bollinger_position_pct",
      "volume20_avg",
      "rsi14",
      "macd_histogram",
      "atr14",
      "return_6m",
    ],
    limitations: ["沒有逐筆委託簿與券商分點資料"],
  },
  bridgewater: {
    datasets: [PRICE],
    metrics: ["return_1m", "return_6m", "return_12m", "annualized_volatility_1y", "historical_var_95_1d", "max_drawdown_1y", "atr14"],
    limitations: ["沒有無風險利率、匯率與基準指數，因此不計算 Beta 或宏觀 hedge ratio"],
  },
  jpmorgan: {
    datasets: [PRICE, "TaiwanStockMonthRevenue", FINANCIALS],
    metrics: ["monthly_revenue_yoy", "quarterly_revenue", "quarterly_eps", "revenue_qoq_pct", "revenue_yoy_pct", "eps_qoq_pct", "eps_yoy_pct", "gross_margin", "operating_margin", "net_margin", "eps_ttm"],
    limitations: ["沒有市場共識預估，不計算 earnings surprise"],
  },
  blackrock: {
    datasets: [PRICE, "TaiwanStockPER", "TaiwanStockDividend", CASH_FLOW],
    metrics: ["return_12m", "dividend_yield", "latest_cash_dividend", "latest_cash_dividend_total", "cash_dividend_5y_avg", "cash_dividend_5y_cv_pct", "cash_dividend_10y_total", "free_cash_flow_ttm", "dividend_fcf_coverage_ratio"],
    limitations: ["沒有完整基金持倉與投資人 IPS"],
  },
  citadel: {
    datasets: [PRICE, "TaiwanStockPER", INSTITUTIONAL],
    metrics: ["return_1m", "return_6m", "return_12m", "pe", "annualized_volatility_1y", "historical_var_95_1d", "max_drawdown_1y"],
    limitations: ["沒有總體、產業輪動與 ETF flow 快照"],
  },
  renaissance: {
    datasets: [PRICE, "TaiwanStockPER", INSTITUTIONAL],
    metrics: ["return_1m", "return_6m", "return_12m", "annualized_volatility_1y", "pe", "rsi14", "macd_histogram", "historical_var_95_1d"],
    limitations: ["沒有訓練資料與樣本外回測，不得宣稱模型 alpha"],
  },
  vanguard: {
    datasets: [PRICE, "TaiwanStockPER", "TaiwanStockDividend", CASH_FLOW],
    metrics: ["return_12m", "dividend_yield", "latest_cash_dividend", "cash_dividend_5y_avg", "cash_dividend_5y_cv_pct", "cash_dividend_10y_total", "free_cash_flow_ttm"],
    limitations: ["單一標的快照不能取代完整資產配置與 IPS"],
  },
  deshaw: {
    datasets: [PRICE],
    metrics: ["return_1m", "return_6m", "annualized_volatility_1y", "historical_var_95_1d", "max_drawdown_1y", "atr14", "volume20_avg"],
    limitations: ["沒有 options chain，不得產出 Delta、Gamma、Vega 或選擇權定價"],
  },
  twosigma: {
    datasets: [PRICE],
    metrics: ["return_1m", "return_6m", "return_12m", "annualized_volatility_1y", "rsi14", "macd_histogram", "historical_var_95_1d", "volume20_avg"],
    limitations: ["沒有樣本外回測，不得將技術指標描述為已驗證預測模型"],
  },
  hedge_fund: {
    datasets: [PRICE, FINANCIALS, BALANCE, CASH_FLOW],
    metrics: ["return_6m", "roe_ttm", "free_cash_flow_ttm", "liabilities_to_equity", "eps_ttm", "gross_margin", "net_margin", "historical_var_95_1d"],
    limitations: ["沒有借券成本、可放空性與催化事件資料"],
  },
  industry: {
    datasets: [PRICE, "TaiwanStockMonthRevenue", FINANCIALS],
    metrics: ["monthly_revenue_yoy", "quarterly_revenue", "quarterly_eps", "revenue_qoq_pct", "revenue_yoy_pct", "eps_qoq_pct", "eps_yoy_pct", "gross_margin", "operating_margin", "net_margin", "eps_ttm"],
    limitations: ["沒有供應商、客戶與同業結構化資料，不得生成供應鏈占比"],
  },
};

export function evaluateFrameworkEligibility(snapshot: StockSnapshot, frameworkId: string): FrameworkEligibility {
  const contract = FRAMEWORK_CONTRACTS[frameworkId] || FRAMEWORK_CONTRACTS.morgan_stanley;
  const missingDatasets = contract.datasets.filter((dataset) => !snapshot.series[dataset]?.rowCount);
  const missingMetrics = contract.metrics.filter((metric) => !snapshot.metrics[metric]);
  const staleDatasets = contract.datasets.filter((dataset) => snapshot.quality.staleDatasets.includes(dataset));
  return {
    eligible: missingDatasets.length === 0 && missingMetrics.length === 0 && staleDatasets.length === 0,
    missingDatasets,
    missingMetrics,
    staleDatasets,
    limitations: contract.limitations,
  };
}

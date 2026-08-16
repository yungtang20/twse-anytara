const CLAIM_KIND_LABELS: Readonly<Record<string, string>> = {
  company_fact: "公司資料", market_snapshot: "市場快照", financial_metric: "財務指標",
  institutional_flow: "法人動向", tdcc_concentration: "股權集中度", trade_risk: "交易風險",
  strategy_result: "策略結果", evidence_comparison: "資料比較", limitation: "資料限制",
};

const CLAIM_STANCE_LABELS: Readonly<Record<string, string>> = {
  positive: "正向", neutral: "中性", negative: "負向", insufficient: "資料不足",
};

const GROUNDING_LABELS: Readonly<Record<string, string>> = {
  "server-grounded": "事實已由伺服器資料驗證",
  "server-calculated": "數值由伺服器計算",
  "model-selected-bounded-assumptions": "模型選擇的有界假設",
  "model-estimate-unverified": "模型估計，未經外部驗證",
  unverified: "尚未完成語意發布驗證",
};

const PROVIDER_LABELS: Readonly<Record<string, string>> = {
  hcnsec: "HCNSEC", custom: "個人 AI 供應商", router: "AI 路由服務", fake: "測試服務",
  supabase: "Supabase", finmind: "FinMind", "external-estimate": "外部估算來源",
};

const DATASET_LABELS: Readonly<Record<string, string>> = {
  stock_meta: "公司基本資料", financials: "財務資料", eps: "每股盈餘資料",
  TaiwanStockFinancialStatements: "財務報表", TaiwanStockBalanceSheet: "資產負債表",
  TaiwanStockCashFlowsStatement: "現金流量表", TaiwanStockMonthRevenue: "月營收資料",
  TaiwanStockPER: "估值資料", TaiwanStockDividend: "股利資料", stock_price: "行情資料",
  stock_institutional: "法人資料", tdcc_shareholding: "TDCC 資料",
  stock_trade_risk: "交易風險資料", strategy_sr: "支撐壓力策略",
  strategy_ma: "均線策略", strategy_chips: "籌碼策略", strategy_pattern: "型態策略",
};

const INFORMATION_RICHNESS_LABELS: Readonly<Record<string, string>> = { A: "資訊豐富", B: "資訊足夠", C: "資訊有限" };
const QUALITY_STATUS_LABELS: Readonly<Record<string, string>> = { complete: "資料完整", partial: "部分資料" };

const labelFor = (labels: Readonly<Record<string, string>>, value: string, fallback: string) =>
  Object.hasOwn(labels, value) ? labels[value] : fallback;

export const informationRichnessLabel = (value: string) => labelFor(INFORMATION_RICHNESS_LABELS, value, "資訊等級未知");
export const qualityStatusLabel = (value: string) => labelFor(QUALITY_STATUS_LABELS, value, "資料狀態未知");
export const claimKindLabel = (value: string) => labelFor(CLAIM_KIND_LABELS, value, "其他研究發現");
export const claimStanceLabel = (value: string) => labelFor(CLAIM_STANCE_LABELS, value, "方向未分類");
export const groundingLabel = (value: string) => labelFor(GROUNDING_LABELS, value, "驗證狀態未知");
export const providerLabel = (value: string) => labelFor(PROVIDER_LABELS, value, "其他 AI 服務");
export const datasetLabel = (value: string) => labelFor(DATASET_LABELS, value, "其他資料來源");
export const formatDuration = (durationMs: number | null) => durationMs === null
  ? "處理時間未知" : `處理時間約 ${(durationMs / 1000).toFixed(1)} 秒`;

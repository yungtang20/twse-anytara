import { PriceData } from './indicators';
import type { ResearchContext } from '../../shared/researchContext';
import type { AIResearchReportResponse, AIResearchReportSuccessResponse } from '../../shared/aiResearchReport';
import { loadAIProviderOverride, readHcnsecPrivacyAccepted } from './aiProviderSettings';
export type { PriceData };
export type { ResearchContext } from '../../shared/researchContext';
export type { AIResearchReportSuccessResponse } from '../../shared/aiResearchReport';

// API utils for fetching data via backend proxy
// Base URL defaults to same origin; override via VITE_API_URL for production
const BASE = import.meta.env?.VITE_API_URL || '';

async function get<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { signal });
  if (!res.ok) throw new Error(`HTTP error: ${res.status}`);
  return res.json() as Promise<T>;
}

export async function fetchResearchContext(id: string, signal?: AbortSignal): Promise<ResearchContext> {
  const response = await fetch(
    `${BASE}/api/ai-research/stocks/${encodeURIComponent(id)}/context`,
    { signal },
  );
  const payload = await response.json() as {
    success: boolean;
    data?: ResearchContext;
    error?: string;
  };
  if (!response.ok || !payload.success || !payload.data) {
    throw new Error(payload.error || `HTTP error: ${response.status}`);
  }
  return payload.data;
}

export async function runAIResearch(
  stockId: string,
  signal?: AbortSignal,
): Promise<AIResearchReportSuccessResponse> {
  const response = await fetch(
    `${BASE}/api/ai-research/stocks/${encodeURIComponent(stockId)}/report`,
    { method: "POST", headers: {
      "Content-Type": "application/json",
    }, body: JSON.stringify({ provider: {
      ...loadAIProviderOverride(),
      privacyAccepted: readHcnsecPrivacyAccepted(),
    } }), signal },
  );
  const payload = await response.json() as AIResearchReportResponse;
  if (!response.ok || !payload.success) {
    throw new Error(payload.success ? `HTTP error: ${response.status}` : payload.error);
  }
  return payload;
}

export async function testAIProviderConnection(signal?: AbortSignal): Promise<{ modelCount: number }> {
  const response = await fetch(`${BASE}/api/ai-provider/test`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider: {
      ...loadAIProviderOverride(),
      privacyAccepted: readHcnsecPrivacyAccepted(),
    } }),
    signal,
  });
  const payload = await response.json() as { success: boolean; modelCount?: number; error?: string };
  if (!response.ok || !payload.success || typeof payload.modelCount !== "number") {
    throw new Error(payload.error || `HTTP error: ${response.status}`);
  }
  return { modelCount: payload.modelCount };
}

export interface DataQuality {
  source: string;
  asOf: string | null;
  isMock: boolean;
  isStale: boolean;
  warnings: string[];
}

export interface DataSeries<T> {
  data: T[];
  quality: DataQuality;
}

export type FinancialTabId = 'operations' | 'profitability' | 'health';
export type FinancialMetricQuality = 'good' | 'stale' | 'partial' | 'no_data' | 'not_applicable';

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
  periodBasis: 'single-quarter' | 'ytd-cumulative' | 'point-in-time' | 'ttm';
  stale: boolean;
  missingReason: string | null;
  lineage: Array<{
    dataset: string;
    type: string;
    originName: string;
    reportDate: string;
    rawValue: number;
    periodBasis: 'single-quarter' | 'ytd-cumulative' | 'point-in-time' | 'ttm';
  }>;
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

export interface CompanyFinancialAnalysisData {
  stockId: string;
  companyName: string | null;
  asOf: string | null;
  retrievedAt: string;
  fetchedAt: string;
  source: 'FinMind';
  stale: boolean;
  missingDatasets: string[];
  isFinancialIndustry: boolean;
  periodPolicies: {
    incomeStatement: 'single-quarter' | 'ytd-cumulative' | 'point-in-time' | 'ttm';
    cashFlowStatement: 'single-quarter' | 'ytd-cumulative' | 'point-in-time' | 'ttm';
    balanceSheet: 'point-in-time';
  };
  tabs: Record<FinancialTabId, FinancialTabAnalysis>;
  quality: {
    status: FinancialMetricQuality;
    isMock: false;
    missingDatasets: string[];
    staleDatasets: string[];
    warnings: string[];
  };
}

export async function fetchCompanyFinancialAnalysis(id: string, signal?: AbortSignal): Promise<CompanyFinancialAnalysisData> {
  const response = await fetch(`${BASE}/api/stock/${encodeURIComponent(id)}/financials`, { signal });
  const payload = await response.json() as { success: boolean; data?: CompanyFinancialAnalysisData; error?: string };
  if (!response.ok || !payload.success || !payload.data) {
    throw new Error(payload.error || `HTTP error: ${response.status}`);
  }
  return payload.data;
}

type DataEnvelope<T> = {
  success: boolean;
  data: T;
  source?: string;
  asOf?: string | null;
  isMock?: boolean;
  isStale?: boolean;
  warnings?: string[];
  dataQuality?: Partial<DataQuality>;
};

function readQuality<T>(res: DataEnvelope<T>): DataQuality {
  const quality = res.dataQuality || {};
  const source = quality.source ?? res.source;
  const asOf = quality.asOf ?? res.asOf;
  const isMock = quality.isMock ?? res.isMock;
  const isStale = quality.isStale ?? res.isStale;
  const rawWarnings = quality.warnings ?? res.warnings;
  const contractWarnings: string[] = [];
  if (typeof source !== 'string' || !source.trim()) contractWarnings.push('資料來源未驗證');
  if (asOf !== null && typeof asOf !== 'string') contractWarnings.push('資料日期格式無效');
  if (typeof isMock !== 'boolean' || typeof isStale !== 'boolean') contractWarnings.push('資料品質欄位不完整');
  if (!Array.isArray(rawWarnings) || rawWarnings.some((warning) => typeof warning !== 'string')) {
    contractWarnings.push('資料品質警告格式無效');
  }
  return {
    source: typeof source === 'string' && source.trim() ? source : 'unverified',
    asOf: asOf === null || typeof asOf === 'string' ? asOf : null,
    isMock: typeof isMock === 'boolean' ? isMock : false,
    isStale: typeof isStale === 'boolean' ? isStale : true,
    warnings: [
      ...(Array.isArray(rawWarnings) ? rawWarnings.filter((warning): warning is string => typeof warning === 'string') : []),
      ...contractWarnings,
    ],
  };
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isPriceData(value: unknown): value is PriceData {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  if (typeof row.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(row.date)) return false;
  if (![row.open, row.high, row.low, row.close, row.volume].every(isFiniteNumber)) return false;
  const { open, high, low, close, volume } = row as unknown as PriceData;
  return open > 0
    && close > 0
    && low > 0
    && high >= Math.max(open, close, low)
    && low <= Math.min(open, close, high)
    && volume >= 0;
}

function validatePriceSeries(raw: unknown, quality: DataQuality): DataSeries<PriceData> {
  if (!Array.isArray(raw)) {
    return {
      data: [],
      quality: { ...quality, isStale: true, warnings: [...quality.warnings, '行情資料格式無效'] },
    };
  }
  const data = raw.filter(isPriceData);
  const rejected = raw.length - data.length;
  return {
    data,
    quality: rejected === 0
      ? quality
      : {
          ...quality,
          isStale: true,
          warnings: [...quality.warnings, `已拒絕 ${rejected} 筆無效 OHLCV 行情`],
        },
  };
}

// ── Official TWSE/TPEX indices ─────────────────────────────

export interface IndexStats {
  success: boolean;
  index: number;
  change: number;
  changePercent: number;
  amount: number;
  limitUp: number;
  up: number;
  flat: number;
  down: number;
  limitDown: number;
  error?: string;
}

export async function fetchTwseStats(): Promise<IndexStats> {
  return get<IndexStats>('/api/twse-stats');
}

export async function fetchOtcStats(): Promise<IndexStats> {
  return get<IndexStats>('/api/otc-stats');
}

// ── Stock search ───────────────────────────────────────────

export interface StockMeta {
  stock_id: string;
  stock_name: string;
  market: string;
  industry_category?: string;
}

export async function fetchStockSearch(query: string, signal?: AbortSignal): Promise<StockMeta[]> {
  const res = await get<{ success: boolean; data: StockMeta[] }>(`/api/stock/search?q=${encodeURIComponent(query)}`, signal);
  return res.success ? res.data : [];
}

// ── Stock price history ────────────────────────────────────

export async function fetchStockHistory(id: string, days = 120, signal?: AbortSignal): Promise<DataSeries<PriceData>> {
  const res = await get<DataEnvelope<PriceData[]>>(`/api/stock/${encodeURIComponent(id)}/history?days=${days}`, signal);
  const quality = readQuality(res);
  return res.success
    ? validatePriceSeries(res.data, quality)
    : { data: [], quality: { ...quality, isStale: true, warnings: [...quality.warnings, '行情 API 回報失敗'] } };
}

// ── Stock indicators ───────────────────────────────────────

export interface StockIndicators {
  ma5: number | null;
  ma20: number | null;
  ma60: number | null;
  ma200: number | null;
  rsi: number | null;
  support: number;
  pressure: number;
}

export async function fetchStockIndicators(id: string): Promise<StockIndicators | null> {
  const res = await get<{ success: boolean; data: StockIndicators }>(`/api/stock/${id}/indicators`);
  return res.success ? res.data : null;
}

// ── Stock institutional data ───────────────────────────────

export interface InstitutionalRow {
  date: string;
  foreign_net: number;
  trust_net: number;
  dealer_net?: number;
  institutional_net?: number;
}

export async function fetchStockInstitutional(id: string, signal?: AbortSignal): Promise<DataSeries<InstitutionalRow>> {
  const res = await get<DataEnvelope<InstitutionalRow[]>>(`/api/stock/${encodeURIComponent(id)}/institutional`, signal);
  return { data: res.success ? res.data : [], quality: readQuality(res) };
}

// ── Full stock quote ───────────────────────────────────────

export interface StockQuote {
  stock_id: string;
  name: string;
  market: string;
  industry: string | null;
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  change: number;
  changePercent: number;
  prevClose: number | null;
  indicators: StockIndicators | null;
  institutional: InstitutionalRow[];
  shareholding: { date: string; whale_ratio: number; retail_ratio: number } | null;
}

export async function fetchStockQuote(id: string, signal?: AbortSignal): Promise<{ data: StockQuote | null; quality: DataQuality }> {
  const res = await get<DataEnvelope<StockQuote>>(`/api/stock/${encodeURIComponent(id)}/quote`, signal);
  const quality = readQuality(res);
  const quote = res.data;
  const validQuote = res.success
    && quote
    && typeof quote.stock_id === 'string'
    && typeof quote.name === 'string'
    && isPriceData({
      date: quote.date,
      open: quote.open,
      high: quote.high,
      low: quote.low,
      close: quote.close,
      volume: quote.volume,
    });
  return validQuote
    ? { data: quote, quality }
    : {
        data: null,
        quality: { ...quality, isStale: true, warnings: [...quality.warnings, '即時報價格式無效'] },
      };
}

// ── Market movers ──────────────────────────────────────────

export interface MoverRow {
  stock_id: string;
  stock_name: string;
  market: string;
  price: number;
  prev_close: number;
  change: number;
  change_pct: number;
}

export interface MoversResult {
  success: boolean;
  date: string;
  gainers: MoverRow[];
  losers: MoverRow[];
}

export async function fetchMovers(): Promise<MoversResult | null> {
  return get<MoversResult>('/api/movers');
}

// ── SR Analysis ──────────────────────────────────────────

export interface SRAnalysis {
  lastClose: number;
  atr14: number;
  vwap: number | null;
  poc: number | null;
  shortResistance: number | null;
  shortSupport: number | null;
  longResistance: number | null;
  longSupport: number | null;
  swingHigh: number | null;
  swingLow: number | null;
  pressure: { near: number | null; mid: number | null; far: number | null };
  support: { near: number | null; mid: number | null; far: number | null };
  resistances: { level: number; power: number }[];
  supports: { level: number; power: number }[];
  recentHigh: number;
  recentLow: number;
}

export async function fetchSRAnalysis(id: string, signal?: AbortSignal): Promise<SRAnalysis | null> {
  const res = await get<{ success: boolean; data: SRAnalysis }>(`/api/stock/${encodeURIComponent(id)}/sr-analysis`, signal);
  return res.success ? res.data : null;
}

// ── MA Analysis ──────────────────────────────────────────

export interface MAAnalysis {
  lastClose: number;
  previousClose: number;
  ma25: { ma: number; deduction: number; trend: string; tomorrow: string };
  ma60: { ma: number; deduction: number; trend: string; tomorrow: string };
  ma200: { ma: number; deduction: number; trend: string; tomorrow: string };
  bias: number;
  maGapPercent: number;
  arrangement: string;
  biasLabel: string;
}

export async function fetchMAAnalysis(id: string, signal?: AbortSignal): Promise<MAAnalysis | null> {
  const res = await get<{ success: boolean; data: MAAnalysis }>(`/api/stock/${encodeURIComponent(id)}/ma-analysis`, signal);
  return res.success ? res.data : null;
}

// ── Chips Analysis ──────────────────────────────────────────

export interface ChipsAnalysis {
  latestDate: string;
  foreignConsecutive: number;
  trustConsecutive: number;
  foreignTotal: number;
  trustTotal: number;
  whaleRatio: number | null;
  whaleChange: number | null;
  totalPeople: number | null;
  peopleChange: number | null;
  retailRatio: number | null;
  totalShares: number | null;
  chipHistory: { date: string; foreign: number; trust: number }[];
}

export async function fetchChipsAnalysis(id: string, signal?: AbortSignal): Promise<ChipsAnalysis | null> {
  const res = await get<{ success: boolean; data: ChipsAnalysis }>(`/api/stock/${encodeURIComponent(id)}/chips-analysis`, signal);
  return res.success ? res.data : null;
}

export interface InstitutionalHoldingSnapshot {
  stockId: string;
  date: string;
  foreignRatio: number;
  trustRatio: number;
  dealerRatio: number;
  totalRatio: number;
  foreignRatioChange: number | null;
  trustRatioChange: number | null;
  dealerRatioChange: number | null;
  totalRatioChange: number | null;
  ageDays: number;
  stale: boolean;
  sourceUrl: string;
  estimated: true;
}

export async function fetchInstitutionalHoldings(id: string, signal?: AbortSignal) {
  const res = await get<{ success: true; data: InstitutionalHoldingSnapshot }>(
    `/api/stock/${id}/institutional-holdings`,
    signal,
  );
  return res.data;
}

// ── Pattern Analysis ────────────────────────────────────────

export interface PatternAnalysis {
  patternName: string;
  patternDirection: string;
  stage: 'none' | 'forming' | 'confirmed';
  neckline: number | null;
  target: number | null;
  stopLoss: number | null;
  confidence: number;
  dataPoints: number;
  firstPivot: { date: string; price: number } | null;
  middlePivot: { date: string; price: number } | null;
  secondPivot: { date: string; price: number } | null;
  breakoutDate: string | null;
  distanceToNecklinePct: number | null;
  atr14: number | null;
  volumeRatio: number | null;
}

export async function fetchPatternAnalysis(id: string, signal?: AbortSignal): Promise<PatternAnalysis | null> {
  const res = await get<{ success: boolean; data: PatternAnalysis }>(`/api/stock/${encodeURIComponent(id)}/pattern-analysis`, signal);
  return res.success ? res.data : null;
}

export interface PredictionAnalysis {
  aiStrength: "看多" | "中性" | "看空";
  aiScore: number;
  volatility: number;
  avgReturn: number;
  aiReason: string;
  aiOffset: string;
  predictions: Array<{ day: string; price: number; pct: number }>;
  isSimulated: true;
  disclaimer: string;
}

export async function fetchPredictionAnalysis(id: string): Promise<PredictionAnalysis> {
  const res = await get<{ success: boolean; data: PredictionAnalysis }>(
    `/api/stock/${id}/prediction-analysis`,
  );
  if (!res.success || !res.data) throw new Error("無法取得技術模擬資料");
  return res.data;
}

// ── Strategy Scan Types ──────────────────────────────────

export type TradeRiskType = 'attention' | 'disposition' | 'trading_halt'
  | 'margin_restricted' | 'short_sale_restricted' | 'daytrade_restricted';

export interface TradeRiskFlag {
  type: TradeRiskType;
  level: 'medium' | 'high' | 'critical';
  action: 'exclude' | 'warn';
  reason: string;
}

interface RiskFlagged { riskFlags?: TradeRiskFlag[] }

export interface SRScanItem extends RiskFlagged {
  stock_id: string;
  stock_name: string;
  close: number;
  volume: number;
  amount: number;
  dist: number;
  tags: string;
  score: number;
  support: number;
}

export interface MAScanItem extends RiskFlagged {
  stock_id: string;
  stock_name: string;
  close: number;
  volume: number;
  amount: number;
  targetMA: number;
  targetLabel: string;
  bias: number;
  retraces: number;
  volumeRatio: number;
  previousClose: number;
  previousVolume: number;
  signal: string;
  maTrend: 'up' | 'down' | 'flat';
}

export interface ChipsScanItem extends RiskFlagged {
  stock_id: string;
  stock_name: string;
  close: number;
  volume: number;
  amount: number;
  consecutive: number;
  netTotal: number;
  type: string;
  whaleRatio?: number;
  whaleChange?: number;
  totalPeople?: number;
  peopleChange?: number;
  latestDate?: string;
  previousDate?: string;
}

export interface PatternScanItem extends RiskFlagged {
  stock_id: string;
  stock_name: string;
  close: number;
  volume: number;
  amount: number;
  patternName: string;
  stage: 'forming' | 'confirmed';
  confidence: number;
}

// ── Strategy Scan API Functions ──────────────────────────

export async function fetchSRScan(minVolume = 500, sort = '1'): Promise<SRScanItem[]> {
  const res = await get<{ success: boolean; data: SRScanItem[] }>(
    `/api/strategy/sr-scan?min_volume=${minVolume}&sort=${sort}`
  );
  return res.success ? res.data : [];
}

export async function fetchMAScan(minVolume = 500, type = '1', sort = '1'): Promise<MAScanItem[]> {
  const res = await get<{ success: boolean; data: MAScanItem[] }>(
    `/api/strategy/ma-scan?min_volume=${minVolume}&type=${type}&sort=${sort}`
  );
  return res.success ? res.data : [];
}

export async function fetchChipsScan(type = '1', sort = '1', nDays = 2): Promise<ChipsScanItem[]> {
  const res = await get<{ success: boolean; data: ChipsScanItem[] }>(
    `/api/strategy/chips-scan?type=${type}&sort=${sort}&n_days=${nDays}`
  );
  return res.success ? res.data : [];
}

export async function fetchPatternScan(minVolume = 500, sort = '1'): Promise<PatternScanItem[]> {
  const res = await get<{ success: boolean; data: PatternScanItem[] }>(
    `/api/strategy/pattern-scan?min_volume=${minVolume}&sort=${sort}`
  );
  return res.success ? res.data : [];
}

export interface TradeRisk {
  id: number;
  market: 'TWSE' | 'TPEx';
  type: TradeRiskType;
  level: 'medium' | 'high' | 'critical';
  reason: string;
  restrictions: string;
  announcedDate: string | null;
  startDate: string;
  endDate: string | null;
  isActive: boolean;
  daysUntilStart: number;
  daysUntilEnd: number | null;
  dataDate: string | null;
  source: string;
  sourceUrl: string;
  fetchedAt: string;
}

export interface StockTradeRiskResponse {
  stockId: string;
  asOf: string;
  hasActiveRisk: boolean;
  highestLevel: 'none' | 'medium' | 'high' | 'critical';
  risks: TradeRisk[];
  source: 'supabase' | 'sqlite';
  capabilities: {
    margin_restricted: { supported: boolean; reason: string };
  };
}

export async function fetchStockTradeRisks(id: string): Promise<StockTradeRiskResponse> {
  const res = await get<{ success: boolean; data: StockTradeRiskResponse; error?: string }>(
    `/api/stock/${encodeURIComponent(id)}/trade-risks`,
  );
  if (!res.success || !res.data) throw new Error(res.error || '無法取得交易風險資料');
  return res.data;
}
export interface ShareholdingRow {
  date: string;
  ratio: number;
  totalPeople: number | null;
  shares: number | null;
}

export async function fetchStockShareholding(id: string, signal?: AbortSignal): Promise<DataSeries<ShareholdingRow>> {
  const res = await get<DataEnvelope<ShareholdingRow[]>>(`/api/stock/${encodeURIComponent(id)}/shareholding`, signal);
  return { data: res.success ? res.data : [], quality: readQuality(res) };
}

export async function backfillStockShareholding(id: string): Promise<number> {
  const res = await fetch(`${BASE}/api/stock/${encodeURIComponent(id)}/shareholding/backfill`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });
  const payload = await res.json() as {
    success: boolean;
    data?: { insertedWeeks: number };
    error?: string;
  };
  if (!res.ok || !payload.success) throw new Error(payload.error || `HTTP error: ${res.status}`);
  return payload.data?.insertedWeeks || 0;
}

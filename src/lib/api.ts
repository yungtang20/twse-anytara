import { PriceData } from './indicators';
import { normalizeVolumes } from './utils';
export type { PriceData };

// API utils for fetching data via backend proxy
// Base URL defaults to same origin; override via VITE_API_URL for production
const BASE = import.meta.env.VITE_API_URL || '';

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new Error(`HTTP error: ${res.status}`);
  return res.json() as Promise<T>;
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
  return {
    source: quality.source || res.source || 'unknown',
    asOf: quality.asOf ?? res.asOf ?? null,
    isMock: quality.isMock ?? res.isMock ?? false,
    isStale: quality.isStale ?? res.isStale ?? false,
    warnings: quality.warnings || res.warnings || [],
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

export async function fetchStockSearch(query: string): Promise<StockMeta[]> {
  const res = await get<{ success: boolean; data: StockMeta[] }>(`/api/stock/search?q=${encodeURIComponent(query)}`);
  return res.success ? res.data : [];
}

// ── Stock price history ────────────────────────────────────

export async function fetchStockHistory(id: string, days = 120): Promise<DataSeries<PriceData>> {
  const res = await get<DataEnvelope<PriceData[]>>(`/api/stock/${id}/history?days=${days}`);
  return { data: res.success ? normalizeVolumes(res.data) : [], quality: readQuality(res) };
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

export async function fetchStockInstitutional(id: string): Promise<DataSeries<InstitutionalRow>> {
  const res = await get<DataEnvelope<InstitutionalRow[]>>(`/api/stock/${id}/institutional`);
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

export async function fetchStockQuote(id: string): Promise<{ data: StockQuote | null; quality: DataQuality }> {
  const res = await get<DataEnvelope<StockQuote>>(`/api/stock/${id}/quote`);
  return { data: res.success ? res.data : null, quality: readQuality(res) };
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
  pressure: { near: number | null; mid: number | null; far: number | null };
  support: { near: number | null; mid: number | null; far: number | null };
  resistances: { level: number; power: number }[];
  supports: { level: number; power: number }[];
  recentHigh: number;
  recentLow: number;
}

export async function fetchSRAnalysis(id: string): Promise<SRAnalysis | null> {
  const res = await get<{ success: boolean; data: SRAnalysis }>(`/api/stock/${id}/sr-analysis`);
  return res.success ? res.data : null;
}

// ── MA Analysis ──────────────────────────────────────────

export interface MAAnalysis {
  lastClose: number;
  ma25: number | null;
  ma60: number | null;
  ma200: number | null;
  deduction25: number | null;
  deduction60: number | null;
  deduction200: number | null;
  trend25: string;
  trend60: string;
  trend200: string;
  tomorrow25: string;
  tomorrow60: string;
  tomorrow200: string;
  bias: number;
  maGapPercent: number;
  arrangement: string;
}

export async function fetchMAAnalysis(id: string): Promise<MAAnalysis | null> {
  const res = await get<{ success: boolean; data: MAAnalysis }>(`/api/stock/${id}/ma-analysis`);
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
  retailRatio: number | null;
  totalShares: number | null;
  chipHistory: { date: string; foreign: number; trust: number }[];
}

export async function fetchChipsAnalysis(id: string): Promise<ChipsAnalysis | null> {
  const res = await get<{ success: boolean; data: ChipsAnalysis }>(`/api/stock/${id}/chips-analysis`);
  return res.success ? res.data : null;
}

// ── Pattern Analysis ────────────────────────────────────────

export interface PatternAnalysis {
  patternName: string;
  patternDirection: string;
  neckline: number | null;
  target: number | null;
  stopLoss: number | null;
  confidence: number;
  dataPoints: number;
}

export async function fetchPatternAnalysis(id: string): Promise<PatternAnalysis | null> {
  const res = await get<{ success: boolean; data: PatternAnalysis }>(`/api/stock/${id}/pattern-analysis`);
  return res.success ? res.data : null;
}

// ── Strategy Scan Types ──────────────────────────────────

export interface SRScanItem {
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

export interface MAScanItem {
  stock_id: string;
  stock_name: string;
  close: number;
  volume: number;
  amount: number;
  targetMA: number;
  targetLabel: string;
  bias: number;
  touchCount: number;
}

export interface ChipsScanItem {
  stock_id: string;
  stock_name: string;
  close: number;
  volume: number;
  amount: number;
  consecutive: number;
  netTotal: number;
  type: string;
}

export interface PatternScanItem {
  stock_id: string;
  stock_name: string;
  close: number;
  volume: number;
  amount: number;
  patternName: string;
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

export async function fetchChipsScan(type = '1', sort = '1'): Promise<ChipsScanItem[]> {
  const res = await get<{ success: boolean; data: ChipsScanItem[] }>(
    `/api/strategy/chips-scan?type=${type}&sort=${sort}`
  );
  return res.success ? res.data : [];
}

export async function fetchPatternScan(minVolume = 500, sort = '1'): Promise<PatternScanItem[]> {
  const res = await get<{ success: boolean; data: PatternScanItem[] }>(
    `/api/strategy/pattern-scan?min_volume=${minVolume}&sort=${sort}`
  );
  return res.success ? res.data : [];
}
export interface ShareholdingRow {
  date: string;
  ratio: number;
}

export async function fetchStockShareholding(id: string): Promise<DataSeries<ShareholdingRow>> {
  const res = await get<DataEnvelope<ShareholdingRow[]>>(`/api/stock/${id}/shareholding`);
  return { data: res.success ? res.data : [], quality: readQuality(res) };
}

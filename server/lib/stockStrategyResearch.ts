import type { StrategyId, StrategyResearchResult, StrategySignal } from "../../shared/researchContext";
import { buildSupportResistanceLines } from "../../src/lib/trendLines";
import {
  fetchCloudInstitutional,
  fetchCloudPrices,
  fetchCloudShareholding,
  type CloudInstitutionalRow,
  type CloudPriceRow,
} from "./cloudMarketData";
import { analyzeMovingAverage } from "./maStrategy";
import { analyzeChartPattern } from "./patternStrategy";

export interface StockStrategyResearchReaders {
  readInstitutional(stockId: string): Promise<CloudInstitutionalRow[]>;
  readShareholding(stockId: string): ReturnType<typeof fetchCloudShareholding>;
}

const DEFAULT_READERS: StockStrategyResearchReaders = {
  readInstitutional: (stockId) => fetchCloudInstitutional(stockId, 30),
  readShareholding: (stockId) => fetchCloudShareholding(stockId, 10),
};

export function countConsecutive(
  rows: CloudInstitutionalRow[],
  key: "foreign_net" | "trust_net",
): number {
  if (rows.length === 0) return 0;
  const first = rows[0][key];
  if (first === 0) return 0;
  const positive = first > 0;
  let count = 0;
  for (const row of rows) {
    const value = row[key];
    if ((positive && value <= 0) || (!positive && value >= 0)) break;
    count += 1;
  }
  return positive ? count : -count;
}

export function consecutiveNetTotal(
  rows: CloudInstitutionalRow[],
  key: "foreign_net" | "trust_net",
  consecutive: number,
): number {
  return rows.slice(0, Math.abs(consecutive)).reduce((sum, row) => sum + row[key], 0) / 1000;
}

function pointOfControl(rows: CloudPriceRow[], binCount = 15): number | null {
  if (rows.length === 0) return null;
  const minPrice = Math.min(...rows.map((row) => row.low));
  const maxPrice = Math.max(...rows.map((row) => row.high));
  if (minPrice === maxPrice) return minPrice;
  const binWidth = (maxPrice - minPrice) / binCount;
  const volumes = Array<number>(binCount).fill(0);
  for (const row of rows) {
    const index = Math.min(binCount - 1, Math.max(0, Math.floor((row.close - minPrice) / binWidth)));
    volumes[index] += row.volume;
  }
  const maxVolumeIndex = volumes.indexOf(Math.max(...volumes));
  return minPrice + (maxVolumeIndex + 0.5) * binWidth;
}

function atr14(rows: CloudPriceRow[]): number {
  let sum = 0;
  const start = Math.max(1, rows.length - 14);
  for (let index = start; index < rows.length; index += 1) {
    sum += Math.max(rows[index].high - rows[index].low,
      Math.abs(rows[index].high - rows[index - 1].close),
      Math.abs(rows[index].low - rows[index - 1].close));
  }
  return sum / Math.max(1, rows.length - start);
}

function round(value: number | null): number | null {
  return value === null ? null : Number(value.toFixed(2));
}

interface DerivedStrategySignal {
  signal: StrategySignal;
  score: number | null;
  summary: string;
}

const SR_PROXIMITY_PERCENT = 3;
const CHIP_SIGNAL_THRESHOLD = 2;

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function numericValues(value: unknown): number[] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.values(value as Record<string, unknown>)
    .map(finiteNumber).filter((item): item is number => item !== null && item > 0);
}

function deriveSrSignal(details: Record<string, unknown>): DerivedStrategySignal {
  const close = finiteNumber(details.lastClose);
  if (close === null || close <= 0) return { signal: "UNKNOWN", score: null, summary: "缺少有效收盤價" };
  const supports = numericValues(details.support).filter((level) => level <= close);
  const pressures = numericValues(details.pressure).filter((level) => level >= close);
  const supportDistance = supports.length ? Math.min(...supports.map((level) => (close - level) / close * 100)) : null;
  const pressureDistance = pressures.length ? Math.min(...pressures.map((level) => (level - close) / close * 100)) : null;
  if (supportDistance === null && pressureDistance === null) {
    return { signal: "UNKNOWN", score: null, summary: "缺少有效支撐與壓力" };
  }
  const nearest = Math.min(supportDistance ?? Infinity, pressureDistance ?? Infinity);
  if (nearest > SR_PROXIMITY_PERCENT || supportDistance === pressureDistance) {
    return { signal: "HOLD", score: 0, summary: `最近支撐/壓力距離 ${round(nearest)}%，未形成偏向` };
  }
  const signal = supportDistance !== null && supportDistance < (pressureDistance ?? Infinity) ? "BUY" : "SELL";
  const magnitude = Math.max(0, Math.round((1 - nearest / SR_PROXIMITY_PERCENT) * 100));
  return { signal, score: signal === "BUY" ? magnitude : -magnitude,
    summary: `${signal === "BUY" ? "支撐" : "壓力"}較近（${round(nearest)}%，門檻 ${SR_PROXIMITY_PERCENT}%）` };
}

function deriveMaSignal(details: Record<string, unknown>): DerivedStrategySignal {
  const arrangement = typeof details.arrangement === "string" ? details.arrangement : "";
  if (!arrangement) return { signal: "UNKNOWN", score: null, summary: "缺少均線排列" };
  const positive = /多頭|突破|黃金|站上|轉強|翻多|偏強/.test(arrangement);
  const negative = /空頭|跌破|死亡|弱勢|轉弱|尋底/.test(arrangement);
  const signal: StrategySignal = positive === negative ? "HOLD" : positive ? "BUY" : "SELL";
  return { signal, score: signal === "BUY" ? 100 : signal === "SELL" ? -100 : 0,
    summary: `均線排列：${arrangement}` };
}

function signed(value: unknown, invert = false): number | null {
  const number = finiteNumber(value);
  if (number === null) return null;
  const sign = number > 0 ? 1 : number < 0 ? -1 : 0;
  return invert ? -sign : sign;
}

function deriveChipsSignal(details: Record<string, unknown>): DerivedStrategySignal {
  const components = [signed(details.foreignTotal), signed(details.trustTotal),
    signed(details.whaleChange), signed(details.peopleChange, true)];
  const available = components.filter((value): value is number => value !== null);
  if (available.length === 0) return { signal: "UNKNOWN", score: null, summary: "法人與集保籌碼皆無資料" };
  const rawScore = available.reduce((sum, value) => sum + value, 0);
  const signal: StrategySignal = rawScore >= CHIP_SIGNAL_THRESHOLD ? "BUY"
    : rawScore <= -CHIP_SIGNAL_THRESHOLD ? "SELL" : "HOLD";
  return { signal, score: rawScore * 25,
    summary: `籌碼 signed score ${rawScore}（BUY ≥ ${CHIP_SIGNAL_THRESHOLD}，SELL ≤ -${CHIP_SIGNAL_THRESHOLD}）` };
}

function derivePatternSignal(details: Record<string, unknown>): DerivedStrategySignal {
  const stage = details.stage;
  const direction = details.patternDirection;
  if (stage === "forming") return { signal: "HOLD", score: 0, summary: "型態形成中，尚未確認" };
  if (stage !== "confirmed" || !["up", "down"].includes(String(direction))) {
    return { signal: "UNKNOWN", score: null, summary: "無可確認型態" };
  }
  const signal: StrategySignal = direction === "up" ? "BUY" : "SELL";
  const confidence = finiteNumber(details.confidence);
  const magnitude = confidence === null ? null : Math.round(Math.max(0, Math.min(1, confidence)) * 100);
  return { signal, score: magnitude === null ? null : signal === "BUY" ? magnitude : -magnitude,
    summary: `已確認${direction === "up" ? "向上" : "向下"}型態` };
}

export function deriveStockStrategySignal(
  strategy: StrategyId,
  details: Record<string, unknown>,
): DerivedStrategySignal {
  if (strategy === "sr") return deriveSrSignal(details);
  if (strategy === "ma") return deriveMaSignal(details);
  if (strategy === "chips") return deriveChipsSignal(details);
  return derivePatternSignal(details);
}

export function analyzeSupportResistance(rows: CloudPriceRow[]): Record<string, unknown> {
  if (rows.length < 60) throw new Error("Insufficient Supabase price history");
  const lastIndex = rows.length - 1;
  const lines = buildSupportResistanceLines(rows, lastIndex);
  const visibleRows = rows.slice(-61);
  const recentRows = rows.slice(-20);
  const recentHigh = Math.max(...recentRows.map((row) => row.high));
  const recentLow = Math.min(...recentRows.map((row) => row.low));
  const shortResistance = lines.shortResistance[lastIndex];
  const shortSupport = lines.shortSupport[lastIndex];
  const longResistance = lines.longResistance[lastIndex];
  const longSupport = lines.longSupport[lastIndex];
  const totalVolume = recentRows.reduce((sum, row) => sum + row.volume, 0);
  const vwap = totalVolume > 0
    ? recentRows.reduce((sum, row) => sum + ((row.high + row.low + row.close) / 3) * row.volume, 0) / totalVolume
    : null;
  return {
    lastClose: rows[lastIndex].close, atr14: round(atr14(rows)), vwap: round(vwap),
    poc: round(pointOfControl(visibleRows)), shortResistance: round(shortResistance),
    shortSupport: round(shortSupport), longResistance: round(longResistance), longSupport: round(longSupport),
    swingHigh: round(Math.max(...visibleRows.map((row) => row.high))),
    swingLow: round(Math.min(...visibleRows.map((row) => row.low))),
    pressure: { near: round(recentHigh), mid: round(shortResistance), far: round(longResistance) },
    support: { near: round(recentLow), mid: round(shortSupport), far: round(longSupport) },
    resistances: [recentHigh, shortResistance, longResistance].filter((value): value is number => value !== null).map((level) => ({ level: round(level), power: 1 })),
    supports: [recentLow, shortSupport, longSupport].filter((value): value is number => value !== null).map((level) => ({ level: round(level), power: 1 })),
    recentHigh: round(recentHigh), recentLow: round(recentLow),
  };
}

async function runChips(
  stockId: string,
  priceRows: CloudPriceRow[],
  readers: StockStrategyResearchReaders,
): Promise<Record<string, unknown>> {
  const [prices, institutional, shareholding] = await Promise.all([
    priceRows, readers.readInstitutional(stockId), readers.readShareholding(stockId),
  ]);
  const latestDate = prices.at(-1)?.date;
  if (!latestDate) throw new Error("No Supabase price data");
  const [latestShare, previousShare] = shareholding;
  const whaleChange = latestShare && previousShare
    ? Number((latestShare.whale_ratio - previousShare.whale_ratio).toFixed(2)) : null;
  const peopleChange = latestShare?.total_people != null && previousShare?.total_people != null
    ? latestShare.total_people - previousShare.total_people : null;
  return {
    date: latestDate, latestDate, foreignConsecutive: countConsecutive(institutional, "foreign_net"),
    trustConsecutive: countConsecutive(institutional, "trust_net"),
    foreignTotal: institutional.length
      ? Math.floor(institutional.reduce((sum, row) => sum + row.foreign_net, 0) / 1000) : null,
    trustTotal: institutional.length
      ? Math.floor(institutional.reduce((sum, row) => sum + row.trust_net, 0) / 1000) : null,
    whaleRatio: latestShare?.whale_ratio ?? null, whaleChange,
    totalPeople: latestShare?.total_people ?? null, peopleChange,
    retailRatio: latestShare?.retail_ratio ?? null, totalShares: latestShare?.total_shares ?? null,
    shareholdingSource: latestShare?.source ?? null,
    shareholdingPartialFields: latestShare?.source === "goodinfo_tdcc_bootstrap" && latestShare.retail_ratio == null,
    chipHistory: institutional.slice(0, 10).map((row) => ({
      date: row.date.slice(5), foreign: Math.floor(row.foreign_net / 1000), trust: Math.floor(row.trust_net / 1000),
    })),
  };
}

export async function runStockStrategyRaw(
  stockId: string,
  strategy: StrategyId,
  priceRows?: CloudPriceRow[],
  readers: StockStrategyResearchReaders = DEFAULT_READERS,
): Promise<Record<string, unknown>> {
  const limit = strategy === "pattern" ? 120 : 512;
  const loadedRows = priceRows ?? await fetchCloudPrices(stockId, limit);
  const sortedRows = [...loadedRows].sort((left, right) => left.date.localeCompare(right.date));
  const rows = strategy === "pattern" ? sortedRows.slice(-120) : sortedRows;
  const date = rows.at(-1)?.date ?? null;
  if (strategy === "sr") return { ...analyzeSupportResistance(rows), date };
  if (strategy === "ma") {
    return { ...analyzeMovingAverage(rows), date };
  }
  if (strategy === "chips") return runChips(stockId, rows, readers);
  if (rows.length < 30) throw new Error("Insufficient Supabase price history");
  return { ...analyzeChartPattern(rows), date };
}

export async function runStockStrategyResearch(
  stockId: string,
  strategy: StrategyId,
  priceRows?: CloudPriceRow[],
  readers: StockStrategyResearchReaders = DEFAULT_READERS,
): Promise<StrategyResearchResult> {
  const details = await runStockStrategyRaw(stockId, strategy, priceRows, readers);
  const date = typeof details.date === "string" ? details.date : null;
  const confidence = strategy === "pattern" && typeof details.confidence === "number" ? details.confidence : null;
  const derived = deriveStockStrategySignal(strategy, details);
  return {
    strategy, status: "ok", date, score: derived.score, signal: derived.signal,
    confidence, summary: derived.summary, details,
  };
}

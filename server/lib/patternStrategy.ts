import type { CloudPriceRow } from "./cloudMarketData";

export type PatternStage = "none" | "forming" | "confirmed";

export interface PatternPoint {
  date: string;
  price: number;
}

export interface PatternAnalysisResult {
  patternName: string;
  patternDirection: "up" | "down" | "neutral";
  stage: PatternStage;
  neckline: number | null;
  target: number | null;
  stopLoss: number | null;
  confidence: number;
  dataPoints: number;
  firstPivot: PatternPoint | null;
  middlePivot: PatternPoint | null;
  secondPivot: PatternPoint | null;
  breakoutDate: string | null;
  distanceToNecklinePct: number | null;
  atr14: number | null;
  volumeRatio: number | null;
}

interface IndexedPivot extends PatternPoint {
  index: number;
}

interface PatternCandidate extends PatternAnalysisResult {
  secondIndex: number;
}

const PIVOT_RADIUS = 3;
const MIN_PIVOT_GAP = 5;
const MAX_PIVOT_GAP = 40;
const LATEST_PIVOT_MAX_AGE = 10;
const MIN_CONFIDENCE = 0.5;

const round = (value: number) => Number(value.toFixed(2));
const clamp01 = (value: number) => Math.max(0, Math.min(1, value));

export function analyzeChartPattern(inputRows: CloudPriceRow[]): PatternAnalysisResult {
  const rows = inputRows.slice(-120);
  if (rows.length < 30) return emptyResult(rows.length);
  const atr14 = calculateAtr14(rows);
  const lows = findPivots(rows, "low");
  const highs = findPivots(rows, "high");
  const candidates = [
    ...buildBottomCandidates(rows, lows, atr14),
    ...buildTopCandidates(rows, highs, atr14),
  ].filter((candidate) => candidate.confidence >= MIN_CONFIDENCE);
  const latest = selectLatestCandidate(candidates);
  if (!latest) return emptyResult(rows.length, atr14);
  const { secondIndex: _secondIndex, ...result } = latest;
  return result;
}

function findPivots(rows: CloudPriceRow[], kind: "low" | "high"): IndexedPivot[] {
  const pivots: IndexedPivot[] = [];
  for (let index = PIVOT_RADIUS; index < rows.length - PIVOT_RADIUS; index++) {
    const value = rows[index][kind];
    const neighbors = rows.slice(index - PIVOT_RADIUS, index + PIVOT_RADIUS + 1)
      .filter((_, offset) => offset !== PIVOT_RADIUS)
      .map((row) => row[kind]);
    const isExtreme = kind === "low"
      ? neighbors.every((price) => value <= price) && neighbors.some((price) => value < price)
      : neighbors.every((price) => value >= price) && neighbors.some((price) => value > price);
    if (isExtreme) pivots.push({ index, date: rows[index].date, price: value });
  }
  return pivots;
}

function buildBottomCandidates(
  rows: CloudPriceRow[],
  lows: IndexedPivot[],
  atr14: number,
): PatternCandidate[] {
  const candidates: PatternCandidate[] = [];
  for (let firstIndex = 0; firstIndex < lows.length; firstIndex++) {
    for (let secondIndex = firstIndex + 1; secondIndex < lows.length; secondIndex++) {
      const first = lows[firstIndex];
      const second = lows[secondIndex];
      if (!isEligiblePair(rows, first, second, atr14)) continue;
      const middle = extremeBetween(rows, first.index, second.index, "high");
      const average = (first.price + second.price) / 2;
      if (!middle || (middle.price - average) / average < 0.05) continue;
      if (rows.at(-1)!.close < Math.min(first.price, second.price) - atr14 * 0.5) continue;
      candidates.push(createCandidate(rows, "bottom", first, middle, second, atr14));
    }
  }
  return candidates;
}

function buildTopCandidates(
  rows: CloudPriceRow[],
  highs: IndexedPivot[],
  atr14: number,
): PatternCandidate[] {
  const candidates: PatternCandidate[] = [];
  for (let firstIndex = 0; firstIndex < highs.length; firstIndex++) {
    for (let secondIndex = firstIndex + 1; secondIndex < highs.length; secondIndex++) {
      const first = highs[firstIndex];
      const second = highs[secondIndex];
      if (!isEligiblePair(rows, first, second, atr14)) continue;
      const middle = extremeBetween(rows, first.index, second.index, "low");
      const average = (first.price + second.price) / 2;
      if (!middle || (average - middle.price) / average < 0.05) continue;
      if (rows.at(-1)!.close > Math.max(first.price, second.price) + atr14 * 0.5) continue;
      candidates.push(createCandidate(rows, "top", first, middle, second, atr14));
    }
  }
  return candidates;
}

function isEligiblePair(
  rows: CloudPriceRow[],
  first: IndexedPivot,
  second: IndexedPivot,
  atr14: number,
) {
  const gap = second.index - first.index;
  const age = rows.length - 1 - second.index;
  const average = (first.price + second.price) / 2;
  const tolerance = Math.max(average * 0.03, atr14);
  return gap >= MIN_PIVOT_GAP && gap <= MAX_PIVOT_GAP
    && age <= LATEST_PIVOT_MAX_AGE
    && Math.abs(first.price - second.price) <= tolerance;
}

function extremeBetween(
  rows: CloudPriceRow[],
  start: number,
  end: number,
  kind: "low" | "high",
): IndexedPivot | null {
  let selectedIndex = -1;
  for (let index = start + 1; index < end; index++) {
    if (selectedIndex < 0 || (kind === "high"
      ? rows[index].high > rows[selectedIndex].high
      : rows[index].low < rows[selectedIndex].low)) selectedIndex = index;
  }
  return selectedIndex < 0 ? null : {
    index: selectedIndex,
    date: rows[selectedIndex].date,
    price: rows[selectedIndex][kind],
  };
}

function createCandidate(
  rows: CloudPriceRow[],
  kind: "bottom" | "top",
  first: IndexedPivot,
  middle: IndexedPivot,
  second: IndexedPivot,
  atr14: number,
): PatternCandidate {
  const latest = rows.at(-1)!;
  const average = (first.price + second.price) / 2;
  const buffer = Math.max(middle.price * 0.003, atr14 * 0.25);
  const confirmed = kind === "bottom"
    ? latest.close > middle.price + buffer
    : latest.close < middle.price - buffer;
  const breakoutIndex = confirmed
    ? findBreakoutIndex(rows, second.index, middle.price, buffer, kind) : -1;
  const volumeRatio = breakoutIndex >= 0 ? volumeRatioAt(rows, breakoutIndex) : null;
  const confidence = scoreCandidate(first, middle, second, atr14, confirmed, volumeRatio);
  const target = middle.price * 2 - average;
  return {
    patternName: kind === "bottom" ? "W底" : "M頂",
    patternDirection: kind === "bottom" ? "up" : "down",
    stage: confirmed ? "confirmed" : "forming",
    neckline: round(middle.price),
    target: round(Math.max(0.01, target)),
    stopLoss: round(kind === "bottom" ? second.price - atr14 * 0.5 : second.price + atr14 * 0.5),
    confidence: round(confidence) / 100,
    dataPoints: rows.length,
    firstPivot: point(first),
    middlePivot: point(middle),
    secondPivot: point(second),
    breakoutDate: breakoutIndex >= 0 ? rows[breakoutIndex].date : null,
    distanceToNecklinePct: round(((latest.close - middle.price) / middle.price) * 100),
    atr14: round(atr14),
    volumeRatio: volumeRatio === null ? null : round(volumeRatio),
    secondIndex: second.index,
  };
}

function scoreCandidate(
  first: IndexedPivot,
  middle: IndexedPivot,
  second: IndexedPivot,
  atr14: number,
  confirmed: boolean,
  volumeRatio: number | null,
) {
  const average = (first.price + second.price) / 2;
  const tolerance = Math.max(average * 0.03, atr14);
  const similarity = 25 * clamp01(1 - Math.abs(first.price - second.price) / tolerance);
  const spacing = 15 * clamp01(1 - Math.abs(second.index - first.index - 22) / 22);
  const depth = Math.abs(middle.price - average) / average;
  const depthScore = 20 * clamp01(depth / 0.12);
  const breakoutScore = confirmed ? 25 : 8;
  const volumeScore = confirmed && volumeRatio !== null
    ? 15 * clamp01((volumeRatio - 0.8) / 0.8) : 0;
  return similarity + spacing + depthScore + breakoutScore + volumeScore;
}

function findBreakoutIndex(
  rows: CloudPriceRow[], secondIndex: number, neckline: number, buffer: number,
  kind: "bottom" | "top",
) {
  return rows.findIndex((row, index) => index > secondIndex && (kind === "bottom"
    ? row.close > neckline + buffer
    : row.close < neckline - buffer));
}

function volumeRatioAt(rows: CloudPriceRow[], index: number) {
  const previous = rows.slice(Math.max(0, index - 20), index);
  if (previous.length === 0) return null;
  const average = previous.reduce((sum, row) => sum + row.volume, 0) / previous.length;
  return average > 0 ? rows[index].volume / average : null;
}

function calculateAtr14(rows: CloudPriceRow[]) {
  const start = Math.max(1, rows.length - 14);
  let total = 0;
  for (let index = start; index < rows.length; index++) {
    total += Math.max(
      rows[index].high - rows[index].low,
      Math.abs(rows[index].high - rows[index - 1].close),
      Math.abs(rows[index].low - rows[index - 1].close),
    );
  }
  return total / Math.max(1, rows.length - start);
}

function selectLatestCandidate(candidates: PatternCandidate[]) {
  return [...candidates].sort((left, right) =>
    right.secondIndex - left.secondIndex
    || right.confidence - left.confidence
    || Number(right.stage === "confirmed") - Number(left.stage === "confirmed"))[0];
}

function point(pivot: IndexedPivot): PatternPoint {
  return { date: pivot.date, price: round(pivot.price) };
}

function emptyResult(dataPoints: number, atr14: number | null = null): PatternAnalysisResult {
  return {
    patternName: "無明顯型態", patternDirection: "neutral", stage: "none",
    neckline: null, target: null, stopLoss: null, confidence: 0, dataPoints,
    firstPivot: null, middlePivot: null, secondPivot: null, breakoutDate: null,
    distanceToNecklinePct: null, atr14: atr14 === null ? null : round(atr14), volumeRatio: null,
  };
}

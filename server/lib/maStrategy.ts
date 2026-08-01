export type MovingAverageScanType = "1" | "2" | "3" | "4" | "5" | "6";

export interface MovingAverageRow {
  close: number;
  volume: number;
}

export interface MovingAverageMetric {
  ma: number;
  deduction: number;
  trend: "↑ 上揚" | "↓ 下彎" | "→ 走平";
  tomorrow: "↑" | "↓" | "→";
}

export interface MovingAverageAnalysis {
  lastClose: number;
  previousClose: number;
  ma25: MovingAverageMetric;
  ma60: MovingAverageMetric;
  ma200: MovingAverageMetric;
  bias: number;
  maGapPercent: number;
  arrangement: string;
  biasLabel: "⚠ 過熱" | "⚠ 超跌" | "正常";
}

export interface MovingAverageScanMatch {
  targetMA: number;
  targetLabel: "MA25" | "MA60" | "MA200";
  bias: number;
  retraces: number;
  volumeRatio: number;
  previousClose: number;
  previousVolume: number;
  signal: string;
  maTrend: "up" | "down" | "flat";
}

const round = (value: number) => Number(value.toFixed(2));

function averageAt(values: number[], period: number, endIndex: number): number | null {
  const start = endIndex - period + 1;
  if (start < 0) return null;
  let total = 0;
  for (let index = start; index <= endIndex; index++) total += values[index];
  return total / period;
}

function movingAverageSeries(values: number[], period: number): Array<number | null> {
  return values.map((_, index) => averageAt(values, period, index));
}

export function computeMovingAverageMetric(closes: number[], period: number): MovingAverageMetric {
  const currentPrice = closes.at(-1) ?? 0;
  if (closes.length < period) {
    return { ma: currentPrice, deduction: 0, trend: "→ 走平", tomorrow: "→" };
  }
  const ma = averageAt(closes, period, closes.length - 1)!;
  const deduction = closes.at(-period)!;
  const todayDeduction = closes.length >= period + 1 ? closes.at(-period - 1)! : currentPrice;
  const trend = currentPrice > todayDeduction + 0.01
    ? "↑ 上揚" : currentPrice < todayDeduction - 0.01 ? "↓ 下彎" : "→ 走平";
  const tomorrow = deduction < currentPrice * 0.995
    ? "↑" : deduction > currentPrice * 1.005 ? "↓" : "→";
  return { ma: round(ma), deduction: round(deduction), trend, tomorrow };
}

function classifyArrangement(
  current: number,
  ma25: number,
  ma60: number,
  ma200: number,
  ma60Trend: MovingAverageMetric["trend"],
): string {
  if (current > ma25 && ma25 > ma60 && ma60 > ma200 && ma60Trend === "↑ 上揚") return "多頭排列 (強勢攻擊)";
  if (current < ma25 && ma25 < ma60 && ma60 < ma200 && ma60Trend === "↓ 下彎") return "空頭排列 (弱勢尋底)";
  if (current < ma25 && current < ma60) return "跌破中短期均線 (弱勢)";
  if (current > ma25 && current > ma60) return "站上中短期均線 (偏強)";
  return "區間震盪";
}

export function analyzeMovingAverage(rows: MovingAverageRow[]): MovingAverageAnalysis {
  if (rows.length < 20) throw new Error("Insufficient Supabase price history");
  const closes = rows.map((row) => row.close);
  const lastClose = closes.at(-1)!;
  const previousClose = closes.at(-2) ?? lastClose;
  const ma25 = computeMovingAverageMetric(closes, 25);
  const ma60 = computeMovingAverageMetric(closes, 60);
  const ma200 = computeMovingAverageMetric(closes, 200);
  const previousMa60 = averageAt(closes, 60, closes.length - 2) ?? 0;
  const previousMa200 = averageAt(closes, 200, closes.length - 2) ?? 0;
  let arrangement = classifyArrangement(lastClose, ma25.ma, ma60.ma, ma200.ma, ma60.trend);

  if (ma60.ma > 0 && ma200.ma > 0) {
    if (ma60.ma > ma200.ma && previousMa60 <= previousMa200) arrangement = "黃金交叉 (趨勢轉強)";
    else if (ma60.ma < ma200.ma && previousMa60 >= previousMa200) arrangement = "死亡交叉 (趨勢轉弱)";
  }
  if (ma60.ma > 0 && previousClose <= previousMa60 && lastClose > ma60.ma) arrangement = "突破季線 (短線轉強)";
  else if (ma200.ma > 0 && previousClose <= previousMa200 && lastClose > ma200.ma) arrangement = "突破年線 (長線翻多)";

  const bias = ma60.ma > 0 ? ((lastClose - ma60.ma) / ma60.ma) * 100 : 0;
  const maGapPercent = ma200.ma > 0 ? ((ma60.ma - ma200.ma) / ma200.ma) * 100 : 0;
  return {
    lastClose,
    previousClose,
    ma25,
    ma60,
    ma200,
    bias: round(bias),
    maGapPercent: round(maGapPercent),
    arrangement,
    biasLabel: bias >= 20 ? "⚠ 過熱" : bias <= -20 ? "⚠ 超跌" : "正常",
  };
}

function countRetraces(closes: number[], series: Array<number | null>): number {
  let index = closes.length - 1;
  while (index >= 0) {
    const ma = series[index];
    if (ma === null || ma <= 0 || closes[index] < ma) break;
    index--;
  }
  const breakoutStart = index + 1;
  if (breakoutStart >= closes.length) return 0;
  let count = 0;
  for (let cursor = breakoutStart + 1; cursor < closes.length; cursor++) {
    const ma = series[cursor];
    if (ma !== null && ma <= closes[cursor] && closes[cursor] <= ma * 1.1) count++;
  }
  return count;
}

function hasContinuousMa25Breakout(closes: number[], ma25: Array<number | null>): boolean {
  let breakoutIndex: number | null = null;
  for (let offset = 2; offset < Math.min(60, closes.length); offset++) {
    const index = closes.length - offset;
    const previousMa = ma25[index - 1];
    const currentMa = ma25[index];
    if (previousMa !== null && currentMa !== null && closes[index - 1] <= previousMa && closes[index] > currentMa) {
      breakoutIndex = index;
      break;
    }
  }
  if (breakoutIndex === null) return false;
  for (let index = breakoutIndex; index < closes.length; index++) {
    const ma = ma25[index];
    if (ma === null || closes[index] < ma) return false;
  }
  return true;
}

export function scanMovingAverage(
  rows: MovingAverageRow[],
  type: MovingAverageScanType,
): MovingAverageScanMatch | null {
  const period = { "1": 200, "2": 60, "3": 25, "4": 200, "5": 60, "6": 25 }[type];
  if (rows.length < period || rows.length < 2) return null;
  const closes = rows.map((row) => row.close);
  const volumes = rows.map((row) => row.volume);
  const maSeries = movingAverageSeries(closes, period);
  const lastIndex = closes.length - 1;
  const currentMa = maSeries[lastIndex];
  const previousMa = maSeries[lastIndex - 1];
  if (currentMa === null || previousMa === null || currentMa <= 0) return null;
  const currentPrice = closes[lastIndex];
  const previousPrice = closes[lastIndex - 1];
  const currentVolume = volumes[lastIndex];
  const previousVolume = volumes[lastIndex - 1];
  const volumeRatio = previousVolume > 0 ? (currentVolume - previousVolume) / previousVolume : 0;
  const crossedAbove = previousPrice <= previousMa && currentPrice > currentMa && currentVolume > previousVolume;
  const retraced = previousPrice > previousMa * 1.1
    && currentMa <= currentPrice && currentPrice <= currentMa * 1.1
    && currentVolume > previousVolume;

  let matched = (type === "1" || type === "2") ? crossedAbove : (type === "4" || type === "5" || type === "6") ? retraced : false;
  if (type === "3") {
    const ma25 = maSeries;
    const volumeMa5 = movingAverageSeries(volumes, 5);
    const volumeMa60 = movingAverageSeries(volumes, 60);
    const volCross = volumeMa5[lastIndex - 1] !== null && volumeMa60[lastIndex - 1] !== null
      && volumeMa5[lastIndex - 1]! <= volumeMa60[lastIndex - 1]!
      && volumeMa5[lastIndex]! > volumeMa60[lastIndex]!;
    matched = volCross && currentMa <= currentPrice && currentPrice <= currentMa * 1.1
      && hasContinuousMa25Breakout(closes, ma25);
  }
  if (!matched) return null;

  const targetLabel = period === 200 ? "MA200" : period === 60 ? "MA60" : "MA25";
  const signals = { "1": "突破年線", "2": "突破季線", "3": "2560戰法", "4": "回落年線", "5": "回落季線", "6": "回落MA25" } as const;
  return {
    targetMA: round(currentMa),
    targetLabel,
    bias: round(((currentPrice - currentMa) / currentMa) * 100),
    retraces: countRetraces(closes, maSeries),
    volumeRatio: round(volumeRatio * 100),
    previousClose: previousPrice,
    previousVolume: Math.floor(previousVolume / 1000),
    signal: signals[type],
    maTrend: currentMa > previousMa ? "up" : currentMa < previousMa ? "down" : "flat",
  };
}

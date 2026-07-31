import type { CloudPriceRow } from "./cloudMarketData";

export interface SimulatedPricePoint {
  day: string;
  price: number;
  pct: number;
}

export interface SimulatedPriceProjection {
  aiStrength: "看多" | "中性" | "看空";
  aiScore: number;
  volatility: number;
  avgReturn: number;
  aiReason: string;
  aiOffset: string;
  predictions: SimulatedPricePoint[];
  isSimulated: true;
  disclaimer: string;
}

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

export function buildSimulatedPriceProjection(
  rows: Pick<CloudPriceRow, "close">[],
): SimulatedPriceProjection {
  if (rows.length < 20) {
    throw new Error("至少需要 20 根 Supabase K 線才能進行模擬推演");
  }

  const closes = rows.map((row) => Number(row.close)).filter(Number.isFinite);
  if (closes.length < 20 || closes.some((close) => close <= 0)) {
    throw new Error("Supabase K 線價格不足或格式錯誤");
  }

  const returns = closes.slice(1).map((close, index) => close / closes[index] - 1);
  const recentReturns = returns.slice(-20);
  const shortMean = recentReturns.slice(-5).reduce((sum, value) => sum + value, 0) / 5;
  const longMean = recentReturns.reduce((sum, value) => sum + value, 0) / recentReturns.length;
  const drift = clamp(shortMean * 0.6 + longMean * 0.4, -0.025, 0.025);
  const variance = recentReturns.reduce(
    (sum, value) => sum + (value - longMean) ** 2,
    0,
  ) / recentReturns.length;
  const volatility = Math.sqrt(variance);
  const lastPrice = closes.at(-1)!;
  const wave = [0.12, -0.08, 0.16, -0.05, 0.1];
  const predictions = wave.map((factor, index) => {
    const days = index + 1;
    const simulatedReturn = drift * days + volatility * factor;
    const price = lastPrice * (1 + simulatedReturn);
    return {
      day: `T+${days}`,
      price: Number(price.toFixed(2)),
      pct: Number((simulatedReturn * 100).toFixed(2)),
    };
  });
  const confidence = clamp(
    0.5 + Math.abs(drift) / Math.max(volatility, 0.005) * 0.1,
    0.5,
    0.78,
  );
  const aiStrength = drift > 0.001
    ? "看多"
    : drift < -0.001
      ? "看空"
      : "中性";

  return {
    aiStrength,
    aiScore: Number(confidence.toFixed(3)),
    volatility: Number((volatility * 100).toFixed(2)),
    avgReturn: Number((longMean * 100).toFixed(2)),
    aiReason: `依最近 20 個交易日報酬、短期動能與波動度進行固定公式推演；目前趨勢判定為${aiStrength}。`,
    aiOffset: "T+1～T+5 為技術模擬路徑，不是模型預測或投資建議。",
    predictions,
    isSimulated: true,
    disclaimer: "本結果使用 Supabase 真實 K 線進行技術模擬，不代表未來價格。",
  };
}

import { Router, type Request, type Response } from "express";
import { scanAndScoreStock } from "../../src/lib/strategy-engine";
import {
  fetchCloudCandidates,
  fetchCloudInstitutional,
  fetchCloudPrices,
  fetchCloudShareholding,
  latestCloudDate,
  mapWithConcurrency,
  type CloudInstitutionalRow,
  type CloudPriceRow,
} from "../lib/cloudMarketData";
import { buildSimulatedPriceProjection } from "../lib/priceProjection";

const router = Router();

function errorResponse(res: Response, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return res.status(503).json({ success: false, error: message });
}

function movingAverage(closes: number[], period: number): number | null {
  if (closes.length < period) return null;
  return closes.slice(-period).reduce((sum, value) => sum + value, 0) / period;
}

function countConsecutive(
  rows: CloudInstitutionalRow[],
  key: "foreign_net" | "trust_net",
): number {
  if (rows.length === 0) return 0;
  const positive = (rows[0][key] || 0) >= 0;
  let count = 0;
  for (const row of rows) {
    if (((row[key] || 0) >= 0) !== positive) break;
    count++;
  }
  return positive ? count : -count;
}

function analyzePattern(rows: CloudPriceRow[]) {
  const closes = rows.map((row) => row.close);
  const highs = rows.map((row) => row.high);
  const lows = rows.map((row) => row.low);
  let patternName = "無明顯型態";
  let patternDirection = "neutral";
  let neckline: number | null = null;
  let target: number | null = null;
  let stopLoss: number | null = null;
  let confidence = 0;

  if (rows.length >= 60) {
    const recentLows = lows.slice(-60);
    const recentHighs = highs.slice(-60);
    const low1 = Math.min(...recentLows.slice(0, 20));
    const low2 = Math.min(...recentLows.slice(20, 40));
    const midHigh = Math.max(...recentHighs.slice(15, 30));
    if (low1 > 0 && Math.abs(low1 - low2) / low1 < 0.03 && midHigh > low1 * 1.02) {
      patternName = "W底";
      patternDirection = "up";
      neckline = Number(midHigh.toFixed(2));
      target = Number((midHigh + midHigh - (low1 + low2) / 2).toFixed(2));
      stopLoss = Number((((low1 + low2) / 2) * 0.97).toFixed(2));
      confidence = 0.7;
    }
    const high1 = Math.max(...recentHighs.slice(0, 20));
    const high2 = Math.max(...recentHighs.slice(20, 40));
    const midLow = Math.min(...recentLows.slice(15, 30));
    if (high1 > 0 && Math.abs(high1 - high2) / high1 < 0.03 && midLow < high1 * 0.98) {
      patternName = "M頂";
      patternDirection = "down";
      neckline = Number(midLow.toFixed(2));
      target = Number((midLow - ((high1 + high2) / 2 - midLow)).toFixed(2));
      stopLoss = Number((((high1 + high2) / 2) * 1.03).toFixed(2));
      confidence = 0.7;
    }
  }
  return { patternName, patternDirection, neckline, target, stopLoss, confidence, dataPoints: closes.length };
}

function analyzeSupportResistance(rows: CloudPriceRow[]) {
  if (rows.length < 20) throw new Error("Insufficient Supabase price history");
  const highs = rows.map((row) => row.high);
  const lows = rows.map((row) => row.low);
  const lastClose = rows.at(-1)!.close;
  let atrSum = 0;
  const atrStart = Math.max(1, rows.length - 14);
  for (let index = atrStart; index < rows.length; index++) {
    atrSum += Math.max(
      rows[index].high - rows[index].low,
      Math.abs(rows[index].high - rows[index - 1].close),
      Math.abs(rows[index].low - rows[index - 1].close),
    );
  }
  const atr14 = atrSum / Math.max(1, rows.length - atrStart);
  const swingHighs: number[] = [];
  const swingLows: number[] = [];
  for (let index = 5; index < rows.length - 5; index++) {
    const window = rows.slice(index - 5, index + 6);
    if (window.every((row, offset) => offset === 5 || row.high < rows[index].high)) swingHighs.push(rows[index].high);
    if (window.every((row, offset) => offset === 5 || row.low > rows[index].low)) swingLows.push(rows[index].low);
  }
  const tolerance = Math.max(atr14 * 0.8, lastClose * 0.005);
  const cluster = (levels: number[], descending: boolean) => {
    const sorted = [...levels].sort((a, b) => a - b);
    const groups: Array<{ level: number; power: number }> = [];
    for (const level of sorted) {
      const existing = groups.at(-1);
      if (existing && Math.abs(existing.level - level) <= tolerance) {
        existing.level = (existing.level * existing.power + level) / (existing.power + 1);
        existing.power++;
      } else groups.push({ level, power: 1 });
    }
    const result = groups.map((item) => ({ level: Number(item.level.toFixed(2)), power: item.power }));
    return descending ? result.reverse() : result;
  };
  const recentHigh = Math.max(...highs.slice(-20));
  const recentLow = Math.min(...lows.slice(-20));
  const resistances = cluster([...swingHighs, recentHigh].filter((level) => level > lastClose), false);
  const supports = cluster([...swingLows, recentLow].filter((level) => level < lastClose), true);
  return {
    lastClose,
    atr14: Number(atr14.toFixed(2)),
    pressure: { near: resistances[0]?.level ?? null, mid: resistances[1]?.level ?? null, far: resistances[2]?.level ?? null },
    support: { near: supports[0]?.level ?? null, mid: supports[1]?.level ?? null, far: supports[2]?.level ?? null },
    resistances: resistances.slice(0, 6),
    supports: supports.slice(0, 6),
    recentHigh: Number(recentHigh.toFixed(2)),
    recentLow: Number(recentLow.toFixed(2)),
  };
}

router.get("/api/stock/:id/sr-analysis", async (req, res) => {
  try {
    return res.json({ success: true, data: analyzeSupportResistance(await fetchCloudPrices(req.params.id, 512)), source: "supabase" });
  } catch (error) {
    return errorResponse(res, error);
  }
});

router.get("/api/stock/:id/ma-analysis", async (req, res) => {
  try {
    const rows = await fetchCloudPrices(req.params.id, 512);
    const closes = rows.map((row) => row.close);
    if (closes.length < 200) throw new Error("Insufficient Supabase price history");
    const lastClose = closes.at(-1)!;
    const ma25 = movingAverage(closes, 25);
    const ma60 = movingAverage(closes, 60);
    const ma200 = movingAverage(closes, 200);
    const deduction = (period: number) => closes.at(-period) ?? null;
    const trend = (ma: number | null, old: number | null) =>
      !ma || !old ? "→ 走平" : lastClose > ma && old < ma ? "↑ 上揚" : lastClose < ma && old > ma ? "↓ 下彎" : "→ 走平";
    const tomorrow = (ma: number | null, old: number | null, period: number) => {
      if (!ma || !old) return "→";
      const next = ma + (lastClose - old) / period;
      return lastClose > next ? "↑" : lastClose < next ? "↓" : "→";
    };
    const d25 = deduction(25), d60 = deduction(60), d200 = deduction(200);
    const arrangement = ma25! > ma60! && ma60! > ma200! ? "多頭排列"
      : ma25! < ma60! && ma60! < ma200! ? "空頭排列" : "交叉整理";
    return res.json({
      success: true,
      source: "supabase",
      data: {
        lastClose,
        ma25: Number(ma25!.toFixed(2)), ma60: Number(ma60!.toFixed(2)), ma200: Number(ma200!.toFixed(2)),
        deduction25: d25, deduction60: d60, deduction200: d200,
        trend25: trend(ma25, d25), trend60: trend(ma60, d60), trend200: trend(ma200, d200),
        tomorrow25: tomorrow(ma25, d25, 25), tomorrow60: tomorrow(ma60, d60, 60), tomorrow200: tomorrow(ma200, d200, 200),
        bias: Number((((lastClose - ma60!) / ma60!) * 100).toFixed(2)),
        maGapPercent: Number((((ma60! - ma200!) / ma200!) * 100).toFixed(2)),
        arrangement,
      },
    });
  } catch (error) {
    return errorResponse(res, error);
  }
});

router.get("/api/stock/:id/chips-analysis", async (req, res) => {
  try {
    const [prices, institutional, shareholding] = await Promise.all([
      fetchCloudPrices(req.params.id, 1),
      fetchCloudInstitutional(req.params.id, 30),
      fetchCloudShareholding(req.params.id, 10),
    ]);
    const latestDate = prices.at(-1)?.date;
    if (!latestDate) throw new Error("No Supabase price data");
    const latestShare = shareholding[0];
    return res.json({
      success: true,
      source: "supabase",
      data: {
        latestDate,
        foreignConsecutive: countConsecutive(institutional, "foreign_net"),
        trustConsecutive: countConsecutive(institutional, "trust_net"),
        foreignTotal: Math.floor(institutional.reduce((sum, row) => sum + row.foreign_net, 0) / 1000),
        trustTotal: Math.floor(institutional.reduce((sum, row) => sum + row.trust_net, 0) / 1000),
        whaleRatio: latestShare?.whale_ratio ?? null,
        retailRatio: latestShare?.retail_ratio ?? null,
        totalShares: latestShare?.total_shares ?? null,
        chipHistory: institutional.slice(0, 10).map((row) => ({
          date: row.date.slice(5),
          foreign: Math.floor(row.foreign_net / 1000),
          trust: Math.floor(row.trust_net / 1000),
        })),
      },
    });
  } catch (error) {
    return errorResponse(res, error);
  }
});

router.get("/api/stock/:id/pattern-analysis", async (req, res) => {
  try {
    const rows = await fetchCloudPrices(req.params.id, 120);
    if (rows.length < 20) throw new Error("Insufficient Supabase price history");
    return res.json({ success: true, data: analyzePattern(rows), source: "supabase" });
  } catch (error) {
    return errorResponse(res, error);
  }
});

router.get("/api/stock/:id/prediction-analysis", async (req, res) => {
  try {
    const rows = await fetchCloudPrices(req.params.id, 60);
    return res.json({
      success: true,
      data: buildSimulatedPriceProjection(rows),
      source: "supabase",
    });
  } catch (error) {
    return errorResponse(res, error);
  }
});

async function scanCandidates(req: Request) {
  const minVolume = Math.max(0, Number.parseInt(String(req.query.min_volume || "500"), 10));
  const date = await latestCloudDate("stock_price");
  return date ? fetchCloudCandidates(date, minVolume, 200) : [];
}

router.get("/api/strategy/sr-scan", async (req, res) => {
  try {
    const candidates = await scanCandidates(req);
    const scored = await mapWithConcurrency(candidates, 8, async (candidate) => {
      try {
        return scanAndScoreStock(await fetchCloudPrices(candidate.stock_id, 512), candidate.stock_id, candidate.stock_name);
      } catch {
        return null;
      }
    });
    const results = scored.filter((row) => row !== null);
    results.sort(String(req.query.sort || "1") === "1" ? (a, b) => a!.dist - b!.dist : (a, b) => b!.amount - a!.amount);
    return res.json({ success: true, data: results.slice(0, 40), source: "supabase" });
  } catch (error) {
    return errorResponse(res, error);
  }
});

router.get("/api/strategy/ma-scan", async (req, res) => {
  try {
    const type = String(req.query.type || "1");
    const period = type === "1" ? 200 : 60;
    const label = type === "1" ? "年線(200MA)" : type === "2" ? "季線(60MA)" : "2560戰法";
    const candidates = await scanCandidates(req);
    const scanned = await mapWithConcurrency(candidates, 8, async (candidate) => {
      const closes = (await fetchCloudPrices(candidate.stock_id, 512)).map((row) => row.close);
      const ma = movingAverage(closes, period);
      if (!ma) return null;
      const bias = ((candidate.close - ma) / ma) * 100;
      if (bias < 0 || (type === "3" && bias > 5)) return null;
      return {
        stock_id: candidate.stock_id, stock_name: candidate.stock_name, close: candidate.close,
        volume: Math.floor(candidate.volume / 1000),
        amount: Number(((candidate.close * candidate.volume) / 1e8).toFixed(2)),
        targetMA: Number(ma.toFixed(2)), targetLabel: label, bias: Number(bias.toFixed(2)),
        touchCount: closes.filter((close) => Math.abs(close - ma) / ma < 0.005).length,
      };
    });
    const results = scanned.filter((row) => row !== null);
    results.sort(String(req.query.sort || "1") === "1"
      ? (a, b) => Math.abs(a!.bias) - Math.abs(b!.bias)
      : (a, b) => b!.amount - a!.amount);
    return res.json({ success: true, data: results.slice(0, 40), source: "supabase" });
  } catch (error) {
    return errorResponse(res, error);
  }
});

router.get("/api/strategy/chips-scan", async (req, res) => {
  try {
    const type = String(req.query.type || "1");
    const candidates = await scanCandidates(req);
    const scanned = await mapWithConcurrency(candidates, 8, async (candidate) => {
      const [institutional, shareholding] = await Promise.all([
        fetchCloudInstitutional(candidate.stock_id, 10),
        type === "3" ? fetchCloudShareholding(candidate.stock_id, 1) : Promise.resolve([]),
      ]);
      const key = type === "1" ? "trust_net" : "foreign_net";
      const label = type === "1" ? "投信" : type === "2" ? "外資" : "大戶比率";
      const consecutive = type === "3"
        ? Math.floor(shareholding[0]?.whale_ratio || 0)
        : countConsecutive(institutional, key);
      const netTotal = type === "3"
        ? shareholding[0]?.whale_ratio || 0
        : institutional.reduce((sum, row) => sum + row[key as "trust_net" | "foreign_net"], 0) / 1000;
      if (type !== "3" && Math.abs(consecutive) < 1) return null;
      return {
        stock_id: candidate.stock_id, stock_name: candidate.stock_name, close: candidate.close,
        volume: Math.floor(candidate.volume / 1000),
        amount: Number(((candidate.close * candidate.volume) / 1e8).toFixed(2)),
        consecutive, netTotal: Math.floor(netTotal), type: label,
      };
    });
    const results = scanned.filter((row) => row !== null);
    results.sort(String(req.query.sort || "1") === "1"
      ? (a, b) => Math.abs(b!.consecutive) - Math.abs(a!.consecutive)
      : (a, b) => b!.amount - a!.amount);
    return res.json({ success: true, data: results.slice(0, 40), source: "supabase" });
  } catch (error) {
    return errorResponse(res, error);
  }
});

router.get("/api/strategy/pattern-scan", async (req, res) => {
  try {
    const candidates = await scanCandidates(req);
    const scanned = await mapWithConcurrency(candidates, 8, async (candidate) => {
      const pattern = analyzePattern(await fetchCloudPrices(candidate.stock_id, 120));
      if (pattern.confidence === 0) return null;
      return {
        stock_id: candidate.stock_id, stock_name: candidate.stock_name, close: candidate.close,
        volume: Math.floor(candidate.volume / 1000),
        amount: Number(((candidate.close * candidate.volume) / 1e8).toFixed(2)),
        patternName: pattern.patternName, confidence: pattern.confidence,
      };
    });
    const results = scanned.filter((row) => row !== null);
    results.sort(String(req.query.sort || "1") === "1"
      ? (a, b) => b!.confidence - a!.confidence
      : (a, b) => b!.amount - a!.amount);
    return res.json({ success: true, data: results.slice(0, 40), source: "supabase" });
  } catch (error) {
    return errorResponse(res, error);
  }
});

router.get("/api/strategy/prediction-scan", (_req, res) => res.status(410).json({
  success: false,
  error: "合成股價預測掃描已停用",
}));

export default router;

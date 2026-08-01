import { Router, type Request, type Response } from "express";
import { scanAndScoreStock } from "../../src/lib/strategy-engine";
import { buildSupportResistanceLines } from "../../src/lib/trendLines";
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
import { analyzeChartPattern } from "../lib/patternStrategy";
import { fetchInstitutionalHoldingSnapshot } from "../lib/institutionalHoldings";
import {
  analyzeMovingAverage,
  scanMovingAverage,
  type MovingAverageScanType,
} from "../lib/maStrategy";

const router = Router();

function errorResponse(res: Response, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return res.status(503).json({ success: false, error: message });
}

function countConsecutive(
  rows: CloudInstitutionalRow[],
  key: "foreign_net" | "trust_net",
): number {
  if (rows.length === 0) return 0;
  const first = rows[0][key] || 0;
  if (first === 0) return 0;
  const positive = first > 0;
  let count = 0;
  for (const row of rows) {
    const value = row[key] || 0;
    if ((positive && value <= 0) || (!positive && value >= 0)) break;
    count++;
  }
  return positive ? count : -count;
}

function consecutiveNetTotal(
  rows: CloudInstitutionalRow[],
  key: "foreign_net" | "trust_net",
  consecutive: number,
): number {
  return rows.slice(0, Math.abs(consecutive)).reduce((sum, row) => sum + row[key], 0) / 1000;
}

function analyzeSupportResistance(rows: CloudPriceRow[]) {
  if (rows.length < 60) throw new Error("Insufficient Supabase price history");
  const highs = rows.map((row) => row.high);
  const lows = rows.map((row) => row.low);
  const lastClose = rows.at(-1)!.close;
  const visibleRows = rows.slice(-61);
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
  const recentHigh = Math.max(...highs.slice(-20));
  const recentLow = Math.min(...lows.slice(-20));
  const endIndex = rows.length - 1;
  const lines = buildSupportResistanceLines(rows, endIndex);
  const shortResistance = lines.shortResistance[endIndex];
  const shortSupport = lines.shortSupport[endIndex];
  const longResistance = lines.longResistance[endIndex];
  const longSupport = lines.longSupport[endIndex];
  const vwapRows = rows.slice(-20);
  const totalVolume = vwapRows.reduce((sum, row) => sum + row.volume, 0);
  const vwap = totalVolume > 0
    ? vwapRows.reduce((sum, row) => sum + ((row.high + row.low + row.close) / 3) * row.volume, 0) / totalVolume
    : null;
  const visibleHighs = visibleRows.map((row) => row.high);
  const visibleLows = visibleRows.map((row) => row.low);
  const swingHigh = Math.max(...visibleHighs);
  const swingLow = Math.min(...visibleLows);
  const poc = calculatePointOfControl(visibleRows);
  const round = (value: number | null) => value === null ? null : Number(value.toFixed(2));
  return {
    lastClose,
    atr14: Number(atr14.toFixed(2)),
    vwap: round(vwap),
    poc: round(poc),
    shortResistance: round(shortResistance),
    shortSupport: round(shortSupport),
    longResistance: round(longResistance),
    longSupport: round(longSupport),
    swingHigh: round(swingHigh),
    swingLow: round(swingLow),
    pressure: { near: round(recentHigh), mid: round(shortResistance), far: round(longResistance) },
    support: { near: round(recentLow), mid: round(shortSupport), far: round(longSupport) },
    resistances: [recentHigh, shortResistance, longResistance]
      .filter((value): value is number => value !== null)
      .map((level) => ({ level: round(level)!, power: 1 })),
    supports: [recentLow, shortSupport, longSupport]
      .filter((value): value is number => value !== null)
      .map((level) => ({ level: round(level)!, power: 1 })),
    recentHigh: Number(recentHigh.toFixed(2)),
    recentLow: Number(recentLow.toFixed(2)),
  };
}

function calculatePointOfControl(rows: CloudPriceRow[], binCount = 15): number | null {
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
  const maxVolume = Math.max(...volumes);
  const maxVolumeIndex = volumes.indexOf(maxVolume);
  return minPrice + (maxVolumeIndex + 0.5) * binWidth;
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
    return res.json({
      success: true,
      source: "supabase",
      data: analyzeMovingAverage(rows),
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
    const previousShare = shareholding[1];
    const whaleChange = latestShare && previousShare
      ? Number((latestShare.whale_ratio - previousShare.whale_ratio).toFixed(2)) : null;
    const peopleChange = latestShare?.total_people !== null && latestShare?.total_people !== undefined
      && previousShare?.total_people !== null && previousShare?.total_people !== undefined
      ? latestShare.total_people - previousShare.total_people : null;
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
        whaleChange,
        totalPeople: latestShare?.total_people ?? null,
        peopleChange,
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

router.get("/api/stock/:id/institutional-holdings", async (req, res) => {
  try {
    const data = await fetchInstitutionalHoldingSnapshot(req.params.id);
    return res.json({ success: true, source: "tw-institutional-stocker", data });
  } catch (error) {
    return errorResponse(res, error);
  }
});

router.get("/api/stock/:id/pattern-analysis", async (req, res) => {
  try {
    const rows = await fetchCloudPrices(req.params.id, 120);
    if (rows.length < 30) throw new Error("Insufficient Supabase price history");
    return res.json({ success: true, data: analyzeChartPattern(rows), source: "supabase" });
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
    const requestedType = String(req.query.type || "1");
    const type: MovingAverageScanType = ["1", "2", "3", "4", "5", "6"].includes(requestedType)
      ? requestedType as MovingAverageScanType : "1";
    const candidates = await scanCandidates(req);
    const scanned = await mapWithConcurrency(candidates, 8, async (candidate) => {
      const match = scanMovingAverage(await fetchCloudPrices(candidate.stock_id, 512), type);
      if (!match) return null;
      return {
        stock_id: candidate.stock_id, stock_name: candidate.stock_name, close: candidate.close,
        volume: Math.floor(candidate.volume / 1000),
        amount: Number(((candidate.close * candidate.volume) / 1e8).toFixed(2)),
        ...match,
      };
    });
    const results = scanned.filter((row) => row !== null);
    results.sort(String(req.query.sort || "1") === "1"
      ? (a, b) => Math.abs(a!.bias) - Math.abs(b!.bias)
      : (a, b) => b!.volumeRatio - a!.volumeRatio);
    return res.json({ success: true, data: results.slice(0, 40), source: "supabase" });
  } catch (error) {
    return errorResponse(res, error);
  }
});

router.get("/api/strategy/chips-scan", async (req, res) => {
  try {
    const type = String(req.query.type || "1");
    const minimumDays = Math.max(1, Number.parseInt(String(req.query.n_days || "2"), 10) || 2);
    const candidates = await scanCandidates(req);
    const scanned = await mapWithConcurrency(candidates, 8, async (candidate) => {
      const [institutional, shareholding] = await Promise.all([
        type === "3" ? Promise.resolve([]) : fetchCloudInstitutional(candidate.stock_id, 30),
        type === "3" ? fetchCloudShareholding(candidate.stock_id, 2) : Promise.resolve([]),
      ]);
      if (type === "3") {
        const [latest, previous] = shareholding;
        if (!latest || !previous || latest.total_people === null || previous.total_people === null) return null;
        const whaleChange = latest.whale_ratio - previous.whale_ratio;
        const peopleChange = latest.total_people - previous.total_people;
        if (whaleChange <= 0 || peopleChange >= 0) return null;
        return {
          stock_id: candidate.stock_id, stock_name: candidate.stock_name, close: candidate.close,
          volume: Math.floor(candidate.volume / 1000),
          amount: Number(((candidate.close * candidate.volume) / 1e8).toFixed(2)),
          consecutive: 0, netTotal: 0, type: "集保大戶",
          whaleRatio: latest.whale_ratio, whaleChange, totalPeople: latest.total_people,
          peopleChange, latestDate: latest.date, previousDate: previous.date,
        };
      }
      const key = type === "1" ? "trust_net" : "foreign_net";
      const label = type === "1" ? "投信" : "外資";
      const consecutive = countConsecutive(institutional, key);
      if (consecutive < minimumDays) return null;
      const netTotal = consecutiveNetTotal(institutional, key, consecutive);
      return {
        stock_id: candidate.stock_id, stock_name: candidate.stock_name, close: candidate.close,
        volume: Math.floor(candidate.volume / 1000),
        amount: Number(((candidate.close * candidate.volume) / 1e8).toFixed(2)),
        consecutive, netTotal: Math.floor(netTotal), type: label,
      };
    });
    const results = scanned.filter((row) => row !== null);
    const sort = String(req.query.sort || "1");
    results.sort(type === "3"
      ? sort === "1"
        ? (a, b) => (b!.whaleChange || 0) - (a!.whaleChange || 0)
        : (a, b) => (a!.peopleChange || 0) - (b!.peopleChange || 0)
      : sort === "1"
        ? (a, b) => a!.consecutive - b!.consecutive || a!.netTotal - b!.netTotal
        : (a, b) => b!.consecutive - a!.consecutive || b!.netTotal - a!.netTotal);
    return res.json({ success: true, data: results.slice(0, 40), source: "supabase" });
  } catch (error) {
    return errorResponse(res, error);
  }
});

router.get("/api/strategy/pattern-scan", async (req, res) => {
  try {
    const candidates = await scanCandidates(req);
    const scanned = await mapWithConcurrency(candidates, 8, async (candidate) => {
      const pattern = analyzeChartPattern(await fetchCloudPrices(candidate.stock_id, 120));
      if (pattern.confidence === 0) return null;
      return {
        stock_id: candidate.stock_id, stock_name: candidate.stock_name, close: candidate.close,
        volume: Math.floor(candidate.volume / 1000),
        amount: Number(((candidate.close * candidate.volume) / 1e8).toFixed(2)),
        patternName: pattern.patternName, stage: pattern.stage, confidence: pattern.confidence,
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

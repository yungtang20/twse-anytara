import { Router, type Request, type Response } from "express";
import { scanAndScoreStock } from "../../src/lib/strategy-engine";
import {
  fetchCloudCandidates,
  fetchCloudInstitutionalHistories,
  fetchCloudPriceHistories,
  fetchCloudPrices,
  fetchCloudShareholdingHistories,
  latestCloudDate,
  type CloudInstitutionalRow,
  type CloudShareholdingRow,
} from "../lib/cloudMarketData";
import {
  consecutiveNetTotal,
  countConsecutive,
  runStockStrategyRaw,
} from "../lib/stockStrategyResearch";
import { buildSimulatedPriceProjection } from "../lib/priceProjection";
import { analyzeChartPattern } from "../lib/patternStrategy";
import { fetchInstitutionalHoldingSnapshot } from "../lib/institutionalHoldings";
import {
  scanMovingAverage,
  type MovingAverageScanType,
} from "../lib/maStrategy";
import { applyTradeRiskPolicy } from "../lib/tradeRisks";

const router = Router();

function errorResponse(res: Response, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return res.status(503).json({ success: false, error: message });
}

router.get("/api/stock/:id/sr-analysis", async (req, res) => {
  try {
    return res.json({ success: true, data: await runStockStrategyRaw(req.params.id, "sr"), source: "supabase" });
  } catch (error) {
    return errorResponse(res, error);
  }
});

router.get("/api/stock/:id/ma-analysis", async (req, res) => {
  try {
    return res.json({
      success: true,
      source: "supabase",
      data: await runStockStrategyRaw(req.params.id, "ma"),
    });
  } catch (error) {
    return errorResponse(res, error);
  }
});

router.get("/api/stock/:id/chips-analysis", async (req, res) => {
  try {
    return res.json({
      success: true,
      source: "supabase",
      data: await runStockStrategyRaw(req.params.id, "chips"),
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
    return res.json({ success: true, data: await runStockStrategyRaw(req.params.id, "pattern"), source: "supabase" });
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

function includeDisposition(req: Request): boolean {
  return String(req.query.include_disposition || "false") === "true";
}

router.get("/api/strategy/sr-scan", async (req, res) => {
  try {
    const candidates = await scanCandidates(req);
    const histories = await fetchCloudPriceHistories(candidates.map((candidate) => candidate.stock_id), 512);
    const scored = candidates.map((candidate) => {
      try {
        return scanAndScoreStock(histories.get(candidate.stock_id) ?? [], candidate.stock_id, candidate.stock_name);
      } catch {
        return null;
      }
    });
    const results = scored.filter((row) => row !== null);
    results.sort(String(req.query.sort || "1") === "1" ? (a, b) => a!.dist - b!.dist : (a, b) => b!.amount - a!.amount);
    const policy = await applyTradeRiskPolicy(results, includeDisposition(req));
    return res.json({ success: true, data: policy.items.slice(0, 40), source: "supabase", riskPolicy: policy.riskPolicy, riskDataAsOf: policy.riskDataAsOf, riskDataSource: policy.riskDataSource });
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
    const histories = await fetchCloudPriceHistories(candidates.map((candidate) => candidate.stock_id), 512);
    const scanned = candidates.map((candidate) => {
      const match = scanMovingAverage(histories.get(candidate.stock_id) ?? [], type);
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
    const policy = await applyTradeRiskPolicy(results, includeDisposition(req));
    return res.json({ success: true, data: policy.items.slice(0, 40), source: "supabase", riskPolicy: policy.riskPolicy, riskDataAsOf: policy.riskDataAsOf, riskDataSource: policy.riskDataSource });
  } catch (error) {
    return errorResponse(res, error);
  }
});

router.get("/api/strategy/chips-scan", async (req, res) => {
  try {
    const type = String(req.query.type || "1");
    const minimumDays = Math.max(1, Number.parseInt(String(req.query.n_days || "2"), 10) || 2);
    const candidates = await scanCandidates(req);
    const ids = candidates.map((candidate) => candidate.stock_id);
    const [institutionalHistories, shareholdingHistories] = await Promise.all([
      type === "3"
        ? Promise.resolve(new Map<string, CloudInstitutionalRow[]>())
        : fetchCloudInstitutionalHistories(ids, 30),
      // Fetch more than 2 so we can pick the two most recent official weeks.
      type === "3"
        ? fetchCloudShareholdingHistories(ids, 12)
        : Promise.resolve(new Map<string, CloudShareholdingRow[]>()),
    ]);
    const scanned = candidates.map((candidate) => {
      const institutional = institutionalHistories.get(candidate.stock_id) ?? [];
      const shareholding = shareholdingHistories.get(candidate.stock_id) ?? [];
      if (type === "3") {
        // Strategy requires total_people. Filter to official rows only, never trust partial bootstrap.
        const official = shareholding.filter(
          (row) => row.total_people !== null && row.total_people !== undefined
            && row.source !== "goodinfo_tdcc_bootstrap",
        );
        const [latest, previous] = official;
        if (!latest || !previous) {
          return {
            stock_id: candidate.stock_id, stock_name: candidate.stock_name, close: candidate.close,
            volume: Math.floor(candidate.volume / 1000),
            amount: Number(((candidate.close * candidate.volume) / 1e8).toFixed(2)),
            consecutive: 0, netTotal: 0, type: "集保大戶",
            whaleRatio: null, whaleChange: null, totalPeople: null,
            peopleChange: null, latestDate: null, previousDate: null,
            insufficient_tdcc_people_history: true,
          };
        }
        const whaleChange = latest.whale_ratio - previous.whale_ratio;
        // official rows are guaranteed total_people !== null by the filter above.
        const peopleChange = (latest.total_people as number) - (previous.total_people as number);
        if (whaleChange <= 0 || peopleChange >= 0) return null;
        return {
          stock_id: candidate.stock_id, stock_name: candidate.stock_name, close: candidate.close,
          volume: Math.floor(candidate.volume / 1000),
          amount: Number(((candidate.close * candidate.volume) / 1e8).toFixed(2)),
          consecutive: 0, netTotal: 0, type: "集保大戶",
          whaleRatio: latest.whale_ratio, whaleChange, totalPeople: latest.total_people,
          peopleChange, latestDate: latest.date, previousDate: previous.date,
          insufficient_tdcc_people_history: false,
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
    const policy = await applyTradeRiskPolicy(results, includeDisposition(req));
    return res.json({ success: true, data: policy.items.slice(0, 40), source: "supabase", riskPolicy: policy.riskPolicy, riskDataAsOf: policy.riskDataAsOf, riskDataSource: policy.riskDataSource });
  } catch (error) {
    return errorResponse(res, error);
  }
});

router.get("/api/strategy/pattern-scan", async (req, res) => {
  try {
    const candidates = await scanCandidates(req);
    const histories = await fetchCloudPriceHistories(candidates.map((candidate) => candidate.stock_id), 120);
    const scanned = candidates.map((candidate) => {
      const pattern = analyzeChartPattern(histories.get(candidate.stock_id) ?? []);
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
    const policy = await applyTradeRiskPolicy(results, includeDisposition(req));
    return res.json({ success: true, data: policy.items.slice(0, 40), source: "supabase", riskPolicy: policy.riskPolicy, riskDataAsOf: policy.riskDataAsOf, riskDataSource: policy.riskDataSource });
  } catch (error) {
    return errorResponse(res, error);
  }
});

router.get("/api/strategy/prediction-scan", (_req, res) => res.status(410).json({
  success: false,
  error: "合成股價預測掃描已停用",
}));

export default router;

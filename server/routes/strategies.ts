import { Router, type Request, type Response } from "express";
import { scanAndScoreStock } from "../../src/lib/strategy-engine";
import { getDb } from "../db";

const router = Router();

function fetchEngineRows(stockId: string): any[] {
  const db = getDb();
  if (!db) return [];
  return db.prepare(
    "SELECT date, open, high, low, close, volume FROM stock_price WHERE stock_id = ? ORDER BY date DESC LIMIT 1000"
  ).all(stockId).reverse();
}

// ── Strategy Analysis APIs

// Support/Resistance Analysis
router.get("/api/stock/:id/sr-analysis", async (req: Request, res: Response) => {
  const db = getDb();
  if (!db) return res.json({ success: false, error: "DB not connected" });
  const id = req.params.id;
  try {
    const latest = db.prepare("SELECT date, close FROM stock_price WHERE stock_id = ? ORDER BY date DESC LIMIT 1").get(id) as any;
    if (!latest) return res.json({ success: false, error: "No price data" });

    const rows = db.prepare(
      "SELECT date, open, high, low, close, volume FROM stock_price WHERE stock_id = ? ORDER BY date DESC LIMIT 1000"
    ).all(id).reverse() as any[];

    if (rows.length < 20) return res.json({ success: false, error: "Insufficient data" });

    const closes = rows.map((r: any) => r.close);
    const highs = rows.map((r: any) => r.high);
    const lows = rows.map((r: any) => r.low);
    const lastClose = closes[closes.length - 1];

    const atrPeriod = 14;
    let atrSum = 0;
    const atrStart = Math.max(1, rows.length - atrPeriod);
    for (let i = atrStart; i < rows.length; i++) {
      const tr = Math.max(
        rows[i].high - rows[i].low,
        Math.abs(rows[i].high - rows[i - 1].close),
        Math.abs(rows[i].low - rows[i - 1].close)
      );
      atrSum += tr;
    }
    const atr14 = atrSum / (rows.length - atrStart);

    const swingHighs: number[] = [];
    const swingLows: number[] = [];
    const swingLeft = 5, swingRight = 5;
    for (let i = swingLeft; i < rows.length - swingRight; i++) {
      let isHigh = true, isLow = true;
      for (let j = i - swingLeft; j <= i + swingRight; j++) {
        if (j === i) continue;
        if (rows[j].high >= rows[i].high) isHigh = false;
        if (rows[j].low <= rows[i].low) isLow = false;
      }
      if (isHigh) swingHighs.push(rows[i].high);
      if (isLow) swingLows.push(rows[i].low);
    }

    const recentWindow = Math.min(20, rows.length);
    const recentHigh = Math.max(...highs.slice(-recentWindow));
    const recentLow = Math.min(...lows.slice(-recentWindow));

    const atrTol = atr14 * 0.8;
    const allLevels = [...new Set([...swingHighs, ...swingLows, recentHigh, recentLow])].sort((a, b) => a - b);

    const clusterLevels = (levels: number[], tolerance: number) => {
      if (levels.length === 0) return [];
      const clusters: { level: number; count: number }[] = [];
      let current = { level: levels[0], count: 1 };
      for (let i = 1; i < levels.length; i++) {
        if (Math.abs(levels[i] - current.level) <= tolerance) {
          current.count++;
          current.level = (current.level * (current.count - 1) + levels[i]) / current.count;
        } else {
          clusters.push({ ...current });
          current = { level: levels[i], count: 1 };
        }
      }
      clusters.push(current);
      return clusters;
    };

    const resistanceRaw = allLevels.filter(l => l > lastClose);
    const supportRaw = allLevels.filter(l => l < lastClose);
    const resistances = clusterLevels(resistanceRaw, atrTol).sort((a, b) => a.level - b.level);
    const supports = clusterLevels(supportRaw, atrTol).sort((a, b) => b.level - a.level);

    const safeAtr14 = atr14 > 0 ? atr14 : Math.max(lastClose * 0.01, 0.1);
    const minGap = Math.max(lastClose * 0.005, 0.05, safeAtr14 * 0.8);

    const filteredResistances: number[] = [];
    for (const r of resistances) {
      const val = parseFloat(r.level.toFixed(2));
      if (val > lastClose) {
        const tooClose = filteredResistances.some(existing => Math.abs(existing - val) < minGap);
        if (!tooClose) {
          filteredResistances.push(val);
        }
      }
    }
    filteredResistances.sort((a, b) => a - b);

    const filteredSupports: number[] = [];
    for (const s of supports) {
      const val = parseFloat(s.level.toFixed(2));
      if (val < lastClose) {
        const tooClose = filteredSupports.some(existing => Math.abs(existing - val) < minGap);
        if (!tooClose) {
          filteredSupports.push(val);
        }
      }
    }
    filteredSupports.sort((a, b) => b - a);

    const finalResistancesList: { level: number; power: number }[] = [];
    const seenResLevels = new Set<string>();
    for (const r of resistances) {
      const rounded = parseFloat(r.level.toFixed(2));
      const key = rounded.toFixed(2);
      if (!seenResLevels.has(key)) {
        seenResLevels.add(key);
        finalResistancesList.push({ level: rounded, power: r.count });
      }
    }

    const finalSupportsList: { level: number; power: number }[] = [];
    const seenSupLevels = new Set<string>();
    for (const s of supports) {
      const rounded = parseFloat(s.level.toFixed(2));
      const key = rounded.toFixed(2);
      if (!seenSupLevels.has(key)) {
        seenSupLevels.add(key);
        finalSupportsList.push({ level: rounded, power: s.count });
      }
    }

    res.json({
      success: true,
      data: {
        lastClose,
        atr14: parseFloat(atr14.toFixed(2)),
        pressure: {
          near: filteredResistances[0] ?? null,
          mid: filteredResistances[1] ?? null,
          far: filteredResistances[2] ?? null,
        },
        support: {
          near: filteredSupports[0] ?? null,
          mid: filteredSupports[1] ?? null,
          far: filteredSupports[2] ?? null,
        },
        resistances: finalResistancesList.slice(0, 6),
        supports: finalSupportsList.slice(0, 6),
        recentHigh: parseFloat(recentHigh.toFixed(2)),
        recentLow: parseFloat(recentLow.toFixed(2)),
      }
    });
  } catch (err: any) {
    res.json({ success: false, error: err.message });
  }
});

// MA Trend Analysis with Deduction
router.get("/api/stock/:id/ma-analysis", async (req: Request, res: Response) => {
  const db = getDb();
  if (!db) return res.json({ success: false, error: "DB not connected" });
  const id = req.params.id;
  try {
    const rows = db.prepare(
      "SELECT date, close FROM stock_price WHERE stock_id = ? ORDER BY date DESC LIMIT 1000"
    ).all(id).reverse() as any[];

    if (rows.length < 200) return res.json({ success: false, error: "Insufficient data" });

    const closes = rows.map((r: any) => r.close);
    const lastClose = closes[closes.length - 1];

    const calcMA = (period: number) => {
      if (closes.length < period) return null;
      return parseFloat((closes.slice(-period).reduce((a, b) => a + b, 0) / period).toFixed(2));
    };

    const ma25 = calcMA(25);
    const ma60 = calcMA(60);
    const ma200 = calcMA(200);

    const deduction25 = closes.length >= 25 ? closes[closes.length - 25] : null;
    const deduction60 = closes.length >= 60 ? closes[closes.length - 60] : null;
    const deduction200 = closes.length >= 200 ? closes[closes.length - 200] : null;

    const getTrend = (ma: number | null, deduction: number | null) => {
      if (!ma || !deduction) return '→ 走平';
      if (lastClose > ma && deduction < ma) return '↑ 上揚';
      if (lastClose < ma && deduction > ma) return '↓ 下彎';
      return '→ 走平';
    };

    const trend25 = getTrend(ma25, deduction25);
    const trend60 = getTrend(ma60, deduction60);
    const trend200 = getTrend(ma200, deduction200);

    const getTomorrow = (ma: number | null, deduction: number | null, period: number) => {
      if (!ma || !deduction) return '→';
      const nextMA = ma + (lastClose - deduction) / period;
      if (lastClose > nextMA) return '↑';
      if (lastClose < nextMA) return '↓';
      return '→';
    };

    const bias = ma60 ? parseFloat(((lastClose - ma60) / ma60 * 100).toFixed(2)) : 0;
    const maGapPercent = ma200 && ma60 ? parseFloat(((ma60 - ma200) / ma200 * 100).toFixed(2)) : 0;

    let arrangement = '空頭排列';
    if (ma25 && ma60 && ma200) {
      if (ma25 > ma60 && ma60 > ma200) arrangement = '多頭排列';
      else if (ma25 < ma60 && ma60 < ma200) arrangement = '空頭排列';
      else arrangement = '交叉整理';
    }

    res.json({
      success: true,
      data: {
        lastClose,
        ma25,
        ma60,
        ma200,
        deduction25: deduction25 ? parseFloat(deduction25.toFixed(2)) : null,
        deduction60: deduction60 ? parseFloat(deduction60.toFixed(2)) : null,
        deduction200: deduction200 ? parseFloat(deduction200.toFixed(2)) : null,
        trend25,
        trend60,
        trend200,
        tomorrow25: getTomorrow(ma25, deduction25, 25),
        tomorrow60: getTomorrow(ma60, deduction60, 60),
        tomorrow200: getTomorrow(ma200, deduction200, 200),
        bias,
        maGapPercent,
        arrangement,
      }
    });
  } catch (err: any) {
    res.json({ success: false, error: err.message });
  }
});

// Chips Strategy
router.get("/api/stock/:id/chips-analysis", async (req: Request, res: Response) => {
  const db = getDb();
  if (!db) return res.json({ success: false, error: "DB not connected" });
  const id = req.params.id;
  try {
    const latestRow = db.prepare("SELECT MAX(date) as d FROM stock_price WHERE stock_id = ?").get(id) as any;
    if (!latestRow?.d) return res.json({ success: false, error: "No data" });
    const latestDate = latestRow.d;

    const instRows = db.prepare(
      "SELECT date, foreign_net, trust_net, dealer_net FROM stock_institutional WHERE stock_id = ? ORDER BY date DESC LIMIT 30"
    ).all(id) as any[];

    const countConsecutive = (key: "foreign_net" | "trust_net") => {
      if (instRows.length === 0) return 0;
      const positive = (instRows[0][key] || 0) >= 0;
      let count = 0;
      for (const row of instRows) {
        if (((row[key] || 0) >= 0) !== positive) break;
        count++;
      }
      return positive ? count : -count;
    };
    const foreignConsecutive = countConsecutive("foreign_net");
    const trustConsecutive = countConsecutive("trust_net");
    const foreignTotal = instRows.reduce((sum, row) => sum + (row.foreign_net || 0), 0);
    const trustTotal = instRows.reduce((sum, row) => sum + (row.trust_net || 0), 0);

    const shareRows = db.prepare(
      "SELECT date, whale_ratio, retail_ratio, total_shares FROM tdcc_shareholding WHERE stock_id = ? ORDER BY date DESC LIMIT 10"
    ).all(id);
    const latestShare = shareRows.length > 0 ? shareRows[0] : null;

    const chipHistory = instRows.slice(0, 10).map((r: any) => {
      const dp = (r.date || '').split('-');
      return {
        date: dp.length >= 3 ? `${dp[1]}-${dp[2]}` : r.date,
        foreign: Math.floor((r.foreign_net || 0) / 1000),
        trust: Math.floor((r.trust_net || 0) / 1000),
      };
    });

    res.json({
      success: true,
      data: {
        latestDate,
        foreignConsecutive,
        trustConsecutive,
        foreignTotal: Math.floor(foreignTotal / 1000),
        trustTotal: Math.floor(trustTotal / 1000),
        whaleRatio: latestShare ? (latestShare as any).whale_ratio : null,
        retailRatio: latestShare ? (latestShare as any).retail_ratio : null,
        totalShares: latestShare ? (latestShare as any).total_shares : null,
        chipHistory,
      }
    });
  } catch (err: any) {
    res.json({ success: false, error: err.message });
  }
});

// Retired until a real, calibrated prediction model is integrated.
router.get("/api/stock/:id/prediction-analysis", (_req, res) => res.status(410).json({
  success: false,
  error: "合成股價預測已停用",
}));

// SR Market Scan
router.get("/api/strategy/sr-scan", async (req: Request, res: Response) => {
  const db = getDb();
  if (!db) return res.json({ success: false, error: "DB not connected" });
  const minVolume = parseInt(String(req.query.min_volume || "500"));
  const sortBy = String(req.query.sort || "1");
  const limit = Math.min(parseInt(String(req.query.limit || "40")), 100);
  try {
    const latestDate = (db.prepare("SELECT MAX(date) as d FROM stock_price").get() as any)?.d;
    if (!latestDate) return res.json({ success: false, data: [] });
    const candidates = db.prepare(`
      SELECT s.stock_id, m.stock_name, s.close, s.volume, (s.close * s.volume) as amount
      FROM stock_price s
      JOIN stock_meta m ON s.stock_id = m.stock_id
      WHERE s.date = ? AND s.volume >= ? AND s.stock_id GLOB '[1-9][0-9][0-9][0-9]'
      ORDER BY s.volume DESC
      LIMIT 300
    `).all(latestDate, minVolume) as any[];

    const results: any[] = [];
    for (const c of candidates) {
      await new Promise(r => setImmediate(r)); // Yield event loop to avoid blocking
      try {
        const rows = fetchEngineRows(c.stock_id);
        if (rows.length < 60) continue;
        const score = scanAndScoreStock(rows, c.stock_id, c.stock_name);
        if (score) results.push(score);
      } catch { /* skip */ }
    }
    if (sortBy === "1") results.sort((a, b) => a.dist - b.dist);
    else results.sort((a, b) => b.amount - a.amount);
    res.json({ success: true, data: results.slice(0, limit) });
  } catch (err: any) {
    res.json({ success: false, error: err.message });
  }
});

// MA Market Scan
router.get("/api/strategy/ma-scan", async (req: Request, res: Response) => {
  const db = getDb();
  if (!db) return res.json({ success: false, error: "DB not connected" });
  const minVolume = parseInt(String(req.query.min_volume || "500"));
  const type = String(req.query.type || "1");
  const sortBy = String(req.query.sort || "1");
  const limit = Math.min(parseInt(String(req.query.limit || "40")), 100);
  try {
    const latestDate = (db.prepare("SELECT MAX(date) as d FROM stock_price").get() as any)?.d;
    if (!latestDate) return res.json({ success: false, data: [] });
    const candidates = db.prepare(`
      SELECT s.stock_id, m.stock_name, s.close, s.volume, (s.close * s.volume) as amount, m.market
      FROM stock_price s
      JOIN stock_meta m ON s.stock_id = m.stock_id
      WHERE s.date = ? AND s.volume >= ? AND s.stock_id GLOB '[1-9][0-9][0-9][0-9]'
      ORDER BY s.volume DESC
      LIMIT 300
    `).all(latestDate, minVolume) as any[];
    let targetPeriod: number;
    let label: string;
    if (type === "1") { targetPeriod = 200; label = "年線(200MA)"; }
    else if (type === "2") { targetPeriod = 60; label = "季線(60MA)"; }
    else { targetPeriod = 60; label = "2560戰法"; }
    const results: any[] = [];
    for (const c of candidates) {
      await new Promise(r => setImmediate(r)); // Yield event loop to avoid blocking
      const rows = db.prepare(
        "SELECT close FROM stock_price WHERE stock_id = ? ORDER BY date DESC LIMIT 1000"
      ).all(c.stock_id).reverse() as any[];
      const closes = rows.map((r: any) => r.close);
      
      const actualPeriod = closes.length >= targetPeriod ? targetPeriod : (closes.length >= 60 ? 60 : (closes.length >= 20 ? 20 : 0));
      if (actualPeriod === 0) continue;
      
      const ma = closes.slice(-actualPeriod).reduce((a: number, b: number) => a + b, 0) / actualPeriod;
      const currentLabel = actualPeriod !== targetPeriod ? `${actualPeriod}MA (歷史不足)` : label;
      const bias = ((c.close - ma) / ma) * 100;
      if (type === "1" && bias < 0) continue;
      if (type === "2" && bias < 0) continue;
      if (type === "3" && (bias < 0 || bias > 5)) continue;
      const touchCount = closes.filter((cl: number) => Math.abs(cl - ma) / ma < 0.005).length;
      results.push({
        stock_id: c.stock_id,
        stock_name: c.stock_name,
        close: c.close,
        volume: Math.floor(c.volume / 1000),
        amount: parseFloat(((c.amount || 0) / 1e8).toFixed(2)),
        targetMA: parseFloat(ma.toFixed(2)),
        targetLabel: currentLabel,
        bias: parseFloat(bias.toFixed(2)),
        touchCount,
      });
    }
    if (sortBy === "1") results.sort((a, b) => Math.abs(a.bias) - Math.abs(b.bias));
    else results.sort((a, b) => b.amount - a.amount);
    res.json({ success: true, data: results.slice(0, limit) });
  } catch (err: any) {
    res.json({ success: false, error: err.message });
  }
});

// Chips Market Scan
router.get("/api/strategy/chips-scan", async (req: Request, res: Response) => {
  const db = getDb();
  if (!db) return res.json({ success: false, error: "DB not connected" });
  const type = String(req.query.type || "1");
  const sortBy = String(req.query.sort || "1");
  const limit = Math.min(parseInt(String(req.query.limit || "40")), 100);
  try {
    const latestDate = (db.prepare("SELECT MAX(date) as d FROM stock_price").get() as any)?.d;
    const instDate = (db.prepare("SELECT MAX(date) as d FROM stock_institutional").get() as any)?.d;
    if (!latestDate || !instDate) return res.json({ success: false, data: [] });
    const candidates = db.prepare(`
      SELECT DISTINCT i.stock_id, m.stock_name, s.close, s.volume, (s.close * s.volume) as amount
      FROM stock_institutional i
      JOIN stock_meta m ON i.stock_id = m.stock_id
      JOIN stock_price s ON i.stock_id = s.stock_id AND s.date = ?
      WHERE i.date = ? AND s.stock_id GLOB '[1-9][0-9][0-9][0-9]'
      ORDER BY s.volume DESC
      LIMIT 300
    `).all(latestDate, instDate) as any[];
    const results: any[] = [];
    for (const c of candidates) {
      await new Promise(r => setImmediate(r)); // Yield event loop to avoid blocking
      const instRows = db.prepare(
        "SELECT date, foreign_net, trust_net FROM stock_institutional WHERE stock_id = ? ORDER BY date DESC LIMIT 10"
      ).all(c.stock_id) as any[];
      const foreignNet = instRows.reduce((sum: number, r: any) => sum + (r.foreign_net || 0), 0);
      const trustNet = instRows.reduce((sum: number, r: any) => sum + (r.trust_net || 0), 0);
      let consecutive = 0, netTotal = 0, label = "";
      if (type === "1") {
        consecutive = 0; netTotal = trustNet;
        label = "投信";
        for (let i = 0; i < instRows.length; i++) {
          const v = instRows[i].trust_net || 0;
          if (i === 0) { consecutive = v >= 0 ? 1 : -1; }
          else {
            if (consecutive > 0 && v >= 0) consecutive++;
            else if (consecutive < 0 && v < 0) consecutive--;
            else break;
          }
        }
      } else if (type === "2") {
        consecutive = 0; netTotal = foreignNet;
        label = "外資";
        for (let i = 0; i < instRows.length; i++) {
          const v = instRows[i].foreign_net || 0;
          if (i === 0) { consecutive = v >= 0 ? 1 : -1; }
          else {
            if (consecutive > 0 && v >= 0) consecutive++;
            else if (consecutive < 0 && v < 0) consecutive--;
            else break;
          }
        }
      } else {
        const shareRow = db.prepare(
          "SELECT whale_ratio, retail_ratio FROM tdcc_shareholding WHERE stock_id = ? ORDER BY date DESC LIMIT 1"
        ).get(c.stock_id);
        if (shareRow) {
          const wr = (shareRow as any).whale_ratio || 0;
          label = "大戶比率";
          consecutive = Math.floor(wr);
          netTotal = Math.floor(wr * 100) / 100;
        }
      }
      if (Math.abs(consecutive) < 1 && type !== "3") continue;
      results.push({
        stock_id: c.stock_id,
        stock_name: c.stock_name,
        close: c.close,
        volume: Math.floor(c.volume / 1000),
        amount: parseFloat(((c.amount || 0) / 1e8).toFixed(2)),
        consecutive,
        netTotal: Math.floor(netTotal / 1000),
        type: label,
      });
    }
    if (sortBy === "1") results.sort((a, b) => Math.abs(b.consecutive) - Math.abs(a.consecutive));
    else results.sort((a, b) => b.amount - a.amount);
    res.json({ success: true, data: results.slice(0, limit) });
  } catch (err: any) {
    res.json({ success: false, error: err.message });
  }
});

router.get("/api/strategy/prediction-scan", (_req, res) => res.status(410).json({
  success: false,
  error: "合成股價預測掃描已停用",
}));

// Pattern Market Scan
router.get("/api/strategy/pattern-scan", async (req: Request, res: Response) => {
  const db = getDb();
  if (!db) return res.json({ success: false, error: "DB not connected" });
  const minVolume = parseInt(String(req.query.min_volume || "500"));
  const sortBy = String(req.query.sort || "1");
  const limit = Math.min(parseInt(String(req.query.limit || "40")), 100);
  try {
    const latestDate = (db.prepare("SELECT MAX(date) as d FROM stock_price").get() as any)?.d;
    if (!latestDate) return res.json({ success: false, data: [] });
    const candidates = db.prepare(`
      SELECT s.stock_id, m.stock_name, s.close, s.volume, (s.close * s.volume) as amount
      FROM stock_price s
      JOIN stock_meta m ON s.stock_id = m.stock_id
      WHERE s.date = ? AND s.volume >= ? AND s.stock_id GLOB '[1-9][0-9][0-9][0-9]'
      ORDER BY s.volume DESC
      LIMIT 200
    `).all(latestDate, minVolume) as any[];
    const results: any[] = [];
    for (const c of candidates) {
      await new Promise(r => setImmediate(r)); // Yield event loop to avoid blocking
      const rows = db.prepare(
        "SELECT high, low, close FROM stock_price WHERE stock_id = ? ORDER BY date DESC LIMIT 120"
      ).all(c.stock_id).reverse() as any[];
      if (rows.length < 20) continue;
      const closes = rows.map((r: any) => r.close);
      const highs = rows.map((r: any) => r.high);
      const lows = rows.map((r: any) => r.low);
      const lastClose = closes[closes.length - 1];
      let patternName = "無明顯型態";
      let confidence = 0;
      
      if (closes.length >= 60) {
        const recentLows = lows.slice(-60);
        const recentHighs = highs.slice(-60);
        const low1 = Math.min(...recentLows.slice(0, 20));
        const low2 = Math.min(...recentLows.slice(20, 40));
        const midHigh = Math.max(...recentHighs.slice(15, 30));
        if (Math.abs(low1 - low2) / low1 < 0.03 && midHigh > low1 * 1.02) {
          patternName = "W底"; confidence = 0.7;
        }
        const high1 = Math.max(...recentHighs.slice(0, 20));
        const high2 = Math.max(...recentHighs.slice(20, 40));
        const midLow = Math.min(...recentLows.slice(15, 30));
        if (Math.abs(high1 - high2) / high1 < 0.03 && midLow < high1 * 0.98) {
          patternName = "M頂"; confidence = 0.7;
        }
      }
      
      if (confidence > 0) {
        results.push({
          stock_id: c.stock_id,
          stock_name: c.stock_name,
          close: c.close,
          volume: Math.floor(c.volume / 1000),
          amount: parseFloat(((c.amount || 0) / 1e8).toFixed(2)),
          patternName,
          confidence,
        });
      }
    }
    if (sortBy === "1") results.sort((a, b) => b.confidence - a.confidence);
    else results.sort((a, b) => b.amount - a.amount);
    res.json({ success: true, data: results.slice(0, limit) });
  } catch (err: any) {
    res.json({ success: false, error: err.message });
  }
});

// Patterns Strategy
router.get("/api/stock/:id/pattern-analysis", async (req: Request, res: Response) => {
  const db = getDb();
  if (!db) return res.json({ success: false, error: "DB not connected" });
  const id = req.params.id;
  try {
    const rows = db.prepare(
      "SELECT date, open, high, low, close, volume FROM stock_price WHERE stock_id = ? ORDER BY date DESC LIMIT 120"
    ).all(id).reverse() as any[];

    if (rows.length < 20) return res.json({ success: false, error: "Insufficient data" });

    const closes = rows.map((r: any) => r.close);
    const highs = rows.map((r: any) => r.high);
    const lows = rows.map((r: any) => r.low);
    const lastClose = closes[closes.length - 1];

    let patternName = '無明顯型態';
    let patternDirection = 'neutral';
    let neckline: number | null = null;
    let target: number | null = null;
    let stopLoss: number | null = null;
    let confidence = 0;

    if (closes.length >= 60) {
      const recentLows = lows.slice(-60);
      const recentHighs = highs.slice(-60);
      const low1 = Math.min(...recentLows.slice(0, 20));
      const low2 = Math.min(...recentLows.slice(20, 40));
      const midHigh = Math.max(...recentHighs.slice(15, 30));

      if (Math.abs(low1 - low2) / low1 < 0.03 && midHigh > low1 * 1.02) {
        patternName = 'W底';
        patternDirection = 'up';
        neckline = parseFloat(midHigh.toFixed(2));
        const depth = midHigh - (low1 + low2) / 2;
        target = parseFloat((midHigh + depth).toFixed(2));
        stopLoss = parseFloat(((low1 + low2) / 2 * 0.97).toFixed(2));
        confidence = 0.7;
      }

      const high1 = Math.max(...recentHighs.slice(0, 20));
      const high2 = Math.max(...recentHighs.slice(20, 40));
      const midLow = Math.min(...recentLows.slice(15, 30));

      if (Math.abs(high1 - high2) / high1 < 0.03 && midLow < high1 * 0.98) {
        patternName = 'M頂';
        patternDirection = 'down';
        neckline = parseFloat(midLow.toFixed(2));
        const depth = (high1 + high2) / 2 - midLow;
        target = parseFloat((midLow - depth).toFixed(2));
        stopLoss = parseFloat(((high1 + high2) / 2 * 1.03).toFixed(2));
        confidence = 0.7;
      }
    }

    res.json({
      success: true,
      data: {
        patternName,
        patternDirection,
        neckline,
        target,
        stopLoss,
        confidence,
        dataPoints: rows.length,
      }
    });
  } catch (err: any) {
    res.json({ success: false, error: err.message });
  }
});


export default router;

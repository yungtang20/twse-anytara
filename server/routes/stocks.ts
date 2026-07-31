import { Router, type Request, type Response } from "express";
import { scrapePriceFromYahoo } from "../lib/yahooPrice";
import { getDb } from "../db";
import { calcIndicators, supabase } from "../services";
import { backfillTdccHistory } from "../lib/tdccHistory";
import { isLoopbackRequest } from "../lib/security";
import {
  hasUsableLocalPriceRows,
  readLocalInstitutionalRows,
  readLocalMeta,
  readLocalPriceRows,
  readLocalStockData,
  searchLocalStocks,
} from "../lib/marketDataRepository";

const router = Router();
const useLocalMarketData = process.env.MARKET_DATA_MODE === "local";

function dataQuality(source: string, asOf?: string | null, warnings: string[] = []) {
  // ponytail: seven calendar days is a conservative stale-data heuristic; use the exchange calendar if holiday precision becomes necessary.
  const ageMs = asOf ? Date.now() - new Date(`${asOf}T23:59:59+08:00`).getTime() : Infinity;
  return {
    source,
    asOf: asOf || null,
    isMock: false,
    isStale: !Number.isFinite(ageMs) || ageMs > 7 * 86_400_000,
    warnings,
  };
}


// ── Search stocks by ID or name
router.get("/api/stock/search", async (req: Request, res: Response) => {
  const q = String(req.query.q || "").trim().replace(/[%,()\"']/g, "");
  if (!q) return res.json({ success: true, data: [] });

  if (useLocalMarketData) try {
    const localRows = searchLocalStocks(q);
    if (localRows.length > 0) {
      return res.json({ success: true, data: localRows, source: "sqlite" });
    }
  } catch (err: unknown) {
    console.error("[SQLite Search Error]:", err instanceof Error ? err.message : String(err));
  }

  if (supabase) {
    try {
      const { data, error } = await supabase
        .from("stock_meta")
        .select("stock_id, stock_name, market, industry_category")
        .or(`stock_id.ilike.%${q}%,stock_name.ilike.%${q}%`)
        .limit(30);
      if (error) throw error;
      const filtered = (data || []).filter(item => /^\d{4}$/.test(item.stock_id));
      return res.json({ success: true, data: filtered });
    } catch (err: any) {
      console.error("[Supabase Search Error]:", err.message);
    }
  }

  if (!useLocalMarketData) {
    return res.status(503).json({ success: false, error: "Supabase stock metadata is unavailable" });
  }
  const db = getDb();
  if (!db) return res.json({ success: false, error: "DB not connected" });
  if (useLocalMarketData) try {
    const rows = db.prepare(
      "SELECT stock_id, stock_name, market, industry_category FROM stock_meta WHERE (stock_id LIKE ? OR stock_name LIKE ?) AND length(stock_id) = 4 AND stock_id NOT GLOB '*[A-Z]*' LIMIT 10"
    ).all(`%${q}%`, `%${q}%`);
    res.json({ success: true, data: rows });
  } catch (err: any) {
    res.json({ success: false, error: err.message });
  }
});

// Get price history for a stock
router.get("/api/stock/:id/history", async (req: Request, res: Response) => {
  const id = req.params.id;
  const days = Math.min(parseInt(String(req.query.days || "120")), 1000);

  if (useLocalMarketData) try {
    const localPrices = readLocalPriceRows(id, Math.max(days, 30));
    if (hasUsableLocalPriceRows(localPrices)) {
      const prices = localPrices.slice(0, days);
      const meta = readLocalMeta(id);
      const warnings = [
        ...(prices.length < 10 ? [`insufficient_history:${prices.length}`] : []),
        ...(meta.stock_name === id ? ["metadata_missing"] : []),
      ];
      const quality = dataQuality("sqlite", prices[0]?.date, warnings);
      return res.json({
        success: true,
        data: [...prices].reverse(),
        ...quality,
        dataQuality: quality,
        meta,
      });
    }
  } catch (err: unknown) {
    console.error("[SQLite History Error]:", err instanceof Error ? err.message : String(err));
  }

  if (supabase) {
    try {
      const { data: metaRows } = await supabase
        .from("stock_meta")
        .select("stock_id, stock_name, market, industry_category")
        .eq("stock_id", id)
        .limit(1);
      
      let meta = metaRows?.[0];
      if (!meta) {
        meta = { stock_id: id, stock_name: id, market: '', industry_category: null };
      }

      const { data: priceData, error: priceErr } = await supabase
        .from("stock_price")
        .select("date, open, high, low, close, volume")
        .eq("stock_id", id)
        .order("date", { ascending: false })
        .limit(days);

      if (priceErr) throw priceErr;

      const rows = priceData || [];
      if (rows.length === 0) throw new Error("No Supabase price data");
      const warnings = [
        ...(rows.length < 10 ? [`insufficient_history:${rows.length}`] : []),
        ...(meta.stock_name === id ? ["metadata_missing"] : []),
      ];
      const quality = dataQuality("supabase", rows[0]?.date, warnings);

      return res.json({ 
        success: true, 
        data: [...rows].reverse(), 
        ...quality,
        dataQuality: quality,
        meta, 
      });
    } catch (err: any) {
      console.error("[Supabase History Error]:", err.message);
    }
  }

  if (!useLocalMarketData) {
    return res.status(503).json({ success: false, error: "Supabase price history is unavailable" });
  }
  const db = getDb();
  if (!db) return res.json({ success: false, error: "DB not connected" });
  if (useLocalMarketData) try {
    let meta = db.prepare("SELECT stock_id, stock_name, market FROM stock_meta WHERE stock_id = ?").get(id) as any;
    if (!meta) {
      meta = { stock_id: id, stock_name: id, market: '' };
    }

    const countRow = db.prepare("SELECT count(*) as c FROM stock_price WHERE stock_id = ?").get(id) as any;
    if (!countRow || countRow.c < 30) {
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - 180);
      const startDateStr = startDate.toISOString().split("T")[0];
      const market = meta?.market || "TSE";
      try {
        const priceData = await scrapePriceFromYahoo(id, startDateStr, undefined, market);
        if (priceData && priceData.length > 0) {
          const insertStmt = db.prepare(`
            INSERT OR REPLACE INTO stock_price (
              stock_id, date, open, high, low, close, volume, amount, trade_count, spread, adj_factor, adj_close, source
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1.0, ?, 'yahoo')
          `);
          db.transaction(() => {
            for (const r of priceData) {
              insertStmt.run(
                id,
                r.date,
                r.open,
                r.high,
                r.low,
                r.close,
                r.volume,
                r.amount,
                r.trade_count,
                r.spread,
                r.adj_close
              );
            }
          })();
        }
      } catch (err: any) {
        console.warn(`[History Backfill] Failed on-the-fly Yahoo backfill for ${id}: ${err.message}`);
      }
    }
    
    const rows = db.prepare(
      "SELECT date, open, high, low, close, volume FROM stock_price WHERE stock_id = ? ORDER BY date DESC LIMIT ?"
    ).all(id, days) as any[];
    const warnings = [
      ...(rows.length === 0 ? ["price_data_missing"] : rows.length < 10 ? [`insufficient_history:${rows.length}`] : []),
      ...(meta.stock_name === id ? ["metadata_missing"] : []),
    ];
    const quality = dataQuality("sqlite", rows[0]?.date, warnings);
    
    res.json({ 
      success: true, 
      data: rows.reverse(), 
      ...quality,
      dataQuality: quality,
      meta, 
    });
  } catch (err: any) {
    res.json({ success: false, error: err.message });
  }
});

// Get indicators for a stock
router.get("/api/stock/:id/indicators", async (req: Request, res: Response) => {
  const id = req.params.id;

  if (useLocalMarketData) try {
    const prices = readLocalPriceRows(id, 1_000);
    if (hasUsableLocalPriceRows(prices)) {
      const indicators = calcIndicators([...prices].reverse());
      const quality = dataQuality("sqlite", prices[0]?.date);
      return res.json({ success: true, data: indicators, ...quality, dataQuality: quality });
    }
  } catch (err: unknown) {
    console.error("[SQLite Indicators Error]:", err instanceof Error ? err.message : String(err));
  }

  if (supabase) {
    try {
      const { data: priceData, error: priceErr } = await supabase
        .from("stock_price")
        .select("date, open, high, low, close, volume")
        .eq("stock_id", id)
        .order("date", { ascending: false })
        .limit(1000);

      if (priceErr) throw priceErr;

      const rows = priceData || [];
      if (rows.length < 10) throw new Error(`Insufficient Supabase price data: ${rows.length}`);
      const indicators = calcIndicators([...rows].reverse());
      const quality = dataQuality("supabase", rows[0]?.date);
      return res.json({ success: true, data: indicators, ...quality, dataQuality: quality });
    } catch (err: any) {
      console.error("[Supabase Indicators Error]:", err.message);
    }
  }

  if (!useLocalMarketData) {
    return res.status(503).json({ success: false, error: "Supabase indicator source data is unavailable" });
  }
  const db = getDb();
  if (!db) return res.json({ success: false, error: "DB not connected" });
  if (useLocalMarketData) try {
    const rows = db.prepare(
      "SELECT date, open, high, low, close, volume FROM stock_price WHERE stock_id = ? ORDER BY date DESC LIMIT 1000"
    ).all(id) as any[];
    if (rows.length < 10) {
      const quality = dataQuality("sqlite", rows[0]?.date, [`insufficient_history:${rows.length}`]);
      return res.json({ success: false, data: null, error: "Insufficient data", ...quality, dataQuality: quality });
    }
    const indicators = calcIndicators(rows.reverse());
    const quality = dataQuality("sqlite", rows[rows.length - 1]?.date);
    res.json({ success: true, data: indicators, ...quality, dataQuality: quality });
  } catch (err: any) {
    res.json({ success: false, error: err.message });
  }
});

// Get institutional data for a stock
router.get("/api/stock/:id/institutional", async (req: Request, res: Response) => {
  const id = req.params.id;

  if (useLocalMarketData) try {
    const institutional = readLocalInstitutionalRows(id);
    if (institutional.length > 0) {
      const warnings = institutional.length < 10
        ? [`insufficient_history:${institutional.length}`]
        : [];
      const quality = dataQuality("sqlite", institutional[0]?.date, warnings);
      return res.json({
        success: true,
        data: institutional,
        ...quality,
        dataQuality: quality,
      });
    }
  } catch (err: unknown) {
    console.error("[SQLite Institutional Error]:", err instanceof Error ? err.message : String(err));
  }

  if (supabase) {
    try {
      const { data: instData, error: instErr } = await supabase
        .from("stock_institutional")
        .select("date, foreign_net, trust_net, dealer_net, institutional_net")
        .eq("stock_id", id)
        .order("date", { ascending: false })
        .limit(512);

      if (instErr) throw instErr;

      const rows = instData || [];
      if (rows.length === 0) throw new Error("No Supabase institutional data");
      const quality = dataQuality("supabase", rows[0]?.date, rows.length < 10 ? [`insufficient_history:${rows.length}`] : []);
      return res.json({ success: true, data: rows, ...quality, dataQuality: quality });
    } catch (err: any) {
      console.error("[Supabase Institutional Error]:", err.message);
    }
  }

  if (!useLocalMarketData) {
    return res.status(503).json({ success: false, error: "Supabase institutional data is unavailable" });
  }
  const db = getDb();
  if (!db) return res.json({ success: false, error: "DB not connected" });
  try {
    const rows = db.prepare(
      "SELECT date, foreign_net, trust_net, dealer_net, institutional_net FROM stock_institutional WHERE stock_id = ? ORDER BY date DESC LIMIT 1000"
    ).all(id) as any[];
    const quality = dataQuality("sqlite", rows[0]?.date, rows.length === 0 ? ["institutional_data_missing"] : rows.length < 10 ? [`insufficient_history:${rows.length}`] : []);
    res.json({ success: true, data: rows, ...quality, dataQuality: quality });
  } catch (err: any) {
    res.json({ success: false, error: err.message });
  }
});

router.get("/api/stock/:id/shareholding", async (req: Request, res: Response) => {
  const id = req.params.id;

  if (supabase) {
    try {
      const { data, error } = await supabase
        .from("tdcc_shareholding")
        .select("date, whale_ratio, total_shares")
        .eq("stock_id", id)
        .order("date", { ascending: false })
        .limit(512);
      if (error) throw error;
      const rows = (data || []).map((row) => ({
        date: row.date,
        ratio: row.whale_ratio,
        count: null,
        shares: row.total_shares,
      }));
      const quality = dataQuality(
        "supabase",
        rows[0]?.date,
        rows.length === 0 ? ["shareholding_data_missing"] : rows.length < 10 ? [`insufficient_history:${rows.length}`] : [],
      );
      return res.json({ success: true, data: rows, ...quality, dataQuality: quality });
    } catch (err: unknown) {
      console.error("[Supabase Shareholding Error]:", err instanceof Error ? err.message : String(err));
    }
  }

  if (!useLocalMarketData) {
    return res.status(503).json({ success: false, error: "Supabase shareholding data is unavailable" });
  }

  const db = getDb();
  if (db) {
    try {
      const rows = db.prepare(
        "SELECT date, whale_ratio as ratio, NULL as count, total_shares as shares FROM tdcc_shareholding WHERE stock_id = ? ORDER BY date DESC LIMIT 1000"
      ).all(id) as any[];
      const quality = dataQuality("tdcc_sqlite", rows[0]?.date, rows.length === 0 ? ["shareholding_data_missing"] : rows.length < 10 ? [`insufficient_history:${rows.length}`] : []);
      return res.json({ success: true, data: rows, ...quality, dataQuality: quality });
    } catch (err: any) {
      console.error("[Local Shareholding Error]:", err.message);
    }
  }

  const quality = dataQuality("tdcc_sqlite", null, ["shareholding_data_missing"]);
  res.json({ success: true, data: [], ...quality, dataQuality: quality });
});

router.post("/api/stock/:id/shareholding/backfill", async (req: Request, res: Response) => {
  if (!isLoopbackRequest(req)) {
    return res.status(403).json({ success: false, error: "TDCC 歷史回補只能從本機觸發" });
  }
  try {
    const result = await backfillTdccHistory(req.params.id, 52);
    return res.json({ success: true, data: result });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return res.status(502).json({ success: false, error: message });
  }
});

// Get full quote (price + indicators + institutional)
router.get("/api/stock/:id/quote", async (req: Request, res: Response) => {
  const id = req.params.id;

  if (useLocalMarketData) try {
    const local = readLocalStockData(id);
    const latest = local.prices[0];
    if (latest && hasUsableLocalPriceRows(local.prices)) {
      const prev = local.prices[1];
      const change = prev ? Number((latest.close - prev.close).toFixed(2)) : 0;
      const changePercent = prev?.close
        ? Number(((change / prev.close) * 100).toFixed(2))
        : 0;
      const quality = dataQuality(
        "sqlite",
        latest.date,
        local.meta.stock_name === id ? ["metadata_missing"] : [],
      );
      return res.json({
        success: true,
        data: {
          stock_id: local.meta.stock_id,
          name: local.meta.stock_name,
          market: local.meta.market,
          industry: local.meta.industry_category,
          ...latest,
          change,
          changePercent,
          prevClose: prev?.close ?? null,
          indicators: calcIndicators([...local.prices].reverse()),
          institutional: local.institutional.slice(0, 10),
          shareholding: local.shareholding,
        },
        ...quality,
        dataQuality: quality,
      });
    }
  } catch (err: unknown) {
    console.error("[SQLite Quote Error]:", err instanceof Error ? err.message : String(err));
  }

  if (supabase) {
    try {
      const { data: metaRows } = await supabase
        .from("stock_meta")
        .select("stock_id, stock_name, market, industry_category")
        .eq("stock_id", id)
        .limit(1);

      let meta = metaRows?.[0];
      if (!meta) {
        meta = { stock_id: id, stock_name: id, market: '', industry_category: null };
      }

      const { data: priceData, error: priceErr } = await supabase
        .from("stock_price")
        .select("date, open, high, low, close, volume")
        .eq("stock_id", id)
        .order("date", { ascending: false })
        .limit(1000);

      if (priceErr) throw priceErr;

      const latest = priceData?.[0];
      const prev = priceData?.[1];
      if (!latest) throw new Error("No Supabase price data");
      const hist = [...(priceData || [])].reverse();
      const indicators = calcIndicators(hist);

      const { data: instData } = await supabase
        .from("stock_institutional")
        .select("date, foreign_net, trust_net")
        .eq("stock_id", id)
        .order("date", { ascending: false })
        .limit(10);

      const { data: shareholdingRows } = await supabase
        .from("tdcc_shareholding")
        .select("date, whale_ratio, retail_ratio")
        .eq("stock_id", id)
        .order("date", { ascending: false })
        .limit(1);
      const shareholding = shareholdingRows?.[0] || null;

      const change = prev ? parseFloat((latest.close - prev.close).toFixed(2)) : 0;
      const changePercent = prev && prev.close > 0 ? parseFloat(((change / prev.close) * 100).toFixed(2)) : 0;
      const quality = dataQuality(
        "supabase",
        latest.date,
        meta.stock_name === id ? ["metadata_missing"] : [],
      );

      return res.json({
        success: true,
        data: {
          stock_id: meta.stock_id,
          name: meta.stock_name,
          market: meta.market,
          industry: meta.industry_category,
          date: latest.date,
          open: latest.open,
          high: latest.high,
          low: latest.low,
          close: latest.close,
          volume: latest.volume,
          change,
          changePercent,
          prevClose: prev ? prev.close : null,
          indicators,
          institutional: instData || [],
          shareholding: shareholding || null,
        },
        ...quality,
        dataQuality: quality,
      });
    } catch (err: any) {
      console.error("[Supabase Quote Error]:", err.message);
    }
  }

  if (!useLocalMarketData) {
    return res.status(503).json({ success: false, error: "Supabase quote data is unavailable" });
  }

  const db = getDb();
  if (!db) return res.json({ success: false, error: "DB not connected" });
  try {
    let meta = db.prepare("SELECT * FROM stock_meta WHERE stock_id = ?").get(id) as any;
    if (!meta) {
      meta = { stock_id: id, stock_name: id, market: '', industry_category: null };
    }

    const countRow = db.prepare("SELECT count(*) as c FROM stock_price WHERE stock_id = ?").get(id) as any;
    if (!countRow || countRow.c < 30) {
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - 180);
      const startDateStr = startDate.toISOString().split("T")[0];
      const market = meta?.market || "TSE";
      try {
        const priceData = await scrapePriceFromYahoo(id, startDateStr, undefined, market);
        if (priceData && priceData.length > 0) {
          const insertStmt = db.prepare(`
            INSERT OR REPLACE INTO stock_price (
              stock_id, date, open, high, low, close, volume, amount, trade_count, spread, adj_factor, adj_close, source
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1.0, ?, 'yahoo')
          `);
          db.transaction(() => {
            for (const r of priceData) {
              insertStmt.run(
                id,
                r.date,
                r.open,
                r.high,
                r.low,
                r.close,
                r.volume,
                r.amount,
                r.trade_count,
                r.spread,
                r.adj_close
              );
            }
          })();
        }
      } catch (err: any) {
        console.warn(`[Quote Backfill] Failed on-the-fly Yahoo backfill for ${id}: ${err.message}`);
      }
    }

    const latest = db.prepare("SELECT * FROM stock_price WHERE stock_id = ? ORDER BY date DESC LIMIT 1").get(id) as any;
    if (!latest) return res.json({ success: false, error: "No price data" });

    const prev = db.prepare("SELECT * FROM stock_price WHERE stock_id = ? ORDER BY date DESC LIMIT 1 OFFSET 1").get(id) as any;
    const hist = db.prepare("SELECT date, open, high, low, close, volume FROM stock_price WHERE stock_id = ? ORDER BY date DESC LIMIT 1000").all(id).reverse() as any[];
    const indicators = calcIndicators(hist);
    const inst = db.prepare("SELECT date, foreign_net, trust_net FROM stock_institutional WHERE stock_id = ? ORDER BY date DESC LIMIT 10").all(id);
    const shareholding = db.prepare("SELECT date, whale_ratio, retail_ratio FROM tdcc_shareholding WHERE stock_id = ? ORDER BY date DESC LIMIT 1").get(id);

    const change = prev ? parseFloat((latest.close - prev.close).toFixed(2)) : 0;
    const changePercent = prev && prev.close > 0 ? parseFloat(((change / prev.close) * 100).toFixed(2)) : 0;

    const quality = dataQuality("sqlite", latest.date, meta.stock_name === id ? ["metadata_missing"] : []);
    res.json({
      success: true,
      data: {
        stock_id: meta.stock_id,
        name: meta.stock_name,
        market: meta.market,
        industry: meta.industry_category,
        date: latest.date,
        open: latest.open,
        high: latest.high,
        low: latest.low,
        close: latest.close,
        volume: latest.volume,
        change,
        changePercent,
        prevClose: prev ? prev.close : null,
        indicators,
        institutional: inst,
        shareholding: shareholding || null,
      },
      ...quality,
      dataQuality: quality,
    });
  } catch (err: any) {
    res.json({ success: false, error: err.message });
  }
});

export default router;

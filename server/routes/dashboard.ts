import { Router, type Request, type Response } from "express";
import { getDb } from "../db";
import { syncPopularDividendsIfNeeded } from "../services";

const router = Router();

// Market movers (top gainers and losers for latest trading day)
router.get("/api/movers", (_req: Request, res: Response) => {
  const db = getDb();
  if (!db) return res.json({ success: false, error: "DB not connected" });
  try {
    const latestDateRow = db.prepare(`SELECT date FROM stock_price GROUP BY date HAVING COUNT(*) > 100 ORDER BY date DESC LIMIT 1`).get() as any;
    const latestDate = latestDateRow?.date || (db.prepare("SELECT MAX(date) as d FROM stock_price").get() as any)?.d;
    if (!latestDate) return res.json({ success: false, error: "No data" });

    const prevDateRow = db.prepare(`SELECT date FROM stock_price WHERE date < ? GROUP BY date HAVING COUNT(*) > 100 ORDER BY date DESC LIMIT 1`).get(latestDate) as any;
    const prevDate = prevDateRow?.date || (db.prepare("SELECT MAX(date) as d FROM stock_price WHERE date < ?").get(latestDate) as any)?.d;
    if (!prevDate) return res.json({ success: false, error: "No previous data" });

    const sql = `
      SELECT curr.stock_id, m.stock_name, m.market,
             curr.close AS price, prev.close AS prev_close,
             ROUND(curr.close - prev.close, 2) AS change,
             ROUND((curr.close - prev.close) / prev.close * 100, 2) AS change_pct
      FROM stock_price curr
      JOIN stock_price prev ON curr.stock_id = prev.stock_id AND prev.date = ?
      JOIN stock_meta m ON curr.stock_id = m.stock_id
      WHERE curr.date = ? AND prev.close > 0
      ORDER BY change_pct DESC
    `;
    const all = db.prepare(sql).all(prevDate, latestDate) as any[];
    const topGainers = all.slice(0, 5);
    const topLosers = all.slice(-5).reverse();
    res.json({ success: true, date: latestDate, gainers: topGainers, losers: topLosers });
  } catch (err: any) {
    res.json({ success: false, error: err.message });
  }
});

// ── Dashboard Metrics APIs
router.get("/api/dashboard/recent-dividend", async (req: Request, res: Response) => {
  const db = getDb();
  if (!db) return res.json({ success: false, error: "DB not connected" });
  try {
    await syncPopularDividendsIfNeeded(db);

    const taipeiNow = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Taipei" }));
    const yyyy = taipeiNow.getFullYear();
    const mm = String(taipeiNow.getMonth() + 1).padStart(2, '0');
    const dd = String(taipeiNow.getDate()).padStart(2, '0');
    const todayStr = `${yyyy}-${mm}-${dd}`;

    const events = db.prepare(`
      SELECT d.stock_id, m.stock_name, d.date, d.cash_dividend, d.stock_dividend
      FROM dividend_events d
      JOIN stock_meta m ON d.stock_id = m.stock_id
      WHERE d.date >= ?
      ORDER BY d.date ASC
      LIMIT 10
    `).all(todayStr) as any[];

    const latestDateRow = db.prepare(`SELECT MAX(date) as d FROM stock_price`).get() as { d: string } | undefined;
    const latestDate = latestDateRow?.d || todayStr;

    const formatted = events.map((ev: any) => {
      const hist = db.prepare(`
        SELECT h.close, h.volume, h_prev.close as prev_close, h_prev.volume as prev_volume
        FROM stock_price h
        LEFT JOIN stock_price h_prev ON h.stock_id = h_prev.stock_id 
          AND h_prev.date = (SELECT MAX(date) FROM stock_price WHERE date < ?)
        WHERE h.stock_id = ? AND h.date = ?
      `).get(latestDate, ev.stock_id, latestDate) as any;

      const close = hist?.close || 100;
      const prev_close = hist?.prev_close || close;
      const change_pct = parseFloat(((close - prev_close) / prev_close * 100).toFixed(2));
      const volume = hist?.volume || 1000;
      const volume_change_pct = hist?.prev_volume > 0
        ? parseFloat((((hist.volume || 0) - hist.prev_volume) / hist.prev_volume * 100).toFixed(1))
        : null;

      return {
        stock_id: ev.stock_id,
        stock_name: ev.stock_name,
        date: ev.date.substring(5),
        cash_dividend: ev.cash_dividend,
        stock_dividend: ev.stock_dividend,
        reference_price: parseFloat((close - ev.cash_dividend).toFixed(2)),
        close,
        prev_close,
        change_pct,
        volume: Math.floor(volume / 1000),
        volume_change_pct
      };
    });

    res.json({ success: true, data: formatted });
  } catch (err: any) {
    res.json({ success: false, error: err.message, data: [] });
  }
});

router.get("/api/dashboard/trust-buy-2day", async (req: Request, res: Response) => {
  const db = getDb();
  if (!db) return res.json({ success: false, error: "DB not connected" });
  try {
    const datesRow = db.prepare(`
      SELECT DISTINCT date FROM stock_price 
      GROUP BY date HAVING COUNT(*) > 100 
      ORDER BY date DESC LIMIT 10
    `).all() as { date: string }[];

    if (datesRow.length < 2) {
      return res.json({ success: true, data: [] });
    }

    const trustBuyStocks = db.prepare(`
      SELECT i.stock_id, m.stock_name, 
             h.close, h.volume, h_prev.close as prev_close, h_prev.volume as prev_volume,
             i.trust_net as latest_trust_net, i_prev.trust_net as prev_trust_net,
             (h.close * h.volume) as amount
      FROM stock_institutional i
      JOIN stock_institutional i_prev ON i.stock_id = i_prev.stock_id AND i_prev.date = ?
      JOIN stock_meta m ON i.stock_id = m.stock_id
      JOIN stock_price h ON i.stock_id = h.stock_id AND h.date = i.date
      LEFT JOIN stock_price h_prev ON i.stock_id = h_prev.stock_id AND h_prev.date = i_prev.date
      WHERE i.date = ? AND i.trust_net > 0 AND i_prev.trust_net > 0
      ORDER BY i.trust_net DESC
      LIMIT 50
    `).all(datesRow[1].date, datesRow[0].date);

    const formatted = trustBuyStocks.map((s: any) => {
      let trust_days = 2;
      for (let j = 2; j < datesRow.length; j++) {
        const row = db.prepare(`
          SELECT trust_net FROM stock_institutional WHERE stock_id = ? AND date = ?
        `).get(s.stock_id, datesRow[j].date) as { trust_net: number } | undefined;
        if (row && row.trust_net > 0) {
          trust_days++;
        } else {
          break;
        }
      }

      const close = s.close || 0;
      const prev_close = s.prev_close || close;
      const change_pct = prev_close > 0 ? parseFloat(((close - prev_close) / prev_close * 100).toFixed(2)) : 0;
      
      const volume = s.volume || 0;
      const prev_volume = s.prev_volume || volume;
      const volume_change_pct = prev_volume > 0 ? parseFloat(((volume - prev_volume) / prev_volume * 100).toFixed(2)) : 0;

      return {
        stock_id: s.stock_id,
        stock_name: s.stock_name,
        volume: Math.floor(volume / 1000),
        amount: parseFloat(((s.amount || 0) / 1e8).toFixed(2)),
        trust_days,
        trust_net: Math.floor(s.latest_trust_net / 1000),
        close,
        prev_close,
        change_pct,
        volume_change_pct
      };
    });

    res.json({ success: true, data: formatted });
  } catch (err: any) {
    res.json({ success: false, error: err.message, data: [] });
  }
});

router.get("/api/dashboard/break-ma200", async (req: Request, res: Response) => {
  const db = getDb();
  if (!db) return res.json({ success: false, error: "DB not connected" });
  try {
    const datesRow = db.prepare(`
      SELECT DISTINCT date FROM stock_price 
      GROUP BY date HAVING COUNT(*) > 100 
      ORDER BY date DESC LIMIT 2
    `).all() as { date: string }[];

    if (datesRow.length < 2) {
      return res.json({ success: true, data: [] });
    }

    const candidates = db.prepare(`
      SELECT h.stock_id, m.stock_name, h.close, h.volume, h_prev.close as prev_close, h_prev.volume as prev_volume
      FROM stock_price h
      JOIN stock_meta m ON h.stock_id = m.stock_id
      LEFT JOIN stock_price h_prev ON h.stock_id = h_prev.stock_id AND h_prev.date = ?
      WHERE h.date = ? AND h.volume >= 500000 AND h.stock_id GLOB '[1-9][0-9][0-9]' || '*'
      ORDER BY h.volume DESC
      LIMIT 150
    `).all(datesRow[1].date, datesRow[0].date);

    const results: any[] = [];
    const getHistoryStmt = db.prepare(`
      SELECT close FROM stock_price WHERE stock_id = ? ORDER BY date DESC LIMIT 202
    `);

    for (const c of candidates) {
      await new Promise(r => setImmediate(r)); // Yield event loop to avoid blocking
      const history = getHistoryStmt.all(c.stock_id) as { close: number }[];
      const totalLen = history.length;
      if (totalLen < 201) continue;

      const maPeriod = 200;
      
      const latest_close = history[0].close;
      const prev_close = history[1].close;
      
      const latest_ma = history.slice(0, maPeriod).reduce((sum, r) => sum + r.close, 0) / maPeriod;
      const prev_ma = history.slice(1, maPeriod + 1).reduce((sum, r) => sum + r.close, 0) / maPeriod;
      
      if (prev_close <= prev_ma && latest_close > latest_ma) {
        const close = c.close || 0;
        const prev_c = c.prev_close || close;
        const change_pct = prev_c > 0 ? parseFloat(((close - prev_c) / prev_c * 100).toFixed(2)) : 0;
        
        const volume = c.volume || 0;
        const prev_v = c.prev_volume || volume;
        const volume_change_pct = prev_v > 0 ? parseFloat(((volume - prev_v) / prev_v * 100).toFixed(2)) : 0;

        results.push({
          stock_id: c.stock_id,
          stock_name: c.stock_name,
          prev_close,
          latest_close,
          prev_ma200: parseFloat(prev_ma.toFixed(2)),
          latest_ma200: parseFloat(latest_ma.toFixed(2)),
          volume: Math.floor(volume / 1000),
          close,
          change_pct,
          volume_change_pct
        });
      }
    }

    if (results.length === 0) {
      for (const c of candidates) {
      await new Promise(r => setImmediate(r)); // Yield event loop to avoid blocking
        const history = getHistoryStmt.all(c.stock_id) as { close: number }[];
        const totalLen = history.length;
        if (totalLen < 201) continue;
        
        const maPeriod = 200;

        const latest_close = history[0].close;
        const prev_close = history[1].close;
        const latest_ma = history.slice(0, maPeriod).reduce((sum, r) => sum + r.close, 0) / maPeriod;
        const prev_ma = history.slice(1, maPeriod + 1).reduce((sum, r) => sum + r.close, 0) / maPeriod;
        
        const ratio = latest_close / latest_ma;
        if (ratio >= 1.0 && ratio <= 1.025) {
          const close = c.close || 0;
          const prev_c = c.prev_close || close;
          const change_pct = prev_c > 0 ? parseFloat(((close - prev_c) / prev_c * 100).toFixed(2)) : 0;
          
          const volume = c.volume || 0;
          const prev_v = c.prev_volume || volume;
          const volume_change_pct = prev_v > 0 ? parseFloat(((volume - prev_v) / prev_v * 100).toFixed(2)) : 0;

          results.push({
            stock_id: c.stock_id,
            stock_name: c.stock_name,
            prev_close,
            latest_close,
            prev_ma200: parseFloat(prev_ma.toFixed(2)),
            latest_ma200: parseFloat(latest_ma.toFixed(2)),
            volume: Math.floor(volume / 1000),
            close,
            change_pct,
            volume_change_pct
          });
        }
      }
    }

    res.json({ success: true, data: results.slice(0, 50) });
  } catch (err: any) {
    res.json({ success: false, error: err.message, data: [] });
  }
});

router.get("/api/dashboard/limit-up-yesterday", async (req: Request, res: Response) => {
  const db = getDb();
  if (!db) return res.json({ success: false, error: "DB not connected" });
  try {
    const datesRow = db.prepare(`
      SELECT DISTINCT date FROM stock_price 
      GROUP BY date HAVING COUNT(*) > 100 
      ORDER BY date DESC LIMIT 2
    `).all() as { date: string }[];

    if (datesRow.length < 2) {
      return res.json({ success: true, data: [] });
    }

    let limitUpStocks = db.prepare(`
      SELECT h.stock_id, m.stock_name, h.close, h.volume, h_prev.close as prev_close, h_prev.volume as prev_volume
      FROM stock_price h
      JOIN stock_meta m ON h.stock_id = m.stock_id
      LEFT JOIN stock_price h_prev ON h.stock_id = h_prev.stock_id AND h_prev.date = ?
      WHERE h.date = ? AND h.stock_id GLOB '[1-9][0-9][0-9][0-9]'
        AND h_prev.close > 0
        AND (h.close - h_prev.close) / h_prev.close >= 0.085
      ORDER BY (h.close - h_prev.close) / h_prev.close DESC
      LIMIT 50
    `).all(datesRow[1].date, datesRow[0].date);

    if (limitUpStocks.length === 0) {
      limitUpStocks = db.prepare(`
        SELECT h.stock_id, m.stock_name, h.close, h.volume, h_prev.close as prev_close, h_prev.volume as prev_volume
        FROM stock_price h
        JOIN stock_meta m ON h.stock_id = m.stock_id
        LEFT JOIN stock_price h_prev ON h.stock_id = h_prev.stock_id AND h_prev.date = ?
        WHERE h.date = ? AND h.stock_id GLOB '[1-9][0-9][0-9][0-9]'
          AND h_prev.close > 0
        ORDER BY (h.close - h_prev.close) / h_prev.close DESC
        LIMIT 30
      `).all(datesRow[1].date, datesRow[0].date);
    }

    const formatted = limitUpStocks.map((s: any) => {
      const close = s.close || 0;
      const prev_close = s.prev_close || close;
      const change_pct = prev_close > 0 ? parseFloat(((close - prev_close) / prev_close * 100).toFixed(2)) : 0;
      
      const volume = s.volume || 0;
      const prev_volume = s.prev_volume || volume;
      const volume_change_pct = prev_volume > 0 ? parseFloat(((volume - prev_volume) / prev_volume * 100).toFixed(2)) : 0;

      const avgVolRow = db.prepare(`
        SELECT AVG(volume) as avg_vol
        FROM (
          SELECT volume FROM stock_price
          WHERE stock_id = ? AND date < ?
          ORDER BY date DESC LIMIT 5
        )
      `).get(s.stock_id, datesRow[0].date) as { avg_vol: number } | undefined;
      const avg_vol = avgVolRow?.avg_vol || s.volume;
      const vol_explosion_pct = avg_vol > 0 ? parseFloat(((s.volume - avg_vol) / avg_vol * 100).toFixed(2)) : 0;

      return {
        stock_id: s.stock_id,
        stock_name: s.stock_name,
        close,
        prev_close,
        change_pct,
        volume: Math.floor(volume / 1000),
        vol_explosion_pct,
        volume_change_pct
      };
    });

    res.json({ success: true, data: formatted });
  } catch (err: any) {
    res.json({ success: false, error: err.message, data: [] });
  }
});


export default router;

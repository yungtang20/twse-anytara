import { Router, type Request, type Response } from "express";
import { supabase } from "../services";
import { fetchFinancialSnapshot, fetchFundamentalDataset } from "../lib/legacyFrameworkAnalysis";
import { buildCompanyFinancialAnalysis } from "../lib/financialAnalysis";

const router = Router();

// TWSE Phase 1 — valuation / margin / revenue / financials read routes
router.get("/api/stock/:id/valuation", async (req: Request, res: Response) => {
  const id = req.params.id.trim();
  if (!/^\d{4,6}$/.test(id)) return res.status(400).json({ success: false, error: "股票代號格式不正確" });
  const days = Math.min(Number(req.query.days) || 252, 1000);
  try {
    const result = await fetchFundamentalDataset(id, "TaiwanStockPER");
    const data = result.rows.slice(-days).reverse().map((row) => ({
      date: row.date, yield: row.dividend_yield ?? null,
      pe_ratio: row.PER ?? null, pb_ratio: row.PBR ?? null,
    }));
    res.json({ success: true, data, ...result, rows: undefined });
  } catch (error: unknown) {
    res.status(502).json({ success: false, error: error instanceof Error ? error.message : "估值資料讀取失敗" });
  }
});

router.get("/api/stock/:id/margin", async (req: Request, res: Response) => {
  const id = req.params.id;
  const days = Math.min(Number(req.query.days) || 252, 1000);
  if (!supabase) return res.status(503).json({ success: false, error: "Supabase margin data is unavailable" });
  try {
    const { data, error } = await supabase
      .from("stock_margin")
      .select("date, margin_balance, short_balance, margin_buy, short_sell")
      .eq("stock_id", id)
      .order("date", { ascending: false })
      .limit(days);
    if (error) throw error;
    res.json({ success: true, data: data || [] });
  } catch (error: unknown) {
    res.status(503).json({ success: false, error: error instanceof Error ? error.message : "融資券資料讀取失敗" });
  }
});

router.get("/api/stock/:id/revenue", async (req: Request, res: Response) => {
  const id = req.params.id.trim();
  if (!/^\d{4,6}$/.test(id)) return res.status(400).json({ success: false, error: "股票代號格式不正確" });
  const months = Math.min(Number(req.query.months) || 60, 120);
  try {
    const result = await fetchFundamentalDataset(id, "TaiwanStockMonthRevenue");
    const data = result.rows.slice(-months).reverse().map((row) => ({
      year_month: `${row.revenue_year || String(row.date || "").slice(0, 4)}-${String(row.revenue_month || String(row.date || "").slice(5, 7)).padStart(2, "0")}`,
      month_revenue: row.revenue ?? null, cumulative_revenue: row.revenue_accumulate ?? null,
      mom: row.MoM ?? row.mom ?? null, yoy: row.YoY ?? row.yoy ?? null,
    }));
    res.json({ success: true, data, ...result, rows: undefined });
  } catch (error: unknown) {
    res.status(502).json({ success: false, error: error instanceof Error ? error.message : "月營收資料讀取失敗" });
  }
});

router.get("/api/stock/:id/financials", async (req: Request, res: Response) => {
  const id = req.params.id.trim();
  if (!/^\d{4,6}$/.test(id)) {
    return res.status(400).json({ success: false, error: "股票代號格式不正確" });
  }
  try {
    let metadata: { stock_name?: string; industry_category?: string; market?: string } | undefined;
    if (supabase) {
      const { data, error } = await supabase.from("stock_meta")
        .select("stock_name,industry_category,market").eq("stock_id", id).maybeSingle();
      if (error) throw error;
      metadata = data || undefined;
    }
    const snapshot = await fetchFinancialSnapshot(id, undefined, {
      companyName: metadata?.stock_name, industry: metadata?.industry_category, market: metadata?.market,
    });
    const data = buildCompanyFinancialAnalysis(snapshot, metadata?.stock_name);
    res.json({ success: true, data });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "公司財務資料讀取失敗";
    res.status(502).json({ success: false, error: message });
  }
});

export default router;

import { Router, type Request, type Response } from "express";
import { supabase } from "../services";

const router = Router();

// TWSE Phase 1 — valuation / margin / revenue / financials read routes
router.get("/api/stock/:id/valuation", async (req: Request, res: Response) => {
  const id = req.params.id;
  const days = Math.min(Number(req.query.days) || 252, 1000);
  if (!supabase) return res.json({ success: true, data: [] });
  try {
    const { data, error } = await supabase
      .from("stock_valuation")
      .select("date, yield, pe_ratio, pb_ratio")
      .eq("stock_id", id)
      .order("date", { ascending: false })
      .limit(days);
    if (error) throw error;
    res.json({ success: true, data: data || [] });
  } catch (err: any) {
    res.json({ success: false, error: err.message });
  }
});

router.get("/api/stock/:id/margin", async (req: Request, res: Response) => {
  const id = req.params.id;
  const days = Math.min(Number(req.query.days) || 252, 1000);
  if (!supabase) return res.json({ success: true, data: [] });
  try {
    const { data, error } = await supabase
      .from("stock_margin")
      .select("date, margin_balance, short_balance, margin_buy, short_sell")
      .eq("stock_id", id)
      .order("date", { ascending: false })
      .limit(days);
    if (error) throw error;
    res.json({ success: true, data: data || [] });
  } catch (err: any) {
    res.json({ success: false, error: err.message });
  }
});

router.get("/api/stock/:id/revenue", async (req: Request, res: Response) => {
  const id = req.params.id;
  const months = Math.min(Number(req.query.months) || 60, 120);
  if (!supabase) return res.json({ success: true, data: [] });
  try {
    const { data, error } = await supabase
      .from("stock_monthly_revenue")
      .select("year_month, month_revenue, cumulative_revenue, mom, yoy")
      .eq("stock_id", id)
      .order("year_month", { ascending: false })
      .limit(months);
    if (error) throw error;
    res.json({ success: true, data: data || [] });
  } catch (err: any) {
    res.json({ success: false, error: err.message });
  }
});

router.get("/api/stock/:id/financials", async (req: Request, res: Response) => {
  const id = req.params.id;
  const quarters = Math.min(Number(req.query.quarters) || 16, 40);
  if (!supabase) return res.json({ success: true, data: [] });
  try {
    const { data, error } = await supabase
      .from("stock_financials_quarter")
      .select("quarter_label, revenue, net_income, eps")
      .eq("stock_id", id)
      .order("quarter_label", { ascending: false })
      .limit(quarters);
    if (error) throw error;
    res.json({ success: true, data: data || [] });
  } catch (err: any) {
    res.json({ success: false, error: err.message });
  }
});

export default router;

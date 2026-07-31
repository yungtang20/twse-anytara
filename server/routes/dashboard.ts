import { Router, type Request, type Response } from "express";
import { supabase } from "../services";

const router = Router();

type DashboardCard =
  | "movers"
  | "recent_dividend"
  | "trust_buy_2day"
  | "break_ma200"
  | "limit_up_yesterday";

async function readDashboardCard(card: DashboardCard, limit: number): Promise<unknown> {
  if (!supabase) throw new Error("Supabase is not configured");
  const { data, error } = await supabase.rpc("market_dashboard", {
    card,
    result_limit: limit,
  });
  if (error) throw new Error(error.message);
  return data;
}

function cardRoute(card: DashboardCard, limit: number) {
  return async (_req: Request, res: Response) => {
    try {
      const data = await readDashboardCard(card, limit);
      if (card === "movers") {
        return res.json({ success: true, ...(data as object), source: "supabase" });
      }
      if (card === "recent_dividend" && Array.isArray(data)) {
        const rows = data.map((row) => ({
          ...row,
          date: String(row.event_date || "").slice(5),
        }));
        return res.json({ success: true, data: rows, source: "supabase" });
      }
      return res.json({ success: true, data, source: "supabase" });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return res.status(503).json({ success: false, error: message, data: [] });
    }
  };
}

router.get("/api/movers", cardRoute("movers", 100));
router.get("/api/dashboard/recent-dividend", cardRoute("recent_dividend", 10));
router.get("/api/dashboard/trust-buy-2day", cardRoute("trust_buy_2day", 50));
router.get("/api/dashboard/break-ma200", cardRoute("break_ma200", 50));
router.get("/api/dashboard/limit-up-yesterday", cardRoute("limit_up_yesterday", 50));

export default router;

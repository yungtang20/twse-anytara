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

export function sortTrustBuyByDays(data: unknown): unknown {
  if (!Array.isArray(data)) return data;
  return [...data].sort((left, right) => {
    const leftRow = left as Record<string, unknown>;
    const rightRow = right as Record<string, unknown>;
    const daysDifference = Number(leftRow.trust_days || 0) - Number(rightRow.trust_days || 0);
    if (daysDifference !== 0) return daysDifference;
    return String(leftRow.stock_id || "").localeCompare(String(rightRow.stock_id || ""));
  });
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
      if (card === "trust_buy_2day") {
        return res.json({ success: true, data: sortTrustBuyByDays(data), source: "supabase" });
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

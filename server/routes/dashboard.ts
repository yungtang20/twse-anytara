import { Router, type Request, type Response } from "express";
import { supabase } from "../services";
import { fetchCloudTradingCalendar, latestCloudDate } from "../lib/cloudMarketData";

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

export function applyConsecutiveTrustDays(
  data: unknown,
  institutionalRows: Array<{ stock_id: string; date: string; trust_net: number }>,
): unknown {
  if (!Array.isArray(data)) return data;
  const history = new Map<string, Array<{ date: string; trustNet: number }>>();
  for (const row of institutionalRows) {
    if (!/^\d{4,6}$/.test(row.stock_id) || !Number.isFinite(row.trust_net)) continue;
    const rows = history.get(row.stock_id) ?? [];
    rows.push({ date: row.date, trustNet: row.trust_net });
    history.set(row.stock_id, rows);
  }
  return data.map((item) => {
    const row = item as Record<string, unknown>;
    const stockId = typeof row.stock_id === "string" ? row.stock_id : "";
    const rows = (history.get(stockId) ?? []).sort((left, right) => right.date.localeCompare(left.date));
    let trustDays = 0;
    for (const entry of rows.slice(0, 10)) {
      if (entry.trustNet <= 0) break;
      trustDays += 1;
    }
    return { ...row, trust_days: trustDays };
  });
}

async function readConsecutiveTrustDays(data: unknown): Promise<unknown> {
  if (!supabase || !Array.isArray(data) || data.length === 0) return data;
  const stockIds = [...new Set(data.map((row) => String(row.stock_id || "")).filter((id) => /^\d{4,6}$/.test(id)))];
  const latestDate = await latestCloudDate("stock_institutional");
  if (!latestDate || stockIds.length === 0) return applyConsecutiveTrustDays(data, []);
  const dates = await fetchCloudTradingCalendar(latestDate, 10);
  if (dates.length === 0) return applyConsecutiveTrustDays(data, []);
  const { data: rows, error } = await supabase
    .from("stock_institutional")
    .select("stock_id,date,trust_net")
    .in("stock_id", stockIds)
    .in("date", dates)
    .order("date", { ascending: false })
    .limit(stockIds.length * dates.length);
  if (error) throw new Error(error.message);
  return applyConsecutiveTrustDays(data, (rows || []) as Array<{ stock_id: string; date: string; trust_net: number }>);
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
        const consecutive = await readConsecutiveTrustDays(data);
        return res.json({ success: true, data: sortTrustBuyByDays(consecutive), source: "supabase" });
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

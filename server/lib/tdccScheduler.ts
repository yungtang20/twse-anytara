// Weekly TDCC auto-sync scheduler (Saturday ~18:00 Taipei).
// Uses plain setInterval — no external cron dependency.  Survives tab close (server-side).
import { syncTdcc, getTdccSqliteStatus } from "./tdccDownload";
import { addLog } from "../services";

let lastRunDate = "";
let running = false;
let timer: ReturnType<typeof setInterval> | null = null;

// Check every 4h; run only on Saturday evening (or when data is stale by 7+ days)
export function startTdccScheduler(): void {
  if (timer) return;
  console.log("[tdcc-scheduler] started (check every 4h)");

  const tryRun = async () => {
    if (running) return;
    const status = getTdccSqliteStatus();
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Taipei" }); // YYYY-MM-DD
    const dayOfWeek = new Date().toLocaleDateString("en-US", { timeZone: "Asia/Taipei", weekday: "short" });
    const hour = new Date().getHours();

    // Run window: Sat 18:00 - Sun 23:59 Taipei, OR if latest data is older than 6 days
    const latestAge = status.latest
      ? Math.floor((Date.now() - new Date(status.latest + "T00:00:00+08:00").getTime()) / 86400000)
      : 999;
    const inWindow = (dayOfWeek === "Sat" && hour >= 18) || dayOfWeek === "Sun";
    const stale = latestAge > 6;

    if (lastRunDate === today) return; // already ran today
    if (!inWindow && !stale) {
      console.log(`[tdcc-scheduler] skip: latest=${status.latest}, latestAge=${latestAge}d, day=${dayOfWeek} ${hour}h`);
      return;
    }

    running = true;
    try {
      const r = await syncTdcc({ log: (m) => addLog("TDCC_CRON", "OK", m) });
      lastRunDate = today;
      addLog("TDCC_CRON", "DONE", ` ${r.count} 股 (${r.date})`);
    } catch (e: any) {
      addLog("TDCC_CRON", "ERROR", e.message?.slice(0, 200) || "unknown");
    } finally {
      running = false;
    }
  };

  // Run immediately on startup (covers manual server restart after a missed window)
  tryRun().catch(() => {});

  // Recurring check
  const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;
  timer = setInterval(() => tryRun().catch(() => {}), FOUR_HOURS_MS);
}

export function getSchedulerState() { return { lastRunDate, running }; }

export function stopTdccScheduler(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

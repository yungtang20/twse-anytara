import { appendFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createSupabaseAdminClient } from "./lib/supabaseAdmin.js";

export interface TradingCalendarDispatchRow {
  date: string;
  is_open: boolean;
  source: string;
}

export type DailySyncMode = "market" | "tdcc";

export interface DailySyncDispatcherDependencies {
  targetDate?: string;
  clock?: () => Date;
  readCalendarRows?: (date: string) => Promise<TradingCalendarDispatchRow[]>;
  emitOutput?: (result: DailySyncDispatchResult) => Promise<void>;
}

export interface DailySyncDispatchResult {
  mode: DailySyncMode;
  targetDate: string;
}

function validIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

export function taipeiDate(clock: () => Date = () => new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei",
    year: "numeric", month: "2-digit", day: "2-digit" }).format(clock());
}

export function resolveDailySyncMode(targetDate: string,
  rows: TradingCalendarDispatchRow[]): DailySyncMode {
  if (!validIsoDate(targetDate)) throw new Error("invalid_dispatch_date");
  if (rows.length === 0) throw new Error(`trading_calendar_missing:${targetDate}`);
  if (rows.length !== 1) throw new Error(`trading_calendar_duplicate:${targetDate}`);
  const row = rows[0];
  if (row.date !== targetDate) throw new Error(`trading_calendar_date_mismatch:${row.date}`);
  if (typeof row.is_open !== "boolean") throw new Error("trading_calendar_invalid_open_flag");
  if (typeof row.source !== "string" || row.source.trim() === "") {
    throw new Error("trading_calendar_source_missing");
  }
  return row.is_open ? "market" : "tdcc";
}

async function readCalendarRows(date: string): Promise<TradingCalendarDispatchRow[]> {
  const client = createSupabaseAdminClient();
  const { data, error } = await client.from("trading_calendar")
    .select("date,is_open,source").eq("date", date).limit(2);
  if (error) throw new Error(`trading_calendar_lookup_failed:${error.message}`);
  return (data || []) as TradingCalendarDispatchRow[];
}

async function emitGithubOutput(result: DailySyncDispatchResult): Promise<void> {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) return;
  await appendFile(path.resolve(outputPath), `mode=${result.mode}\ntarget_date=${result.targetDate}\n`, "utf8");
}

export async function runDailySyncDispatcher(
  dependencies: DailySyncDispatcherDependencies = {},
): Promise<DailySyncDispatchResult> {
  const targetDate = dependencies.targetDate ?? taipeiDate(dependencies.clock);
  const rows = await (dependencies.readCalendarRows ?? readCalendarRows)(targetDate);
  const result = { mode: resolveDailySyncMode(targetDate, rows), targetDate };
  await (dependencies.emitOutput ?? emitGithubOutput)(result);
  return result;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  runDailySyncDispatcher().then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch((error) => {
      process.stderr.write(`${JSON.stringify({ status: "failed",
        error: error instanceof Error ? error.message : String(error) })}\n`);
      process.exitCode = 1;
    });
}

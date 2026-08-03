// Local-only TDCC backfill library. Phase one exposes no executable entrypoint;
// any future caller must provide an existing database through SQLITE_DB_PATH.
// Completely independent from Supabase — no cross-download, no sync.
import Database from "better-sqlite3";
import type { Database as SqliteDatabase } from "better-sqlite3";
import { pathToFileURL } from "node:url";
import { requireExplicitSqlitePath } from "./lib/sqlitePath";
import {
  buildLocalTdccBackfillPlan,
  buildLocalTdccDryRunReport,
  createLocalTdccUpsert,
  selectExistingCoreCompleteDates,
  type LocalTdccRecord,
} from "../server/lib/tdccBackfill";

const TDCC_HISTORY_URL = "https://www.tdcc.com.tw/portal/zh/smWeb/qryStock";
const USER_AGENT = "Mozilla/5.0 (compatible; TWSE-AnyTara/1.0; +local-data-sync)";
const MIB = 1024 * 1024;

interface Options {
  limit: number;
  requestDelayMs: number;
  stockId?: string;
  dryRun: boolean;
}

export interface LocalTdccRunnerDependencies {
  fetchImpl?: typeof fetch;
  openDatabase?: (readonly: boolean) => SqliteDatabase;
  createUpsert?: typeof createLocalTdccUpsert;
  log?: (message: string) => void;
}

interface TdccSession {
  cookie: string;
  token: string;
  dates: string[];
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parseOptions(args: string[]): Options {
  const values = new Map(
    args
      .filter((arg) => arg.startsWith("--") && arg.includes("="))
      .map((arg) => {
        const [key, ...rest] = arg.slice(2).split("=");
        return [key, rest.join("=")];
      }),
  );
  return {
    limit: Math.min(positiveInteger(values.get("limit"), 50), 200),
    requestDelayMs: Math.max(positiveInteger(values.get("delay-ms"), 500), 500),
    stockId: values.get("stock-id"),
    dryRun: args.includes("--dry-run"),
  };
}

function hiddenValue(html: string, name: string): string {
  const pattern = new RegExp(`name=["']${name}["'][^>]+value=["']([^"']+)`, "i");
  return html.match(pattern)?.[1] || "";
}

function availableDates(html: string): string[] {
  return [...new Set(
    [...html.matchAll(/<option[^>]+value=["'](\d{8})["']/gi)].map((match) => match[1]),
  )];
}

function isoDate(compact: string): string {
  return `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}`;
}

function parseInteger(value: string): number {
  const parsed = Number(value.replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function tableRows(html: string): string[][] {
  return [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map((row) =>
    [...row[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((cell) =>
      cell[1]
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/g, " ")
        .replace(/\s+/g, " ")
        .trim(),
    ),
  );
}

function parseHistoryRecord(html: string, stockId: string, date: string): LocalTdccRecord | null {
  const rows = tableRows(html).filter((row) => /^\d+$/.test(row[0] || ""));
  const totalRow = rows.find((row) => row[1]?.includes("合"));
  const whaleRow = rows.find((row) => row[0] === "15");
  const totalShares = parseInteger(totalRow?.[3] || "0");
  const totalPeople = parseInteger(totalRow?.[2] || "0");
  const whaleShares = parseInteger(whaleRow?.[3] || "0");
  const whalePeople = parseInteger(whaleRow?.[2] || "0");
  const retailShares = rows
    .filter((row) => Number(row[0]) >= 1 && Number(row[0]) <= 6)
    .reduce((sum, row) => sum + parseInteger(row[3] || "0"), 0);
  if (totalShares <= 0 || whaleShares > totalShares || retailShares > totalShares) return null;
  return {
    stock_id: stockId,
    date: isoDate(date),
    source: "tdcc",
    total_shares: totalShares,
    whale_ratio: Math.round((whaleShares / totalShares) * 10_000) / 100,
    retail_ratio: Math.round((retailShares / totalShares) * 10_000) / 100,
    total_people: totalPeople,
    whale_shares: whaleShares,
    whale_people: whalePeople,
  };
}

async function openSession(fetchImpl: typeof fetch): Promise<TdccSession> {
  const response = await fetchImpl(TDCC_HISTORY_URL, {
    headers: { "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`TDCC history page HTTP ${response.status}`);
  const html = await response.text();
  const token = hiddenValue(html, "SYNCHRONIZER_TOKEN");
  if (!token) throw new Error("TDCC history page did not provide a synchronizer token");
  return {
    cookie: response.headers.get("set-cookie")?.split(";")[0] || "",
    token,
    dates: availableDates(html),
  };
}

async function fetchHistoryWeek(
  fetchImpl: typeof fetch,
  session: TdccSession,
  stockId: string,
  date: string,
): Promise<LocalTdccRecord | null> {
  const body = new URLSearchParams({
    SYNCHRONIZER_TOKEN: session.token,
    SYNCHRONIZER_URI: "/portal/zh/smWeb/qryStock",
    method: "submit",
    firDate: date,
    scaDate: date,
    sqlMethod: "StockNo",
    stockNo: stockId,
    stockName: "",
  });
  const response = await fetchImpl(TDCC_HISTORY_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: session.cookie,
      Referer: TDCC_HISTORY_URL,
      "User-Agent": USER_AGENT,
    },
    body,
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`TDCC history query HTTP ${response.status}`);
  const html = await response.text();
  session.token = hiddenValue(html, "SYNCHRONIZER_TOKEN");
  if (!session.token) throw new Error("TDCC history session token expired");
  return parseHistoryRecord(html, stockId, date);
}

export async function runTdccLocal(
  args: string[] = process.argv.slice(2),
  dependencies: LocalTdccRunnerDependencies = {},
): Promise<void> {
  const options = parseOptions(args);
  const fetchImpl = dependencies.fetchImpl ?? globalThis.fetch;
  const openDatabase = dependencies.openDatabase ?? ((readonly: boolean) =>
    new Database(requireExplicitSqlitePath(), { readonly, fileMustExist: readonly }));
  const log = dependencies.log ?? console.log;
  const db = openDatabase(options.dryRun);
  try {
    if (options.dryRun) {
      const report = buildLocalTdccDryRunReport(db, options.limit, options.stockId);
      log(JSON.stringify(report, null, 2));
      return;
    }
    db.pragma("journal_mode = WAL");

  const discoverySession = await openSession(fetchImpl);
  const compactDates = discoverySession.dates.slice(0, 52);
  if (compactDates.length < 52) {
    throw new Error(`TDCC history page exposed only ${compactDates.length}/52 dates`);
  }
  const targetDates = compactDates.map(isoDate);
  const candidates = buildLocalTdccBackfillPlan(
    db,
    targetDates,
    options.limit,
    options.stockId,
  );

  log(`Local TDCC queue: ${candidates.length} stocks, delay ${options.requestDelayMs} ms/request`);

  const upsert = (dependencies.createUpsert ?? createLocalTdccUpsert)(db);

  let completed = 0;
  let inserted = 0;
  const failures: { stockId: string; error: string }[] = [];

  for (const candidate of candidates) {
    const stockId = candidate.stockId;
    try {
      const session = await openSession(fetchImpl);
      const dates = session.dates.slice(0, 52);
      const existingDates = selectExistingCoreCompleteDates(db, stockId, dates.map(isoDate));
      const missingDates = dates.filter((date) => !existingDates.has(isoDate(date)));
      let stockInserted = 0;
      for (const date of missingDates) {
        const record = await fetchHistoryWeek(fetchImpl, session, stockId, date);
        if (record) {
          upsert(record);
          stockInserted += 1;
        }
        if (options.requestDelayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, options.requestDelayMs));
        }
      }
      completed += 1;
      inserted += stockInserted;
      log(`${stockId}: +${stockInserted}, available ${session.dates.length}`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      failures.push({ stockId, error: msg });
      console.error(`${stockId}: ${msg}`);
    }
  }

  const dbBytes = (db.prepare("SELECT page_count * page_size AS size FROM pragma_page_count(), pragma_page_size()").get() as { size: number }).size;
  log(
    `Local done: ${completed}/${candidates.length} stocks, +${inserted} weeks, database ${(dbBytes / MIB).toFixed(1)} MiB`,
  );
  if (failures.length > 0) {
    log("Failures:");
    for (const f of failures) log(`  ${f.stockId}: ${f.error}`);
  }
  } finally {
    db.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  throw new Error("TDCC backfill is disabled during database-authority phase one");
}

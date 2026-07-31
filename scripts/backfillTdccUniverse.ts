import { backfillTdccHistory } from "../server/lib/tdccHistory";
import { supabaseAdmin } from "../server/lib/runtimeState";
import { isOrdinaryStockId } from "../server/lib/stockUniverse";

const MIB = 1024 * 1024;
const STOP_AT_BYTES = 450 * MIB;

interface Options {
  limit: number;
  requestDelayMs: number;
  stockId?: string;
}

interface StorageStatus {
  database_bytes?: number | string;
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
    limit: Math.min(positiveInteger(values.get("limit"), 5), 100),
    requestDelayMs: Math.max(positiveInteger(values.get("delay-ms"), 500), 250),
    stockId: values.get("stock-id"),
  };
}

async function storageBytes(): Promise<number> {
  const { data, error } = await supabaseAdmin!.rpc("cloud_storage_status");
  if (error) throw new Error(`Cannot read cloud storage status: ${error.message}`);
  const status = (Array.isArray(data) ? data[0] : data) as StorageStatus | null;
  return Number(status?.database_bytes || 0);
}

async function activeOrdinaryStockIds(): Promise<string[]> {
  const stockIds: string[] = [];
  for (let offset = 0; ; offset += 1_000) {
    const { data, error } = await supabaseAdmin!
      .from("stock_meta")
      .select("stock_id")
      .eq("status", "active")
      .order("stock_id")
      .range(offset, offset + 999);
    if (error) throw new Error(`Cannot read active stocks: ${error.message}`);
    stockIds.push(...(data || []).map((row) => row.stock_id));
    if (!data || data.length < 1_000) break;
  }
  return stockIds.filter(isOrdinaryStockId);
}

async function tdccCoverage(): Promise<Map<string, number>> {
  const coverage = new Map<string, number>();
  for (let offset = 0; ; offset += 1_000) {
    const { data, error } = await supabaseAdmin!
      .from("tdcc_shareholding")
      .select("stock_id")
      .range(offset, offset + 999);
    if (error) throw new Error(`Cannot read TDCC coverage: ${error.message}`);
    for (const row of data || []) {
      coverage.set(row.stock_id, (coverage.get(row.stock_id) || 0) + 1);
    }
    if (!data || data.length < 1_000) break;
  }
  return coverage;
}

async function run(): Promise<void> {
  if (!supabaseAdmin) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
  const options = parseOptions(process.argv.slice(2));
  const [stockIds, coverage] = await Promise.all([activeOrdinaryStockIds(), tdccCoverage()]);
  if (options.stockId && !stockIds.includes(options.stockId)) {
    throw new Error(`${options.stockId} is not an active ordinary stock`);
  }
  const candidates = options.stockId
    ? [options.stockId]
    : stockIds
      // Only backfill symbols present in the official latest-week file. Symbols
      // absent from that file repeatedly return an empty history page.
      .filter((stockId) => (coverage.get(stockId) || 0) > 0 && (coverage.get(stockId) || 0) < 52)
      .sort((left, right) =>
        (coverage.get(left) || 0) - (coverage.get(right) || 0) || left.localeCompare(right),
      )
      .slice(0, options.limit);

  console.log(`TDCC queue: ${candidates.length} stocks, delay ${options.requestDelayMs} ms/request`);
  let completed = 0;
  let inserted = 0;
  for (const stockId of candidates) {
    const bytes = await storageBytes();
    if (bytes >= STOP_AT_BYTES) {
      console.log(`Stopped at ${(bytes / MIB).toFixed(1)} MiB (safety line: 450 MiB)`);
      break;
    }
    try {
      const result = await backfillTdccHistory(stockId, {
        maxWeeks: 52,
        requestDelayMs: options.requestDelayMs,
      });
      completed += 1;
      inserted += result.insertedWeeks;
      console.log(
        `${stockId}: +${result.insertedWeeks}, existing ${result.skippedWeeks}, available ${result.availableWeeks}`,
      );
    } catch (error) {
      console.error(`${stockId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const finalBytes = await storageBytes();
  console.log(
    `Done: ${completed}/${candidates.length} stocks, +${inserted} weeks, database ${(finalBytes / MIB).toFixed(1)} MiB`,
  );
}

run().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

import Database from "better-sqlite3";
import path from "path";
import { createSupabaseAdminClient } from "./lib/supabaseAdmin";

const RETAIN_ROWS = 512;
const BATCH_SIZE = 500;
const MAX_RETRIES = 3;

interface PriceRow {
  stock_id: string;
  date: string;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  volume: number | null;
  amount: number | null;
  trade_count: number | null;
  spread: number | null;
}

type SupabaseAdminClient = ReturnType<typeof createSupabaseAdminClient>;

function getDatabasePath(): string {
  return process.env.SQLITE_DB_PATH
    ? path.resolve(process.env.SQLITE_DB_PATH)
    : path.join(process.cwd(), "twstock", "taiwan_stock_unified.db");
}

async function upsertWithRetry(
  supabase: SupabaseAdminClient,
  rows: PriceRow[],
  label: string
): Promise<void> {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const { error } = await supabase
      .from("stock_price")
      .upsert(rows, { onConflict: "stock_id,date" });
    if (!error) return;
    console.warn(`[BulkLoad] ${label}, attempt ${attempt}: ${error.message}`);
    if (attempt < MAX_RETRIES) {
      await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
    }
  }
  throw new Error(`${label} failed after ${MAX_RETRIES} attempts`);
}

function selectLatestRows(db: Database): PriceRow[] {
  return db.prepare(`
    SELECT stock_id, date, open, high, low, close, volume, amount, trade_count, spread
    FROM (
      SELECT stock_id, date, open, high, low, close, volume, amount, trade_count, spread,
             ROW_NUMBER() OVER (PARTITION BY stock_id ORDER BY date DESC) AS row_number
      FROM stock_history
    )
    WHERE row_number <= ?
    ORDER BY stock_id, date
  `).all(RETAIN_ROWS) as PriceRow[];
}

async function run(): Promise<void> {
  const execute = process.argv.includes("--execute");
  const db = new Database(getDatabasePath(), { readonly: true, fileMustExist: true });
  try {
    const rows = selectLatestRows(db);
    console.log(`[BulkLoad] Prepared ${rows.length} rows (latest ${RETAIN_ROWS} per stock).`);
    if (!execute) {
      console.log("[BulkLoad] Dry-run only. Add --execute to upload.");
      return;
    }

    const supabase = createSupabaseAdminClient();
    for (let offset = 0; offset < rows.length; offset += BATCH_SIZE) {
      const batch = rows.slice(offset, offset + BATCH_SIZE);
      await upsertWithRetry(supabase, batch, `rows ${offset + 1}-${offset + batch.length}`);
      if (offset % 50_000 === 0) {
        console.log(`[BulkLoad] Uploaded ${offset + batch.length}/${rows.length}`);
      }
    }
    console.log(`[BulkLoad] Uploaded ${rows.length} rows.`);
  } finally {
    db.close();
  }
}

run().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[BulkLoad] Failed: ${message}`);
  process.exitCode = 1;
});

import { createSupabaseAdminClient } from "./lib/supabaseAdmin";

const RETAIN_ROWS = 512;
const CONFIRM_VALUE = "DELETE_SUPABASE_HISTORY";

function shouldExecute(): boolean {
  const requested = process.argv.includes("--execute");
  const confirmed = process.env.CONFIRM_SUPABASE_PRUNE === CONFIRM_VALUE;
  if (requested && !confirmed) {
    throw new Error(
      `--execute requires CONFIRM_SUPABASE_PRUNE=${CONFIRM_VALUE}`
    );
  }
  return requested;
}

async function run(): Promise<void> {
  const execute = shouldExecute();
  const supabase = createSupabaseAdminClient();
  console.log(
    `[Prune] ${execute ? "EXECUTE" : "DRY-RUN"}: retain latest ${RETAIN_ROWS} rows per stock`
  );

  const { data, error } = await supabase.rpc("prune_stock_price_retention", {
    retain_rows: RETAIN_ROWS,
    execute_delete: execute,
  });
  if (error) throw new Error(error.message);

  const result = Array.isArray(data) ? data[0] : data;
  console.log(`[Prune] candidate rows: ${Number(result?.candidate_rows || 0)}`);
  console.log(`[Prune] deleted rows: ${Number(result?.deleted_rows || 0)}`);
  if (!execute) {
    console.log("[Prune] No data changed. Use --execute with explicit confirmation to delete.");
  }
}

run().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[Prune] Failed: ${message}`);
  process.exitCode = 1;
});

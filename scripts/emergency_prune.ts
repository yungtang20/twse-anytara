import { createClient } from "@supabase/supabase-js";

const TABLES = ["stock_price", "stock_institutional", "tdcc_shareholding", "stock_features"] as const;

function executionProjectRef(args = process.argv.slice(2), env = process.env): string | null {
  if (!args.includes("--execute")) return null;
  const index = args.indexOf("--project-ref");
  const supplied = index >= 0 ? args[index + 1]?.trim() : "";
  if (!supplied) throw new Error("--project-ref is required with --execute");
  const expected = env.SUPABASE_PROJECT_REF?.trim();
  if (!expected || supplied !== expected) throw new Error("project ref mismatch");
  return supplied;
}

async function run(): Promise<void> {
  const projectRef = executionProjectRef();
  if (!projectRef) {
    console.log(`DRY RUN: retain the latest 250 trading days and prune older rows from ${TABLES.join(", ")}.`);
    console.log("No network connection or mutation was performed. Use --execute --project-ref <SUPABASE_PROJECT_REF> to run.");
    return;
  }

  const url = (process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL)?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
  const supabase = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

  const { data: dates, error: datesError } = await supabase.from("stock_price").select("date")
    .eq("stock_id", "2330").order("date", { ascending: false }).limit(250);
  if (datesError) throw new Error("failed_to_read_retention_cutoff", { cause: datesError });
  if (!dates || dates.length === 0) throw new Error("retention_cutoff_unavailable");
  const cutoff = dates.at(-1)?.date;
  if (typeof cutoff !== "string") throw new Error("retention_cutoff_invalid");

  const { data: oldDates, error: oldDatesError } = await supabase.from("stock_price").select("date")
    .eq("stock_id", "2330").lt("date", cutoff).order("date", { ascending: true });
  if (oldDatesError) throw new Error("failed_to_read_prune_dates", { cause: oldDatesError });
  const values = [...new Set((oldDates ?? []).map((row) => row.date).filter((date): date is string => typeof date === "string"))];
  console.log(`Executing prune for project ${projectRef}: ${values.length} dates older than ${cutoff}.`);
  for (const date of values) {
    for (const table of TABLES) {
      const { error } = await supabase.from(table).delete().eq("date", date);
      if (error) throw new Error(`prune_failed:${table}:${date}`, { cause: error });
    }
  }
  console.log(`Prune completed: ${values.length} dates processed.`);
}

run().catch((error: unknown) => {
  console.error("Emergency prune failed:", error instanceof Error ? error.message : "unknown_error");
  process.exitCode = 1;
});

import dotenv from "dotenv";
import pg from "pg";

dotenv.config();

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
    console.log(`DRY RUN: VACUUM FULL would lock and rewrite ${TABLES.join(", ")}.`);
    console.log("No database connection was opened. Use --execute --project-ref <SUPABASE_PROJECT_REF> to run.");
    return;
  }
  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) throw new Error("DATABASE_URL is required");
  const pool = new pg.Pool({ connectionString, ssl: { rejectUnauthorized: true } });
  try {
    console.log(`Executing VACUUM FULL for project ${projectRef}.`);
    for (const table of TABLES) await pool.query(`VACUUM FULL ${table}`);
    console.log("VACUUM FULL completed.");
  } finally {
    await pool.end();
  }
}

run().catch((error: unknown) => {
  console.error("VACUUM FULL failed:", error instanceof Error ? error.message : "unknown_error");
  process.exitCode = 1;
});

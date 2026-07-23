import pg from "pg";
import dotenv from "dotenv";

dotenv.config();

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  console.error("❌ DATABASE_URL is not set in environment!");
  process.exit(1);
}

// Disable SSL certificate validation for connection flexibility if needed
const pool = new pg.Pool({
  connectionString,
  ssl: {
    rejectUnauthorized: false
  }
});

async function run() {
  console.log("🚀 Connecting to Supabase via direct connection to run VACUUM FULL...");
  try {
    // pg driver can run VACUUM if not in a transaction block
    // default pool.query runs a single statement without an explicit BEGIN/COMMIT block
    console.log("Running VACUUM FULL on stock_price...");
    await pool.query('VACUUM FULL stock_price');
    console.log("Running VACUUM FULL on stock_institutional...");
    await pool.query('VACUUM FULL stock_institutional');
    console.log("Running VACUUM FULL on tdcc_shareholding...");
    await pool.query('VACUUM FULL tdcc_shareholding');
    console.log("Running VACUUM FULL on stock_features...");
    await pool.query('VACUUM FULL stock_features');
    console.log("✅ VACUUM FULL completed successfully. Disk space should be reclaimed.");
  } catch (err: any) {
    console.error("❌ Failed to run VACUUM FULL:", err.message);
  } finally {
    await pool.end();
  }
}

run();

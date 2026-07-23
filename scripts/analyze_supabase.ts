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
  console.log("🚀 Connecting to Supabase via direct connection to analyze storage...");

  // 1. Table Sizes Query
  const sizeQuery = `
    SELECT 
      schemaname AS schema,
      relname AS table_name,
      pg_size_pretty(pg_total_relation_size(relid)) AS total_size,
      pg_size_pretty(pg_relation_size(relid)) AS table_size,
      pg_size_pretty(pg_total_relation_size(relid) - pg_relation_size(relid)) AS index_size,
      n_dead_tup AS dead_tuples,
      n_live_tup AS live_tuples
    FROM pg_catalog.pg_stat_user_tables
    ORDER BY pg_total_relation_size(relid) DESC;
  `;

  try {
    const { rows: sizes } = await pool.query(sizeQuery);
    console.log("\n📊 [Database Tables and Size Analysis]:");
    console.table(sizes);
  } catch (err: any) {
    console.error("❌ Failed to query table sizes:", err.message);
  }

  // 2. Duplicates Check Query for stock_price
  console.log("\n🔍 Checking for duplicate records on (stock_id, date) in stock_price...");
  const dupPriceQuery = `
    SELECT stock_id, date, COUNT(*) as count
    FROM stock_price
    GROUP BY stock_id, date
    HAVING COUNT(*) > 1
    LIMIT 10;
  `;

  try {
    const { rows: dupPrices } = await pool.query(dupPriceQuery);
    if (dupPrices.length > 0) {
      console.log(`⚠️ Found duplicate keys in stock_price! (Showing up to 10):`);
      console.table(dupPrices);
      
      const totalDupGroupsQuery = `
        SELECT COUNT(*) as total_dup_groups, SUM(count - 1) as total_redundant_rows
        FROM (
          SELECT stock_id, date, COUNT(*) as count
          FROM stock_price
          GROUP BY stock_id, date
          HAVING COUNT(*) > 1
        ) as sub;
      `;
      const { rows: totalDups } = await pool.query(totalDupGroupsQuery);
      console.log(`  - Total duplicate groups: ${totalDups[0].total_dup_groups}`);
      console.log(`  - Total redundant rows to prune: ${totalDups[0].total_redundant_rows}`);
    } else {
      console.log("✅ No duplicate (stock_id, date) records found in stock_price.");
    }
  } catch (err: any) {
    console.error("❌ Failed to query stock_price duplicates:", err.message);
  }

  // 3. Duplicates Check Query for stock_institutional
  console.log("\n🔍 Checking for duplicate records on (stock_id, date) in stock_institutional...");
  const dupInstQuery = `
    SELECT stock_id, date, COUNT(*) as count
    FROM stock_institutional
    GROUP BY stock_id, date
    HAVING COUNT(*) > 1
    LIMIT 10;
  `;

  try {
    const { rows: dupInsts } = await pool.query(dupInstQuery);
    if (dupInsts.length > 0) {
      console.log(`⚠️ Found duplicate keys in stock_institutional! (Showing up to 10):`);
      console.table(dupInsts);
      
      const totalDupGroupsQuery = `
        SELECT COUNT(*) as total_dup_groups, SUM(count - 1) as total_redundant_rows
        FROM (
          SELECT stock_id, date, COUNT(*) as count
          FROM stock_institutional
          GROUP BY stock_id, date
          HAVING COUNT(*) > 1
        ) as sub;
      `;
      const { rows: totalDups } = await pool.query(totalDupGroupsQuery);
      console.log(`  - Total duplicate groups: ${totalDups[0].total_dup_groups}`);
      console.log(`  - Total redundant rows to prune: ${totalDups[0].total_redundant_rows}`);
    } else {
      console.log("✅ No duplicate (stock_id, date) records found in stock_institutional.");
    }
  } catch (err: any) {
    console.error("❌ Failed to query stock_institutional duplicates:", err.message);
  }

  // 4. Duplicates Check Query for stock_features
  console.log("\n🔍 Checking for duplicate records on (stock_id, date) in stock_features...");
  const dupFeatQuery = `
    SELECT stock_id, date, COUNT(*) as count
    FROM stock_features
    GROUP BY stock_id, date
    HAVING COUNT(*) > 1
    LIMIT 10;
  `;

  try {
    const { rows: dupFeats } = await pool.query(dupFeatQuery);
    if (dupFeats.length > 0) {
      console.log(`⚠️ Found duplicate keys in stock_features! (Showing up to 10):`);
      console.table(dupFeats);
      
      const totalDupGroupsQuery = `
        SELECT COUNT(*) as total_dup_groups, SUM(count - 1) as total_redundant_rows
        FROM (
          SELECT stock_id, date, COUNT(*) as count
          FROM stock_features
          GROUP BY stock_id, date
          HAVING COUNT(*) > 1
        ) as sub;
      `;
      const { rows: totalDups } = await pool.query(totalDupGroupsQuery);
      console.log(`  - Total duplicate groups: ${totalDups[0].total_dup_groups}`);
      console.log(`  - Total redundant rows to prune: ${totalDups[0].total_redundant_rows}`);
    } else {
      console.log("✅ No duplicate (stock_id, date) records found in stock_features.");
    }
  } catch (err: any) {
    console.error("❌ Failed to query stock_features duplicates:", err.message);
  }

  await pool.end();
}

run().catch(err => {
  console.error("Critical error analyzing Supabase:", err);
});

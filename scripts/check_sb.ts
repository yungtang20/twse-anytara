import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import { describeSupabaseError } from "../server/lib/supabaseDiagnostics";

dotenv.config();

const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const key = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;

if (!url || !key) {
  console.error("Missing credentials");
  process.exit(1);
}

const supabase = createClient(url, key);

async function run() {
  console.log("Checking current Supabase data...");

  const tables = ["stock_price", "stock_institutional", "stock_meta", "stock_features"];

  for (const t of tables) {
    const { count, error } = await supabase
      .from(t)
      .select("stock_id", { count: "exact" })
      .limit(1);
      
    if (error) {
      console.error(`Error counting ${t}:`, JSON.stringify(describeSupabaseError(error, url)));
    } else {
      console.log(`Table ${t}: ${count} rows`);
    }
  }

}

run();

import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

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

  const tables = ["stock_price", "stock_institutional", "stock_meta"];

  for (const t of tables) {
    const { count, error } = await supabase
      .from(t)
      .select("*", { count: "exact", head: true });
      
    if (error) {
      console.error(`Error counting ${t}:`, error.message);
    } else {
      console.log(`Table ${t}: ${count} rows`);
    }
  }

  // Get some samples
  const { data: priceSamples } = await supabase.from("stock_price").select("stock_id, date").limit(5);
  console.log("stock_price samples:", priceSamples);

  const { data: instSamples } = await supabase.from("stock_institutional").select("stock_id, date").limit(5);
  console.log("stock_institutional samples:", instSamples);
}

run();

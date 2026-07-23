import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

dotenv.config();

const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const key = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;

if (!url || !key) throw new Error("Missing SUPABASE_URL or SUPABASE_ANON_KEY");

const supabase = createClient(url, key);

async function run() {
  console.log("Checking schema / column names in Supabase tables...");

  const { data: priceSample } = await supabase.from("stock_price").select("*").limit(1);
  console.log("stock_price column keys:", priceSample ? Object.keys(priceSample[0]) : "none", priceSample);

  const { data: instSample } = await supabase.from("stock_institutional").select("*").limit(1);
  console.log("stock_institutional column keys:", instSample ? Object.keys(instSample[0]) : "none", instSample);

  const { data: metaSample } = await supabase.from("stock_meta").select("*").limit(1);
  console.log("stock_meta column keys:", metaSample ? Object.keys(metaSample[0]) : "none", metaSample);
}

run();

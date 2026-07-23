import { createClient } from "@supabase/supabase-js";
import { execSync } from "child_process";

const supabase = createClient((process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL)!, (process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY)!);

async function run() {
  console.log("Preparing to pull data...");
  // Use the pull script to fetch data. We need to make sure the pull script is aware of the 512 limit or we just run the regular pull.
}

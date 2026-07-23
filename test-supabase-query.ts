import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

dotenv.config({ override: true });

const url = process.env.VITE_SUPABASE_URL || "";
const key = process.env.VITE_SUPABASE_ANON_KEY || "";

const supabase = createClient(url, key);

async function check() {
  console.log("Checking user_settings table...");
  const { data, error } = await supabase.from("user_settings").select("*").limit(1);
  if (error) {
    console.log("Error:", error);
  } else {
    console.log("Success! Data:", data);
  }
}

check();

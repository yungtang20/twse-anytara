import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
dotenv.config();
const supabase = createClient((process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL)!, (process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY)!);
async function check() {
  const { count } = await supabase.from('stock_price').select('date', { count: 'exact', head: true }).eq('stock_id', '2330');
  console.log(`Current trading days in DB: ${count} / 512`);
}
check();

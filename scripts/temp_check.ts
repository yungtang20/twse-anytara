import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
dotenv.config();

const supabase = createClient((process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL)!, (process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY)!);

async function check() {
  const tables = ['stock_price', 'stock_institutional', 'stock_features', 'tdcc_shareholding'];
  for (const t of tables) {
    const { count, error } = await supabase.from(t).select('*', { count: 'exact', head: true });
    console.log(`Table ${t}: ${count} rows`);
  }
  
  const { data } = await supabase.from('stock_price').select('date').eq('stock_id', '2330').order('date', { ascending: false });
  console.log(`2330 has ${data?.length} days of data. Oldest: ${data?.[data?.length-1]?.date}, Newest: ${data?.[0]?.date}`);
}
check();

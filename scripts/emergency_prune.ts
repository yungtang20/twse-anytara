import { createClient } from "@supabase/supabase-js";

const url = (process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL)!;
const key = (process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY)!;
const supabase = createClient(url, key);

async function run() {
  console.log("🚨 Emergency pruning to 250 trading days...");
  const { data: dates } = await supabase
    .from("stock_price")
    .select("date")
    .eq("stock_id", "2330")
    .order("date", { ascending: false })
    .limit(250);
    
  if (!dates || dates.length === 0) {
    console.log("No dates found.");
    return;
  }
  
  const cutoff = dates[dates.length - 1].date;
  console.log("New Cutoff date:", cutoff);
  
  // Find all dates older than cutoff
  const { data: oldDates } = await supabase
    .from("stock_price")
    .select("date")
    .eq("stock_id", "2330")
    .lt("date", cutoff)
    .order("date", { ascending: true });
    
  if (oldDates && oldDates.length > 0) {
    console.log(`Found ${oldDates.length} days of data to delete.`);
    for (let i = 0; i < oldDates.length; i++) {
       const d = oldDates[i].date;
       console.log(`🧹 Deleting data for date ${d} (${i+1}/${oldDates.length})...`);
       await supabase.from("stock_price").delete().eq("date", d);
       await supabase.from("stock_institutional").delete().eq("date", d);
       await supabase.from("tdcc_shareholding").delete().eq("date", d);
       await supabase.from("stock_features").delete().eq("date", d);
    }
  } else {
    console.log("No older data found.");
  }
  
  console.log("✅ Emergency pruning completed!");
}
run();

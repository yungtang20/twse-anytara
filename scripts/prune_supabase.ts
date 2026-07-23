import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

dotenv.config();

const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const key = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;

if (!url || !key) {
  console.error("❌ Need SUPABASE_URL and SUPABASE_ANON_KEY to prune Supabase!");
  process.exit(1);
}

const supabase = createClient(url, key);

async function run() {
  console.log("🚀 [Prune] Initializing Supabase robust batched pruning (for 512 trading days + pure regular stocks)...");

  // 1. 取得天天交易的台積電 (2330) 作為基準，找出第 512 個交易日的日期
  const MAX_TRADING_DAYS = 512; // 512 天，只留普通股 4 碼，容量絕對能控制在 500MB 以內
  console.log(`🔍 [Prune] Querying ${MAX_TRADING_DAYS} trading day timeline from stock_price...`);
  const { data: dates, error: dateError } = await supabase
    .from("stock_price")
    .select("date")
    .eq("stock_id", "2330")
    .order("date", { ascending: false })
    .range(MAX_TRADING_DAYS - 1, MAX_TRADING_DAYS - 1);

  if (dateError) {
    console.error("❌ Failed to query trading days:", dateError.message);
    process.exit(1);
  }

  if (!dates?.length) {
    console.warn("⚠️ Less than 512 trading days available; pruning skipped to avoid deleting valid data.");
    return;
  }
  const cutoffDate = dates[0].date;
  console.log(`🎯 [Prune] Cutoff date selected: ${cutoffDate} (keeping latest ${MAX_TRADING_DAYS} trading days to limit database size)`);
  // ponytail: stock_id 長度不能可靠辨識商品類型；若要依商品刪除，先加入官方 instrument_type。

  // 3. 刪除早於限制日期的最舊普通股數據（4 碼股票）
  console.log(`🧹 [Prune] Removing regular stock data older than ${cutoffDate} (Older than ${MAX_TRADING_DAYS} trading days)...`);
  
  // 分段時間進行歷史大刪除以避免超時。我們找最舊的普通股日期
  const { data: oldestPrices } = await supabase
    .from("stock_price")
    .select("date")
    .order("date", { ascending: true })
    .limit(1);

  if (oldestPrices && oldestPrices.length > 0) {
    const oldestDateStr = oldestPrices[0].date;
    console.log(`📍 [Prune] Oldest date in DB currently is: ${oldestDateStr}`);
    
    if (oldestDateStr < cutoffDate) {
      let currentStart = new Date(oldestDateStr);
      const targetEnd = new Date(cutoffDate);
      
      while (currentStart < targetEnd) {
        let nextEnd = new Date(currentStart);
        nextEnd.setDate(nextEnd.getDate() + 14); // 每 14 天一個批次
        if (nextEnd > targetEnd) nextEnd = targetEnd;
        
        const startStr = currentStart.toISOString().split("T")[0];
        const endStr = nextEnd.toISOString().split("T")[0];
        console.log(`   👉 Deleting batch: [${startStr} to ${endStr}]`);
        
        await supabase.from("stock_price").delete().gte("date", startStr).lt("date", endStr);
        await supabase.from("stock_institutional").delete().gte("date", startStr).lt("date", endStr);
        await supabase.from("stock_features").delete().gte("date", startStr).lt("date", endStr);
        await supabase.from("tdcc_shareholding").delete().gte("date", startStr).lt("date", endStr);
        
        currentStart = nextEnd;
      }
    }
  }

  console.log("\n🎉 [Prune] Supabase 512-day storage optimization successfully completed!");
  console.log(`💡 Note: All instrument types are retained for the latest ${MAX_TRADING_DAYS} trading days.`);
}

run().catch(err => {
  console.error("Critical error in pruning script:", err);
});

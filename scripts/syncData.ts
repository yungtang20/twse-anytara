import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  (process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL) as string,
  (process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY) as string
);

// 轉化民國日期（動態取得今天日期）
const getLatestTradingDate = () => {
  const taipeiNow = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Taipei" }));
  const yyyy = taipeiNow.getFullYear();
  const mm = String(taipeiNow.getMonth() + 1).padStart(2, '0');
  const dd = String(taipeiNow.getDate()).padStart(2, '0');
  return `${yyyy}${mm}${dd}`;
};

const parseNum = (str: string) => {
  if (!str) return 0;
  const num = parseFloat(str.replace(/,/g, ""));
  return isNaN(num) ? 0 : num;
};

const parseSpread = (str: string) => {
  if (!str) return 0;
  let sign = 1;
  if (str.includes("green") || str.includes("-")) sign = -1;
  const text = str.replace(/<[^>]*>?/gm, "").trim();
  const num = parseFloat(text.replace(/,/g, ""));
  return isNaN(num) ? 0 : num * sign;
};

async function syncDailyPrices() {
  // Dynamic search for latest valid trading date (handling holidays/weekends)
  const taipeiNow = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Taipei" }));
  
  let activeTradingDate = null;
  let activeRocDate = null;
  let activeYyyyMmDd = null;
  let activeYyyy = null;
  let activeMm = null;
  let activeDd = null;
  let twseParsedJson = null;

  console.log(`\n🔎 [Sync] Searching backward to find the latest valid trading day from TWSE (checking up to 8 days)...`);
  for (let i = 0; i < 8; i++) {
    const checkDate = new Date(taipeiNow);
    checkDate.setDate(checkDate.getDate() - i);
    const cyyyy = checkDate.getFullYear();
    const cmm = String(checkDate.getMonth() + 1).padStart(2, '0');
    const cdd = String(checkDate.getDate()).padStart(2, '0');
    const dateStr = `${cyyyy}${cmm}${cdd}`;
    
    try {
      const twseUrl = `https://www.twse.com.tw/exchangeReport/MI_INDEX?response=json&date=${dateStr}&type=ALLBUT0999`;
      const res = await fetch(twseUrl, { headers: { "User-Agent": "Mozilla/5.0" } });
      const json = await res.json() as any;
      const priceTable = json?.tables?.find((t: any) => t.title?.includes("行情"));
      if (json.stat === "OK" && priceTable?.data) {
        activeTradingDate = `${cyyyy}-${cmm}-${cdd}`;
        activeRocDate = `${cyyyy - 1911}/${cmm}/${cdd}`;
        activeYyyyMmDd = dateStr;
        activeYyyy = cyyyy;
        activeMm = cmm;
        activeDd = cdd;
        twseParsedJson = json;
        console.log(`  👉 Found valid trading day: ${activeTradingDate} (${dateStr}).`);
        break;
      } else {
        console.log(`  - Date ${dateStr} is closed or has no data (${json.stat || 'No data'}).`);
      }
    } catch (err) {
      console.warn(`  ⚠️ Error checking date ${dateStr}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (!activeTradingDate) {
    console.error("❌ Failed to find a valid trading day in the last 8 days!");
    process.exit(1);
  }

  const dateStr = activeYyyyMmDd;
  const isoDate = activeTradingDate;
  const tpexDate = activeRocDate;
  console.log(`[Sync] Fetching TWSE & TPEX data for ${dateStr}...`);

  const records: any[] = [];

  // TWSE
  try {
    const json = twseParsedJson;
    const priceTable = json?.tables?.find((t: any) => t.title?.includes("行情"));
    
    if (priceTable?.data) {
      for (const row of priceTable.data) {
        const id = row[0];
        const volume = Math.min(parseNum(row[2]), 9999999999); // 成交股數
        const trade_count = parseNum(row[3]); // 成交筆數
        const amount = Math.min(parseNum(row[4]), 9999999999); // 成交金額
        const open = parseNum(row[5]);
        const high = parseNum(row[6]);
        const low = parseNum(row[7]);
        const close = parseNum(row[8]);
        const spread = parseSpread(row[9] + row[10]);

        if (volume > 0 && close > 0 && /^\d{4}$/.test(id)) {
          records.push({
            stock_id: id,
            date: isoDate,
            open, high, low, close, volume, amount, trade_count, spread,
            updated_at: new Date().toISOString()
          });
        }
      }
      console.log(`[Sync] TWSE table parsed, extracted ${priceTable.data.length} rows.`);
    }
  } catch (e: any) {
    console.error("TWSE Error", e.message);
  }

  // TPEX
  try {
    const res = await fetch(`https://www.tpex.org.tw/web/stock/aftertrading/otc_quotes_no1430/stk_wn1430_result.php?l=zh-tw&d=${tpexDate}&se=EW`, { headers: { "User-Agent": "Mozilla/5.0" } });
    const json = await res.json() as any;
    if (json?.tables?.[0]?.data) {
      for (const row of json.tables[0].data) {
        const id = row[0];
        const close = parseNum(row[2]);
        const spread = parseSpread(row[3]);
        const open = parseNum(row[4]);
        const high = parseNum(row[5]);
        const low = parseNum(row[6]);
        const volume = Math.min(parseNum(row[7]), 9999999999);
        const amount = Math.min(parseNum(row[8]), 9999999999);
        const trade_count = parseNum(row[9]);

        if (volume > 0 && close > 0 && /^\d{4}$/.test(id)) {
          records.push({
            stock_id: id,
            date: isoDate,
            open, high, low, close, volume, amount, trade_count, spread,
            updated_at: new Date().toISOString()
          });
        }
      }
      console.log(`[Sync] TPEX table parsed, extracted ${json.tables[0].data.length} rows.`);
    }
  } catch (e: any) {
    console.error("TPEX Error", e.message);
  }

  console.log(`[Sync] Total valid records to insert: ${records.length}`);
  
  // Upsert in batches of 500
  let successCount = 0;
  for (let i = 0; i < records.length; i += 500) {
    const batch = records.slice(i, i + 500);
    const { error } = await supabase.from("stock_price").upsert(batch, { onConflict: "stock_id,date" });
    if (error) {
      console.error(`[Sync] Batch ${i} Error:`, error.message);
    } else {
      successCount += batch.length;
    }
  }
  
  console.log(`[Sync] Successfully upserted ${successCount} records to Supabase.`);

  // 總容量控制，保留最近 512 個交易日（滿足用戶 512 天普通股/法人/TDCC 數據的策略需求）
  // 我們透過查詢天天交易的台積電 (2330)，取得其第 512 筆的日期作為 cutoffDate。
  const { data: dates } = await supabase
    .from("stock_price")
    .select("date")
    .eq("stock_id", "2330")
    .order("date", { ascending: false })
    .range(511, 511);

  if (dates && dates.length > 0) {
    const cutoffDate = dates[0].date;
    console.log(`[Sync] Triggering cleanup for data older than: ${cutoffDate} (keeping latest 512 trading days max)`);
    
    // stock_id 長度不能可靠判斷商品類型，只依保留日期清理。
    const { error: err1 } = await supabase.from("stock_price").delete().lt("date", cutoffDate);
    if (err1) console.error("[Sync] Price table cleanup error:", err1.message);
    
    // 2. 清理 stock_institutional
    const { error: err2 } = await supabase.from("stock_institutional").delete().lt("date", cutoffDate);
    if (err2) console.error("[Sync] Institutional table cleanup error:", err2.message);
    
    // 3. 清理 stock_features
    const { error: err3 } = await supabase.from("stock_features").delete().lt("date", cutoffDate);
    if (err3) console.error("[Sync] Features table cleanup error:", err3.message);
    const { error: err4 } = await supabase.from("tdcc_shareholding").delete().lt("date", cutoffDate);
    if (err4) console.error("[Sync] TDCC table cleanup error:", err4.message);
    
    console.log("[Sync] Cleanup complete; only rows older than the retention date were pruned.");
  } else {
    console.log("[Sync] Total trading days < 512, no cleanup needed.");
  }
}

syncDailyPrices();

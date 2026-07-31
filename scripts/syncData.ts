import { createSupabaseAdminClient } from "./lib/supabaseAdmin";

const supabase = createSupabaseAdminClient();
const RETENTION_ROWS = 512;

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

async function pruneRetentionIfEnabled(): Promise<void> {
  if (process.env.SUPABASE_AUTO_PRUNE_ENABLED !== "true") {
    console.log("[Sync] Automatic Supabase pruning is disabled.");
    return;
  }

  const { data, error } = await supabase.rpc("prune_stock_price_retention", {
    retain_rows: RETENTION_ROWS,
    execute_delete: true,
  });
  if (error) throw new Error(`Retention RPC failed: ${error.message}`);

  const result = Array.isArray(data) ? data[0] : data;
  console.log(`[Sync] Retention deleted ${Number(result?.deleted_rows || 0)} rows.`);
}

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
            open, high, low, close, volume, amount, trade_count, spread
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
            open, high, low, close, volume, amount, trade_count, spread
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
  if (successCount !== records.length) {
    throw new Error(`Only ${successCount}/${records.length} rows were uploaded`);
  }
  await pruneRetentionIfEnabled();
}

syncDailyPrices().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[Sync] Failed: ${message}`);
  process.exitCode = 1;
});

import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  (process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL) as string,
  (process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY) as string
);

const delay = (ms: number) => new Promise(res => setTimeout(res, ms));

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

async function backfill() {
  console.log("🚀 Starting TWSE backfill for the remaining days...");

  const oldestDateStr = "2024-05-28";
  const daysToFetch = 15; // grab a few extra to be safe
  
  let currentDate = new Date(oldestDateStr);
  let fetchedDays = 0;

  while (fetchedDays < daysToFetch) {
    currentDate.setDate(currentDate.getDate() - 1);

    const dayOfWeek = currentDate.getDay();
    if (dayOfWeek === 0 || dayOfWeek === 6) continue;

    const cyyyy = currentDate.getFullYear();
    const cmm = String(currentDate.getMonth() + 1).padStart(2, '0');
    const cdd = String(currentDate.getDate()).padStart(2, '0');
    const twseDate = `${cyyyy}${cmm}${cdd}`;
    const isoDate = `${cyyyy}-${cmm}-${cdd}`;
    const tpexDate = `${cyyyy - 1911}/${cmm}/${cdd}`;

    console.log(`\n⏳ Checking ${isoDate}...`);
    try {
      const records: any[] = [];
      let foundTradingDay = false;

      const twseUrl = `https://www.twse.com.tw/exchangeReport/MI_INDEX?response=json&date=${twseDate}&type=ALLBUT0999`;
      const res = await fetch(twseUrl, { headers: { "User-Agent": "Mozilla/5.0" } });
      const json = await res.json() as any;

      if (json.stat === "OK" && json.tables) {
        const priceTable = json.tables.find((t: any) => t.title?.includes("行情"));
        if (priceTable?.data) {
          foundTradingDay = true;
          for (const row of priceTable.data) {
            const id = row[0];
            const volume = Math.min(parseNum(row[2]), 9999999999);
            const trade_count = parseNum(row[3]);
            const amount = Math.min(parseNum(row[4]), 9999999999);
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
        }
      }

      if (foundTradingDay) {
        try {
          const tpexRes = await fetch(`https://www.tpex.org.tw/web/stock/aftertrading/otc_quotes_no1430/stk_wn1430_result.php?l=zh-tw&d=${tpexDate}&se=EW`, { headers: { "User-Agent": "Mozilla/5.0" } });
          const tpexJson = await tpexRes.json() as any;
          if (tpexJson?.tables?.[0]?.data) {
            for (const row of tpexJson.tables[0].data) {
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
          }
        } catch (e: any) {
          console.error("  TPEX Error:", e.message);
        }

        console.log(`  👉 Found valid trading day! Upserting ${records.length} records...`);
        for (let i = 0; i < records.length; i += 500) {
          const batch = records.slice(i, i + 500);
          await supabase.from("stock_price").upsert(batch, { onConflict: "stock_id,date" });
        }
        
        fetchedDays++;
        console.log(`  ✅ Inserted. Progress: ${fetchedDays} / ${daysToFetch} days.`);
      } else {
        console.log(`  - Date ${isoDate} is not a valid trading day.`);
      }

      await delay(5000);

    } catch (err: any) {
      console.warn(`  ⚠️ Error fetching ${isoDate}: ${err.message}`);
      await delay(5000);
    }
  }

  console.log("🎉 Backfill complete!");
}

backfill();

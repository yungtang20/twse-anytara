import { createClient } from "@supabase/supabase-js";
import Database from "better-sqlite3";
import path from "path";

const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const key = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;

if (!url || !key) {
  console.log("⚠️ Missing SUPABASE_URL or SUPABASE_ANON_KEY. Skipping build-time crawler sync.");
  process.exit(0);
}

const supabase = createClient(url, key);
const dbPath = path.join(process.cwd(), "twstock", "taiwan_stock_unified.db");

console.log("📍 SQLite DB Path:", dbPath);
const db = new Database(dbPath);

const taipeiNow = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Taipei" }));
const yyyy = taipeiNow.getFullYear();
const mm = String(taipeiNow.getMonth() + 1).padStart(2, '0');
const dd = String(taipeiNow.getDate()).padStart(2, '0');

const CUTOFF_DATE = `${yyyy}-01-01`;
const TODAY_DATE = `${yyyy}-${mm}-${dd}`; // Today's market date
const TODAY_DATE_NODASH = `${yyyy}${mm}${dd}`; // For TWSE API
const TODAY_ROC_DATE = `${yyyy - 1911}/${mm}/${dd}`; // ROC calendar representation

function cleanFloat(v) {
  if (v === undefined || v === null) return null;
  const str = String(v).replace(/,/g, "").trim();
  if (str === "" || str === "--" || str === "---") return null;
  const val = parseFloat(str);
  return isNaN(val) ? null : val;
}

function cleanInt(v) {
  if (v === undefined || v === null) return null;
  const str = String(v).replace(/,/g, "").trim();
  if (str === "" || str === "--" || str === "---") return null;
  const val = parseInt(str, 10);
  return isNaN(val) ? null : val;
}

async function run() {
  console.log("⏳ Running helper sub-tasks...");

  // Task 1: Fetch and complete tdcc_shareholding
  console.log("\n🔄 Restoring tdcc_shareholding (Whale Metrics)...");
  
  let rangeStart = 0;
  const batchSize = 1000;
  let hasMore = true;
  let totalFeats = 0;
  
  const insertFeat = db.prepare(`
    INSERT INTO tdcc_shareholding (stock_id, date, total_shares, whale_ratio, retail_ratio, source)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(stock_id, date) DO UPDATE SET
      total_shares=excluded.total_shares,
      whale_ratio=excluded.whale_ratio,
      retail_ratio=excluded.retail_ratio,
      source=excluded.source
  `);

  while (hasMore) {
    const { data: feats, error: e4 } = await supabase
      .from("tdcc_shareholding")
      .select("stock_id,date,total_shares,whale_ratio,retail_ratio,source")
      .gte("date", CUTOFF_DATE)
      .range(rangeStart, rangeStart + batchSize - 1);
      
    if (e4) {
      if (e4.message && (e4.message.includes("schema cache") || e4.code === "42P01")) {
         console.log(`[Sync-Info] Supabase table tdcc_shareholding is not present in database. Preserving local TDCC data.`);
      } else {
         console.log(`[Sync-Info] Query for tdcc_shareholding was skipped: ${e4.message}`);
      }
      break;
    }
    
    if (!feats || feats.length === 0) {
      hasMore = false;
      break;
    }
    
    db.transaction(() => {
      for (const f of feats) {
        insertFeat.run(
          f.stock_id,
          f.date,
          f.total_shares || 0,
          f.whale_ratio || 0.0,
          f.retail_ratio || 0.0,
          f.source || "supabase"
        );
      }
    })();
    
    totalFeats += feats.length;
    if (feats.length < batchSize) {
      hasMore = false;
    } else {
      rangeStart += batchSize;
    }
  }
  console.log(`✅ tdcc_shareholding completely restored! Total: ${totalFeats} rows`);

  // Task 2: Crawl today's global market from official APIs
  console.log(`\n🕸️ Live-Crawling ${TODAY_DATE} stock prices and volumes...`);
  
  const todayPrices = [];
  const todayInsts = {};

  // 2.1 TWSE Quotes
  try {
    const twseUrl = `https://www.twse.com.tw/exchangeReport/MI_INDEX?response=json&date=${TODAY_DATE_NODASH}&type=ALLBUT0999`;
    const res = await fetch(twseUrl, { headers: { "User-Agent": "Mozilla/5.0" } });
    const json = await res.json();
    const priceTable = json?.tables?.find(t => t.title?.includes("行情"));
    if (json.stat === "OK" && priceTable && priceTable.data) {
      const dataRows = priceTable.data;
      console.log(`  TWSE online response is OK! Parsing ${dataRows.length} rows...`);
      for (const r of dataRows) {
        const id = String(r[0]).trim();
        const name = String(r[1]).trim();
        if (id.length !== 4 || isNaN(Number(id))) continue; // Only keep 4-digit shares
        
        const close = cleanFloat(r[8]);
        if (!close || close <= 0) continue; // Skip suspended/no trade
        
        const open = cleanFloat(r[5]) || close;
        const high = cleanFloat(r[6]) || close;
        const low = cleanFloat(r[7]) || close;
        const vol = Math.min(cleanInt(r[2]) || 0, 9999999999);
        const amount = Math.min(cleanInt(r[4]) || 0, 9999999999);
        const trades = Math.min(cleanInt(r[3]) || 0, 9999999999);
        
        // Compute spread / change values
        const polarity = String(r[9]).includes("red") ? 1 : String(r[9]).includes("green") ? -1 : 0;
        const spreadAmt = cleanFloat(r[10]) || 0;
        const spread = parseFloat((polarity * spreadAmt).toFixed(4));

        todayPrices.push({
          stock_id: id,
          date: TODAY_DATE,
          open, high, low, close,
          volume: vol,
          amount,
          trade_count: trades,
          spread,
          adj_factor: 1.0,
          adj_close: close,
          source: "TWSE_Crawler"
        });
      }
    } else {
      console.warn("  ⚠️ TWSE MI_INDEX didn't return OK / no Table 8 found");
    }
  } catch (twseErr) {
    console.error("  ❌ Error crawling TWSE today close price:", twseErr.message);
  }

  // 2.2 TPEx OTC Quotes
  try {
    const tpexUrl = `https://www.tpex.org.tw/web/stock/aftertrading/otc_quotes_no1430/stk_wn1430_result.php?l=zh-tw&d=${TODAY_ROC_DATE}&se=AL&s=0,asc,0`;
    const res = await fetch(tpexUrl, { headers: { "User-Agent": "Mozilla/5.0" } });
    const json = await res.json();
    const rows = json.aaData || (json.tables && json.tables[0] ? json.tables[0].data : null);
    if (rows) {
      console.log(`  TPEx online response is OK! Parsing ${rows.length} rows...`);
      for (const r of rows) {
        const id = String(r[0]).trim();
        const name = String(r[1]).trim();
        if (id.length !== 4 || isNaN(Number(id))) continue;
        
        const close = cleanFloat(r[2]);
        if (!close || close <= 0) continue;
        
        const open = cleanFloat(r[4]) || close;
        const high = cleanFloat(r[5]) || close;
        const low = cleanFloat(r[6]) || close;
        const vol = Math.min(cleanInt(r[7]) || 0, 9999999999);
        const amount = Math.min(cleanInt(r[8]) || 0, 9999999999);
        
        todayPrices.push({
          stock_id: id,
          date: TODAY_DATE,
          open, high, low, close,
          volume: vol,
          amount,
          trade_count: null,
          spread: cleanFloat(r[3]) || 0.0,
          adj_factor: 1.0,
          adj_close: close,
          source: "TPEx_Crawler"
        });
      }
    }
  } catch (tpexErr) {
    console.error("  ❌ Error crawling TPEx today close price:", tpexErr.message);
  }

  // 2.3 TWSE Corporate Institutional Buy/Sells
  try {
    const twseInstUrl = `https://www.twse.com.tw/rwd/zh/fund/T86?response=json&date=${TODAY_DATE_NODASH}&selectType=ALLBUT0999`;
    const res = await fetch(twseInstUrl, { headers: { "User-Agent": "Mozilla/5.0" } });
    const json = await res.json();
    if (json.stat === "OK" && json.data) {
      console.log(`  TWSE corporate net response OK! Parsing ${json.data.length} records...`);
      for (const r of json.data) {
        const id = String(r[0]).trim();
        if (id.length !== 4 || isNaN(Number(id))) continue;
        
        // Index 2 = foreign buy, Index 3 = foreign sell, Index 11 = trust buy, Index 12 = trust sell
        const fb = cleanInt(r[2]) || 0;
        const fs = cleanInt(r[3]) || 0;
        const tb = cleanInt(r[11]) || 0;
        const ts = cleanInt(r[12]) || 0;
        
        todayInsts[id] = {
          stock_id: id,
          date: TODAY_DATE,
          foreign_buy: fb,
          foreign_sell: fs,
          trust_buy: tb,
          trust_sell: ts,
          dealer_buy: 0,
          dealer_sell: 0,
          foreign_net: fb - fs,
          trust_net: tb - ts,
          dealer_net: 0,
          source: "TWSE_Institutional_Crawler"
        };
      }
    }
  } catch (twInstErr) {
    console.error("  ❌ Error crawling TWSE institutional buy/sells:", twInstErr.message);
  }

  // 2.4 TPEx Corporate Institutional Buy/Sells
  try {
    const tpexInstUrl = `https://www.tpex.org.tw/web/stock/3insti/daily_trade/3itrade_hedge_result.php?l=zh-tw&o=json&se=AL&t=D&d=${TODAY_ROC_DATE}`;
    const res = await fetch(tpexInstUrl, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!res.ok) {
      console.warn(`  ⚠️ TPEx institutional buy/sells URL returned status: ${res.status}`);
    } else {
      const text = await res.text();
      if (text.trim().startsWith("<!DOCTYPE") || text.trim().startsWith("<html")) {
        console.warn("  ⚠️ TPEx institutional buy/sells returned HTML instead of JSON (likely a non-trading day/holiday/weekend).");
      } else {
        const json = JSON.parse(text);
        const rows = json.aaData || (json.tables && json.tables[0] ? json.tables[0].data : null);
        if (rows) {
          console.log(`  TPEx corporate net response OK! Parsing ${rows.length} records...`);
          for (const r of rows) {
            const id = String(r[0]).trim();
            if (id.length !== 4 || isNaN(Number(id))) continue;
            
            // Length check and index map matching our python module (Length > 18 or > 9)
            let fb = 0, fs = 0, tb = 0, ts = 0;
            if (r.length > 18) {
              fb = cleanInt(r[2]) || 0; fs = cleanInt(r[3]) || 0;
              tb = cleanInt(r[11]) || 0; ts = cleanInt(r[12]) || 0;
            } else if (r.length > 9) {
              fb = cleanInt(r[2]) || 0; fs = cleanInt(r[3]) || 0;
              tb = cleanInt(r[5]) || 0; ts = cleanInt(r[6]) || 0;
            }
            
            todayInsts[id] = {
              stock_id: id,
              date: TODAY_DATE,
              foreign_buy: fb,
              foreign_sell: fs,
              trust_buy: tb,
              trust_sell: ts,
              dealer_buy: 0,
              dealer_sell: 0,
              foreign_net: fb - fs,
              trust_net: tb - ts,
              dealer_net: 0,
              source: "TPEx_Institutional_Crawler"
            };
          }
        }
      }
    }
  } catch (tpInstErr) {
    console.error("  ❌ Error crawling TPEx institutional buy/sells:", tpInstErr.message);
  }

  // Insert today's crawled stock_prices into Local SQLite
  if (todayPrices.length > 0) {
    console.log(`\n📥 Inserting ${todayPrices.length} live close prices for ${TODAY_DATE} into SQLite...`);
    const insertPrice = db.prepare(`
      INSERT OR REPLACE INTO stock_price (stock_id, date, open, high, low, close, volume, amount, trade_count, spread, adj_factor, adj_close, source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    db.transaction(() => {
      for (const p of todayPrices) {
        insertPrice.run(
          p.stock_id, p.date, p.open, p.high, p.low, p.close,
          p.volume, p.amount, p.trade_count, p.spread, p.adj_factor, p.adj_close, p.source
        );
      }
    })();
    console.log("✅ SQLite stock_price updated with today's prices!");
  }

  // Insert today's crawled stock_institutional into Local SQLite
  const instList = Object.values(todayInsts);
  if (instList.length > 0) {
    console.log(`📥 Inserting ${instList.length} corporate buy/sells for ${TODAY_DATE} into SQLite...`);
    const insertInst = db.prepare(`
      INSERT OR REPLACE INTO stock_institutional (stock_id, date, foreign_net, trust_net, dealer_net, foreign_buy, foreign_sell, trust_buy, trust_sell, dealer_buy, dealer_sell, institutional_net, source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    db.transaction(() => {
      for (const i of instList) {
        insertInst.run(
          i.stock_id, i.date, i.foreign_net, i.trust_net, i.dealer_net,
          i.foreign_buy, i.foreign_sell, i.trust_buy, i.trust_sell, i.dealer_buy, i.dealer_sell,
          i.foreign_net + i.trust_net + i.dealer_net, i.source
        );
      }
    })();
    console.log("✅ SQLite stock_institutional updated with today's volume!");
  }

  // Optional: Upload today's crawled prices and corp lists to Supabase as well
  if (todayPrices.length > 0) {
    console.log(`\n📤 Attempting to upsert today's crawled prices to Supabase...`);
    try {
      // Split into batches of 1000 to meet API requirements
      const bSize = 1000;
      for (let s = 0; s < todayPrices.length; s += bSize) {
        const batch = todayPrices.slice(s, s + bSize).map(p => ({
          stock_id: p.stock_id,
          date: p.date,
          open: p.open,
          high: p.high,
          low: p.low,
          close: p.close,
          volume: p.volume,
          amount: p.amount,
          trade_count: p.trade_count,
          spread: p.spread,
          adj_factor: p.adj_factor,
          source: p.source
        }));
        await supabase.from("stock_price").upsert(batch);
      }
      console.log("✅ Supabase stock_price updated with today's entries!");
    } catch (sbPriceErr) {
      console.warn("⚠️ Bypassed Supabase close prices upload:", sbPriceErr.message);
    }
  }

  if (instList.length > 0) {
    console.log(`📤 Attempting to upsert today's corporate buy/sells to Supabase...`);
    try {
      const bSize = 1000;
      for (let s = 0; s < instList.length; s += bSize) {
        const batch = instList.slice(s, s + bSize).map(i => ({
          stock_id: i.stock_id,
          date: i.date,
          foreign_net: i.foreign_net,
          trust_net: i.trust_net,
          dealer_net: i.dealer_net,
          foreign_buy: i.foreign_buy,
          foreign_sell: i.foreign_sell,
          trust_buy: i.trust_buy,
          trust_sell: i.trust_sell,
          dealer_buy: i.dealer_buy,
          dealer_sell: i.dealer_sell,
          source: i.source
        }));
        await supabase.from("stock_institutional").upsert(batch);
      }
      console.log("✅ Supabase stock_institutional updated with today's entries!");
    } catch (sbInstErr) {
      console.warn("⚠️ Bypassed Supabase institutional upload:", sbInstErr.message);
    }
  }

  // Task 3: Build stock_trading_calendar from history
  console.log("\n📅 Generating stock_trading_calendar from history...");
  const dates = db.prepare("SELECT DISTINCT date FROM stock_price ORDER BY date ASC").all();
  db.prepare("DELETE FROM stock_trading_calendar").run();
  
  if (dates.length > 0) {
    const tradingDatesSet = new Set(dates.map(d => d.date));
    const minDateStr = dates[0].date;
    const maxDateStr = dates[dates.length - 1].date;
    
    const start = new Date(minDateStr);
    const end = new Date(maxDateStr);
    
    const insertCal = db.prepare(`
      INSERT INTO stock_trading_calendar (date, is_open, source)
      VALUES (?, ?, 'supabase')
    `);
    
    db.transaction(() => {
      let current = new Date(start);
      while (current <= end) {
        const dateStr = current.toISOString().split('T')[0];
        const isOpen = tradingDatesSet.has(dateStr) ? 1 : 0;
        insertCal.run(dateStr, isOpen);
        current.setDate(current.getDate() + 1);
      }
    })();
    
    const totalCount = db.prepare("SELECT COUNT(*) as c FROM stock_trading_calendar").get().c;
    console.log(`✅ Loaded ${totalCount} calendar days into SQLite calendar, ending on ${maxDateStr}! (Trading: ${dates.length} days)`);
  } else {
    console.log("⚠️ No history dates found to build calendar.");
  }

  console.log("\n🎉 CONGRATULATIONS! ALL SUB-TASKS & TODAY'S MARKET CRAWLING COMPLETED SUCCESSFULLY!");
}

run().catch(err => {
  console.error("Critical Runtime Error:", err);
});

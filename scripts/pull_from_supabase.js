import { createClient } from "@supabase/supabase-js";
import Database from "better-sqlite3";
import path from "path";

const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const key = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;

if (!url || !key) {
  console.log("⚠️ Missing SUPABASE_URL or SUPABASE_ANON_KEY. Skipping build-time full sync.");
  process.exit(0);
}

const supabase = createClient(url, key);
const dbPath = path.join(process.cwd(), "twstock", "taiwan_stock_unified.db");

console.log("📍 SQLite DB Path:", dbPath);
const db = new Database(dbPath);

// Fast download filter: dynamically calculated to 800 calendar days ago (covers 512 trading days)
const cutoff = new Date();
cutoff.setDate(cutoff.getDate() - 800);
const CUTOFF_DATE = cutoff.toISOString().split('T')[0];

async function run() {
  console.log(`⏳ Beginning lightning-fast Supabase -> SQLite restoration (>= ${CUTOFF_DATE})...`);

  // 1. Sync stock_meta
  console.log("\n🔄 Pulling stock_meta...");
  db.prepare("DELETE FROM stock_meta").run();
  
  let rangeStart = 0;
  const batchSize = 1000;
  let hasMore = true;
  let totalMeta = 0;
  
  const insertMeta = db.prepare(`
    INSERT INTO stock_meta (stock_id, stock_name, market, industry_category, type, source, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  while (hasMore) {
    const { data: metas, error } = await supabase
      .from("stock_meta")
      .select("*")
      .range(rangeStart, rangeStart + batchSize - 1);
      
    if (error) {
      if (error.message && (error.message.includes("schema cache") || error.code === "42P01")) {
         console.log(`[Sync-Info] Supabase table stock_meta is not present in database. Skipping.`);
      } else {
         console.log(`[Sync-Info] Query for stock_meta was skipped: ${error.message}`);
      }
      break;
    }
    
    if (!metas || metas.length === 0) {
      hasMore = false;
      break;
    }
    
    db.transaction(() => {
      for (const m of metas) {
        insertMeta.run(
          m.stock_id,
          m.stock_name,
          m.market || "TSE",
          m.industry_category || null,
          m.type || null,
          m.source || null,
          m.updated_at || null
        );
      }
    })();
    
    totalMeta += metas.length;
    if (metas.length < batchSize) {
      hasMore = false;
    } else {
      rangeStart += batchSize;
    }
  }
  console.log(`✅ stock_meta restored! Total: ${totalMeta} stocks`);

  // Helper for parallel date-interval chunks fetching to bypass PostgreSQL deep paging performance issues
  async function fetchAndInsertTable(supabaseTable, sqliteTable, insertStmt, transformer, selectColumns = "*") {
    // ponytail: 智慧增量同步。先查詢本地 SQLite 的最新日期，以此為增量基準，避免每次都 DELETE 清空整張表再重抓。
    let localMaxDate = null;
    try {
      const res = db.prepare(`SELECT MAX(date) as max_date FROM ${sqliteTable}`).get();
      if (res && res.max_date) {
        localMaxDate = res.max_date;
      }
    } catch (e) {
      console.warn(`  [Info] Table ${sqliteTable} might be empty or uninitialized: ${e.message}`);
    }

    const startFromDate = localMaxDate ? localMaxDate : CUTOFF_DATE;
    console.log(`\n🔄 Syncing ${sqliteTable} from Supabase ${supabaseTable} (Incremental starting from: ${startFromDate})...`);

    // 1. Generate date intervals of 30 days from startFromDate to today
    const intervals = [];
    const start = new Date(startFromDate);
    const end = new Date();
    // Add 1 day to end to make sure we cover today completely
    end.setDate(end.getDate() + 1);

    let currentStart = new Date(start);
    while (currentStart <= end) {
      let currentEnd = new Date(currentStart);
      currentEnd.setDate(currentEnd.getDate() + 29); // 30-day chunks
      if (currentEnd > end) {
        currentEnd = new Date(end);
      }
      intervals.push({
        start: currentStart.toISOString().split('T')[0],
        end: currentEnd.toISOString().split('T')[0]
      });
      const nextStart = new Date(currentEnd);
      nextStart.setDate(nextStart.getDate() + 1);
      currentStart = nextStart;
    }

    console.log(`  Split the query into ${intervals.length} date intervals to bypass offset timeouts.`);

    let completedRows = 0;

    // 2. Fetch each date interval
    // We run 4 intervals in parallel to prevent overloading database connection pool
    const intervalConcurrency = 4;
    for (let i = 0; i < intervals.length; i += intervalConcurrency) {
      const chunk = intervals.slice(i, i + intervalConcurrency);
      
      const promises = chunk.map(async (interval) => {
        let page = 0;
        let hasMore = true;
        const intervalData = [];

        while (hasMore) {
          let success = false;
          let retries = 3;
          let data = null;

          for (let attempt = 1; attempt <= retries; attempt++) {
            try {
              const { data: res, error } = await supabase
                .from(supabaseTable)
                .select(selectColumns)
                .gte("date", interval.start)
                .lte("date", interval.end)
                .order("date", { ascending: false })
                .range(page * 1000, (page + 1) * 1000 - 1);

              if (!error) {
                data = res;
                success = true;
                break;
              }
              if (error.message && (error.message.includes("schema cache") || error.code === "42P01")) {
                 console.log(`[Sync-Info] Supabase table ${supabaseTable} is not present in database. Skipping.`);
                 success = true;
                 data = []; // act as if it is empty and don't retry
                 break;
              }
              console.warn(`[Sync-Error] ⚠️ [${interval.start} to ${interval.end}] Page ${page} attempt ${attempt} failed: ${error.message}`);
            } catch (e) {
              console.warn(`[Sync-Error] ⚠️ [${interval.start} to ${interval.end}] Page ${page} attempt ${attempt} caught: ${e.message}`);
            }
            await new Promise(r => setTimeout(r, attempt * 1000));
          }

          if (!success || !data) {
            console.error(`❌ [${interval.start} to ${interval.end}] Page ${page} failed completely. Aborting interval.`);
            break;
          }

          console.log(`    📥 [${interval.start} to ${interval.end}] Page ${page} returned ${data.length} rows`);
          intervalData.push(...data);
          if (data.length < 1000) {
            hasMore = false;
          } else {
            page++;
          }
        }
        return intervalData;
      });

      const results = await Promise.all(promises);

      let errorCount = 0;
      db.transaction(() => {
        for (const data of results) {
          for (const item of data) {
            try {
              transformer(insertStmt, item);
              completedRows++;
            } catch (err) {
              if (errorCount < 5) {
                console.error(`⚠️ Insertion error:`, err.message || err);
                errorCount++;
              }
            }
          }
        }
      })();

      console.log(`  Progress: ${completedRows} rows processed...`);
    }

    // 3. 為了本地效能與空間，我們也把大於 512 個交易日（800個日曆日）之前的超舊資料在 SQLite 中予以清除
    const pruneCount = db.prepare(`DELETE FROM ${sqliteTable} WHERE date < ?`).run(CUTOFF_DATE).changes;
    if (pruneCount > 0) {
      console.log(`  🧹 Pruned ${pruneCount} obsolete historical records older than ${CUTOFF_DATE} from ${sqliteTable}.`);
    }

    console.log(`✅ ${sqliteTable} synced successfully! Total new/updated: ${completedRows} rows`);
  }

  // 2. Sync stock_price -> stock_price
  const insertPrice = db.prepare(`
    INSERT OR REPLACE INTO stock_price (stock_id, date, open, high, low, close, volume, amount, trade_count, spread, adj_factor, adj_close, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  await fetchAndInsertTable(
    "stock_price",
    "stock_price",
    insertPrice,
    (stmt, p) => {
      stmt.run(
        p.stock_id,
        p.date,
        p.open !== undefined ? p.open : null,
        p.high !== undefined ? p.high : null,
        p.low !== undefined ? p.low : null,
        p.close !== undefined ? p.close : null,
        p.volume !== undefined ? p.volume : null,
        p.amount !== undefined ? p.amount : null,
        p.trade_count !== undefined ? p.trade_count : null,
        p.spread !== undefined ? p.spread : null,
        p.adj_factor !== undefined ? p.adj_factor : 1.0,
        p.adj_close !== undefined ? p.adj_close : p.close,
        p.source || "supabase"
      );
    },
    "stock_id,date,open,high,low,close,volume,amount,trade_count,spread,adj_factor,adj_close,source"
  );

  // 3. Sync stock_institutional -> stock_institutional
  const insertInst = db.prepare(`
    INSERT OR REPLACE INTO stock_institutional (stock_id, date, foreign_net, trust_net, dealer_net, foreign_buy, foreign_sell, trust_buy, trust_sell, dealer_buy, dealer_sell, institutional_net, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  await fetchAndInsertTable(
    "stock_institutional",
    "stock_institutional",
    insertInst,
    (stmt, i) => {
      stmt.run(
        i.stock_id,
        i.date,
        i.foreign_net || 0,
        i.trust_net || 0,
        i.dealer_net || 0,
        i.foreign_buy || 0,
        i.foreign_sell || 0,
        i.trust_buy || 0,
        i.trust_sell || 0,
        i.dealer_buy || 0,
        i.dealer_sell || 0,
        (i.foreign_net || 0) + (i.trust_net || 0) + (i.dealer_net || 0),
        i.source || "supabase"
      );
    },
    "stock_id,date,foreign_net,trust_net,dealer_net,foreign_buy,foreign_sell,trust_buy,trust_sell,dealer_buy,dealer_sell,institutional_net,source"
  );

  // 4. Sync canonical tdcc_shareholding -> SQLite
  const insertFeat = db.prepare(`
    INSERT OR REPLACE INTO tdcc_shareholding (stock_id, date, total_shares, whale_ratio, retail_ratio, source)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  await fetchAndInsertTable(
    "tdcc_shareholding",
    "tdcc_shareholding",
    insertFeat,
    (stmt, f) => {
      stmt.run(
        f.stock_id,
        f.date,
        f.total_shares || 0,
        f.whale_ratio || 0.0,
        f.retail_ratio || 0.0,
        f.source || "supabase"
      );
    },
    "stock_id,date,total_shares,whale_ratio,retail_ratio"
  );

  // 5. Build Calendar from unique trade dates and non-trade dates (all calendar days in range)
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

  console.log("\n🎉 ALL DONE! Local SQLite database fully reconstructed.");
}

run().catch((err) => {
  console.error("Critical error:", err);
});

import { createClient } from "@supabase/supabase-js";
import Database from "better-sqlite3";
import path from "path";

const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const key = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;

if (!url || !key) {
  console.log("⚠️ Missing SUPABASE_URL or SUPABASE_ANON_KEY. Skipping build-time fast sync.");
  process.exit(0);
}

const supabase = createClient(url, key);
const dbPath = path.join(process.cwd(), "twstock", "taiwan_stock_unified.db");

console.log("📍 Fast Sync DB Path:", dbPath);
const db = new Database(dbPath);

// Fast download filter: just the last 35 days
const cutoff = new Date();
cutoff.setDate(cutoff.getDate() - 35);
const CUTOFF_DATE = cutoff.toISOString().split('T')[0];

async function fetchAndInsertTable(supabaseTable, sqliteTable, insertStmt, transformer) {
  let rangeStart = 0;
  const batchSize = 1000;
  let completedRows = 0;

  const { count, error: countErr } = await supabase
    .from(supabaseTable)
    .select('*', { count: 'exact', head: true })
    .gte("date", CUTOFF_DATE);

  if (countErr) {
    if (countErr.message.includes("schema cache") || countErr.code === "42P01") {
       console.log(`[Sync-Info] Supabase table ${supabaseTable} is not present in database. Skipping fast sync.`);
    } else {
       console.log(`[Sync-Info] Query for ${supabaseTable} skipped: ${countErr.message}`);
    }
    return;
  }
  
  if (!count) {
    console.log(`⚠️ ${supabaseTable} has no records >= ${CUTOFF_DATE}.`);
    return;
  }

  const concurrentPages = 10; 
  for (let batchStart = 0; batchStart < count; batchStart += batchSize * concurrentPages) {
    const pageBatch = [];
    for (let p = 0; p < concurrentPages && (batchStart + p * batchSize) < count; p++) {
      const rStart = batchStart + p * batchSize;
      const rEnd = rStart + batchSize - 1;
      
      pageBatch.push(
        supabase
          .from(supabaseTable)
          .select("*")
          .gte("date", CUTOFF_DATE)
          .order("date", { ascending: false })
          .range(rStart, rEnd)
          .then(({ data, error }) => {
            if (error) {
              console.error(`❌ Page query failed:`, error.message);
              return null;
            }
            return data;
          })
      );
    }
    
    const results = await Promise.all(pageBatch);
    
    db.transaction(() => {
      for (const data of results) {
        if (!data) continue;
        for (const item of data) {
          try {
            transformer(insertStmt, item);
            completedRows++;
          } catch (err) {
            // Ignore constraints
          }
        }
      }
    })();
  }
  console.log(`✅ ${sqliteTable} fast restored! Total: ${completedRows} rows`);
}

async function run() {
  console.log(`⏳ Beginning fast Supabase -> SQLite restoration (>= ${CUTOFF_DATE})...`);

  // 1. Sync stock_meta
  db.prepare("DELETE FROM stock_meta").run();
  
  let rangeStart = 0;
  let hasMore = true;
  let totalMeta = 0;
  const insertMeta = db.prepare(`
    INSERT INTO stock_meta (stock_id, stock_name, market, industry_category, type, source, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  while (hasMore) {
    const { data: metas } = await supabase.from("stock_meta").select("*").range(rangeStart, rangeStart + 999);
    if (!metas || metas.length === 0) break;
    db.transaction(() => {
      for (const m of metas) {
        try {
          insertMeta.run(m.stock_id, m.stock_name, m.market, m.industry_category, m.type, m.source || "supabase", m.updated_at);
          totalMeta++;
        } catch {}
      }
    })();
    rangeStart += 1000;
  }
  console.log(`✅ stock_meta restored: ${totalMeta}`);

  // 2. Sync stock_price -> stock_price
  db.prepare("DELETE FROM stock_price").run();
  const insertPrice = db.prepare(`
    INSERT INTO stock_price (stock_id, date, open, high, low, close, volume, amount, trade_count, spread, adj_factor, adj_close, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  await fetchAndInsertTable("stock_price", "stock_price", insertPrice, (stmt, p) => {
    stmt.run(p.stock_id, p.date, p.open ?? null, p.high ?? null, p.low ?? null, p.close ?? null, p.volume ?? null, p.amount ?? null, p.trade_count ?? null, p.spread ?? null, p.adj_factor ?? 1.0, p.adj_close ?? p.close, p.source || "supabase");
  });

  // 3. Sync stock_institutional -> stock_institutional
  db.prepare("DELETE FROM stock_institutional").run();
  const insertInst = db.prepare(`
    INSERT INTO stock_institutional (stock_id, date, foreign_net, trust_net, dealer_net, foreign_buy, foreign_sell, trust_buy, trust_sell, dealer_buy, dealer_sell, institutional_net, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  await fetchAndInsertTable("stock_institutional", "stock_institutional", insertInst, (stmt, i) => {
    stmt.run(i.stock_id, i.date, i.foreign_net || 0, i.trust_net || 0, i.dealer_net || 0, i.foreign_buy || 0, i.foreign_sell || 0, i.trust_buy || 0, i.trust_sell || 0, i.dealer_buy || 0, i.dealer_sell || 0, i.institutional_net || 0, i.source || "supabase");
  });

  console.log("🎉 Fast sync completed!");
}

run().catch(console.error);

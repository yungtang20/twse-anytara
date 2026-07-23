import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import { runMigrations } from "./lib/migrations";

let db: any = null;

export function initDb() {
  try {
    const dbPath = path.join(process.cwd(), "twstock", "taiwan_stock_unified.db");
    
    // Ensure the folder exists
    const dbDir = path.dirname(dbPath);
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }

    // Initialize/Create Database if it doesn't exist
    const tempDb = new Database(dbPath); // open in read-write mode to initialize schema
    const tableCheck = tempDb.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'stock_price'").get();
    const needsInit = !tableCheck;
    
    if (needsInit) {
      console.log(`[DB] Creating new SQLite database/tables at ${dbPath}`);
      const schemas = [
        `CREATE TABLE IF NOT EXISTS stock_meta (
            stock_id TEXT PRIMARY KEY,
            stock_name TEXT NOT NULL,
            industry_category TEXT,
            market TEXT,
            type TEXT,
            source TEXT,
            updated_at TEXT DEFAULT (datetime('now', 'localtime'))
        )`,
        `CREATE TABLE IF NOT EXISTS stock_trading_calendar (
            date TEXT PRIMARY KEY,
            is_open INTEGER NOT NULL,
            source TEXT,
            updated_at TEXT DEFAULT (datetime('now', 'localtime'))
        )`,
        `CREATE TABLE IF NOT EXISTS stock_price (
            stock_id TEXT,
            date TEXT,
            open REAL,
            high REAL,
            low REAL,
            close REAL,
            volume INTEGER,
            amount INTEGER,
            trade_count INTEGER,
            spread REAL,
            adj_factor REAL DEFAULT 1.0,
            adj_close REAL,
            source TEXT,
            updated_at TEXT DEFAULT (datetime('now', 'localtime')),
            PRIMARY KEY (stock_id, date)
        )`,
        `CREATE TABLE IF NOT EXISTS dividend_events (
            stock_id TEXT,
            date TEXT,
            before_price REAL,
            after_price REAL,
            reference_price REAL,
            cash_dividend REAL,
            stock_dividend REAL,
            source TEXT,
            updated_at TEXT DEFAULT (datetime('now', 'localtime')),
            PRIMARY KEY (stock_id, date)
        )`,
        `CREATE TABLE IF NOT EXISTS stock_institutional (
            stock_id TEXT,
            date TEXT,
            foreign_net INTEGER DEFAULT 0,
            trust_net INTEGER DEFAULT 0,
            dealer_net INTEGER DEFAULT 0,
            foreign_buy INTEGER DEFAULT 0,
            foreign_sell INTEGER DEFAULT 0,
            trust_buy INTEGER DEFAULT 0,
            trust_sell INTEGER DEFAULT 0,
            dealer_buy INTEGER DEFAULT 0,
            dealer_sell INTEGER DEFAULT 0,
            institutional_net INTEGER DEFAULT 0,
            source TEXT,
            updated_at TEXT DEFAULT (datetime('now', 'localtime')),
            PRIMARY KEY (stock_id, date)
        )`,
        `CREATE TABLE IF NOT EXISTS shareholding_data (
            stock_id TEXT,
            date TEXT,
            foreign_shares REAL,
            foreign_ratio REAL,
            source TEXT,
            updated_at TEXT DEFAULT (datetime('now', 'localtime')),
            PRIMARY KEY (stock_id, date)
        )`,
        `CREATE TABLE IF NOT EXISTS tdcc_shareholding (
            stock_id TEXT,
            date TEXT,
            total_shares INTEGER,
            whale_ratio REAL,
            retail_ratio REAL,
            source TEXT,
            updated_at TEXT DEFAULT (datetime('now', 'localtime')),
            PRIMARY KEY (stock_id, date)
        )`,
        `CREATE TABLE IF NOT EXISTS audit_log (
            log_id INTEGER PRIMARY KEY AUTOINCREMENT,
            stock_id TEXT,
            action TEXT,
            status TEXT,
            detail TEXT,
            timestamp TEXT DEFAULT (datetime('now', 'localtime'))
        )`,
        `CREATE INDEX IF NOT EXISTS idx_stock_history_stock_date ON stock_price(stock_id, date)`,
        `CREATE INDEX IF NOT EXISTS idx_dividend_events_stock_date ON dividend_events(stock_id, date)`,
        `CREATE INDEX IF NOT EXISTS idx_institutional_stock_date ON stock_institutional(stock_id, date)`,
        `CREATE INDEX IF NOT EXISTS idx_shareholding_stock_date ON shareholding_data(stock_id, date)`,
        `CREATE INDEX IF NOT EXISTS idx_tdcc_stock_date ON tdcc_shareholding(stock_id, date)`
      ];

      for (const sql of schemas) {
        tempDb.prepare(sql).run();
      }

      // Add a few baseline stocks metadata
      const ENABLE_SEED_DATA = process.env.ENABLE_SEED_DATA === 'true';
      if (ENABLE_SEED_DATA) {
        const insertMeta = tempDb.prepare(
          `INSERT OR REPLACE INTO stock_meta (stock_id, stock_name, industry_category, market, type, source) VALUES (?, ?, ?, ?, ?, ?)`
        );
        insertMeta.run('2330', '台積電', '半導體業', 'TSE', 'TSE', 'initial');
        insertMeta.run('2317', '鴻海', '其他電子業', 'TSE', 'TSE', 'initial');
        insertMeta.run('2454', '聯發科', '半導體業', 'TSE', 'TSE', 'initial');
        insertMeta.run('0050', '元大台灣50', 'ETF', 'TSE', 'TSE', 'initial');

        // Add 2330 historical price data
        const insertHistory = tempDb.prepare(
          `INSERT OR REPLACE INTO stock_price (stock_id, date, open, high, low, close, volume, amount, trade_count, spread, adj_factor, adj_close, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        );

        // Add historical data for the last few days dynamically
        const taipeiNow = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Taipei" }));
        const t = taipeiNow.getTime();
        const d0 = new Date(t).toISOString().split('T')[0];
        const d1 = new Date(t - 86400000).toISOString().split('T')[0];
        const d2 = new Date(t - 86400000 * 2).toISOString().split('T')[0];
        const d3 = new Date(t - 86400000 * 3).toISOString().split('T')[0];

        const days = [
          { date: d3, open: 910.0, high: 915.0, low: 905.0, close: 912.0, volume: 14500000, amount: 13200000000, trade_count: 22000, spread: 7.0 },
          { date: d2, open: 915.0, high: 928.0, low: 914.0, close: 925.0, volume: 18200000, amount: 16800000000, trade_count: 27500, spread: 13.0 },
          { date: d1, open: 928.0, high: 935.0, low: 925.0, close: 930.0, volume: 22000000, amount: 20400000000, trade_count: 31000, spread: 10.0 },
          { date: d0, open: 935.0, high: 945.0, low: 930.0, close: 940.0, volume: 21500000, amount: 19800000000, trade_count: 29500, spread: 10.0 }
        ];

        for (const d of days) {
          insertHistory.run('2330', d.date, d.open, d.high, d.low, d.close, d.volume, d.amount, d.trade_count, d.spread, 1.0, d.close, 'initial');
        }

        // Add institutional flows
        const insertInst = tempDb.prepare(
          `INSERT OR REPLACE INTO stock_institutional (stock_id, date, foreign_net, trust_net, dealer_net, institutional_net, source) VALUES (?, ?, ?, ?, ?, ?, ?)`
        );
        insertInst.run('2330', d0, 18500, 3200, 1100, 22800, 'initial');
        insertInst.run('2330', d1, 15200, 3100, -820, 17480, 'initial');
        insertInst.run('2330', d2, -1200, 850, -420, -770, 'initial');
      }

      console.log('[DB] New database initialized with base records.');
    }
    
    runMigrations(tempDb);
    tempDb.close();

    // Now open database connection for application usage
    db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    console.log(`[DB] Connected to SQLite: ${dbPath}`);
    return db;
  } catch (err: any) {
    console.warn(`[DB] SQLite connection failed: ${err.message}. Stock APIs disabled.`);
    db = null;
    return null;
  }
}

export function getDb() {
  if (!db) {
    return initDb();
  }
  return db;
}

export function closeDb(): void {
  if (!db) return;
  db.close();
  db = null;
}

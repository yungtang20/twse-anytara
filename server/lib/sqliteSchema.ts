interface SqliteSchemaDb {
  exec(sql: string): unknown;
  prepare(sql: string): {
    get(...args: unknown[]): unknown;
    all(...args: unknown[]): unknown[];
  };
}

type SchemaObject = { type: "table" | "view" } | undefined;

function schemaObject(db: SqliteSchemaDb, name: string): SchemaObject {
  return db.prepare(
    "SELECT type FROM sqlite_master WHERE name = ? AND type IN ('table', 'view')",
  ).get(name) as SchemaObject;
}

function ensurePriceStorage(db: SqliteSchemaDb): void {
  const history = schemaObject(db, "stock_history");
  const price = schemaObject(db, "stock_price");
  if (!history && price?.type === "table") {
    createHistoryCompatibilityView(db);
    return;
  }
  if (!history) {
    db.exec(`
      CREATE TABLE stock_history (
        stock_id TEXT NOT NULL,
        date TEXT NOT NULL,
        open REAL,
        high REAL,
        low REAL,
        close REAL,
        volume INTEGER,
        amount INTEGER,
        trade_count INTEGER,
        spread REAL,
        source TEXT,
        updated_at TEXT DEFAULT (datetime('now', 'localtime')),
        PRIMARY KEY (stock_id, date)
      );
    `);
  }
  if (!price) createPriceCompatibilityView(db);
}

function createPriceCompatibilityView(db: SqliteSchemaDb): void {
  db.exec(`
    CREATE VIEW stock_price AS
      SELECT stock_id, date, open, high, low, close, volume, amount, trade_count,
             spread, 1.0 AS adj_factor, close AS adj_close, source, updated_at
      FROM stock_history;
    CREATE TRIGGER stock_price_insert
      INSTEAD OF INSERT ON stock_price
      BEGIN
        INSERT OR REPLACE INTO stock_history
          (stock_id, date, open, high, low, close, volume, amount, trade_count, spread, source, updated_at)
        VALUES
          (NEW.stock_id, NEW.date, NEW.open, NEW.high, NEW.low, NEW.close, NEW.volume,
           NEW.amount, NEW.trade_count, NEW.spread, NEW.source,
           COALESCE(NEW.updated_at, datetime('now', 'localtime')));
      END;
    CREATE TRIGGER stock_price_update
      INSTEAD OF UPDATE ON stock_price
      BEGIN
        UPDATE stock_history SET
          open = NEW.open, high = NEW.high, low = NEW.low, close = NEW.close,
          volume = NEW.volume, amount = NEW.amount, trade_count = NEW.trade_count,
          spread = NEW.spread, source = NEW.source,
          updated_at = COALESCE(NEW.updated_at, datetime('now', 'localtime'))
        WHERE stock_id = OLD.stock_id AND date = OLD.date;
      END;
    CREATE TRIGGER stock_price_delete
      INSTEAD OF DELETE ON stock_price
      BEGIN
        DELETE FROM stock_history WHERE stock_id = OLD.stock_id AND date = OLD.date;
      END;
  `);
}

function createHistoryCompatibilityView(db: SqliteSchemaDb): void {
  db.exec(`
    CREATE VIEW stock_history AS
      SELECT stock_id, date, open, high, low, close, volume, amount, trade_count,
             spread, source, updated_at
      FROM stock_price;
  `);
}

function ensureInstitutionalStorage(db: SqliteSchemaDb): void {
  const legacy = schemaObject(db, "institutional_data");
  const current = schemaObject(db, "stock_institutional");
  if (!legacy && current?.type === "table") {
    db.exec(`CREATE VIEW institutional_data AS SELECT * FROM stock_institutional;`);
    return;
  }
  if (!legacy) {
    db.exec(`
      CREATE TABLE institutional_data (
        stock_id TEXT NOT NULL,
        date TEXT NOT NULL,
        foreign_net INTEGER DEFAULT 0,
        trust_net INTEGER DEFAULT 0,
        dealer_net INTEGER DEFAULT 0,
        institutional_net INTEGER DEFAULT 0,
        source TEXT,
        updated_at TEXT DEFAULT (datetime('now', 'localtime')),
        foreign_buy INTEGER DEFAULT 0,
        foreign_sell INTEGER DEFAULT 0,
        trust_buy INTEGER DEFAULT 0,
        trust_sell INTEGER DEFAULT 0,
        dealer_buy INTEGER DEFAULT 0,
        dealer_sell INTEGER DEFAULT 0,
        PRIMARY KEY (stock_id, date)
      );
    `);
  }
  if (!current) createInstitutionalCompatibilityView(db);
}

function createInstitutionalCompatibilityView(db: SqliteSchemaDb): void {
  db.exec(`
    CREATE VIEW stock_institutional AS SELECT * FROM institutional_data;
    CREATE TRIGGER stock_institutional_insert
      INSTEAD OF INSERT ON stock_institutional
      BEGIN
        INSERT OR REPLACE INTO institutional_data
          (stock_id, date, foreign_net, trust_net, dealer_net, institutional_net, source,
           updated_at, foreign_buy, foreign_sell, trust_buy, trust_sell, dealer_buy, dealer_sell)
        VALUES
          (NEW.stock_id, NEW.date, NEW.foreign_net, NEW.trust_net, NEW.dealer_net,
           NEW.institutional_net, NEW.source, COALESCE(NEW.updated_at, datetime('now', 'localtime')),
           NEW.foreign_buy, NEW.foreign_sell, NEW.trust_buy, NEW.trust_sell,
           NEW.dealer_buy, NEW.dealer_sell);
      END;
    CREATE TRIGGER stock_institutional_update
      INSTEAD OF UPDATE ON stock_institutional
      BEGIN
        UPDATE institutional_data SET
          foreign_net = NEW.foreign_net, trust_net = NEW.trust_net, dealer_net = NEW.dealer_net,
          institutional_net = NEW.institutional_net, source = NEW.source,
          updated_at = COALESCE(NEW.updated_at, datetime('now', 'localtime')),
          foreign_buy = NEW.foreign_buy, foreign_sell = NEW.foreign_sell,
          trust_buy = NEW.trust_buy, trust_sell = NEW.trust_sell,
          dealer_buy = NEW.dealer_buy, dealer_sell = NEW.dealer_sell
        WHERE stock_id = OLD.stock_id AND date = OLD.date;
      END;
    CREATE TRIGGER stock_institutional_delete
      INSTEAD OF DELETE ON stock_institutional
      BEGIN
        DELETE FROM institutional_data WHERE stock_id = OLD.stock_id AND date = OLD.date;
      END;
  `);
}

function ensureSupportingTables(db: SqliteSchemaDb): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS stock_meta (
      stock_id TEXT PRIMARY KEY,
      stock_name TEXT NOT NULL,
      industry_category TEXT,
      market TEXT,
      type TEXT,
      source TEXT,
      updated_at TEXT DEFAULT (datetime('now', 'localtime'))
    );
    CREATE TABLE IF NOT EXISTS stock_trading_calendar (
      date TEXT PRIMARY KEY,
      is_open INTEGER NOT NULL,
      source TEXT,
      updated_at TEXT DEFAULT (datetime('now', 'localtime'))
    );
    CREATE TABLE IF NOT EXISTS dividend_events (
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
    );
    CREATE TABLE IF NOT EXISTS shareholding_unified (
      stock_id TEXT,
      date TEXT,
      source TEXT,
      total_shares INTEGER,
      whale_ratio REAL,
      retail_ratio REAL,
      foreign_shares INTEGER,
      foreign_ratio REAL,
      total_people INTEGER,
      whale_shares INTEGER,
      whale_people INTEGER,
      updated_at TEXT,
      PRIMARY KEY (stock_id, date)
    );
    CREATE TABLE IF NOT EXISTS audit_log (
      log_id INTEGER PRIMARY KEY AUTOINCREMENT,
      stock_id TEXT,
      action TEXT,
      status TEXT,
      detail TEXT,
      timestamp TEXT DEFAULT (datetime('now', 'localtime'))
    );
    CREATE TABLE IF NOT EXISTS stock_trade_risk (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      stock_id TEXT NOT NULL,
      market TEXT NOT NULL,
      risk_type TEXT NOT NULL,
      risk_level TEXT NOT NULL,
      reason TEXT NOT NULL DEFAULT '',
      restrictions TEXT NOT NULL DEFAULT '',
      announced_date TEXT,
      start_date TEXT NOT NULL,
      end_date TEXT,
      source TEXT NOT NULL,
      source_url TEXT NOT NULL,
      source_updated_at TEXT,
      fetched_at TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      raw_data TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS uq_trade_risk_identity
      ON stock_trade_risk(stock_id, market, risk_type, source, start_date, COALESCE(end_date, ''));
    CREATE INDEX IF NOT EXISTS idx_trade_risk_stock ON stock_trade_risk(stock_id);
    CREATE INDEX IF NOT EXISTS idx_trade_risk_active ON stock_trade_risk(is_active);
    CREATE INDEX IF NOT EXISTS idx_trade_risk_type ON stock_trade_risk(risk_type);
    CREATE INDEX IF NOT EXISTS idx_trade_risk_start ON stock_trade_risk(start_date);
    CREATE INDEX IF NOT EXISTS idx_trade_risk_end ON stock_trade_risk(end_date);
  `);
  ensureTdccStorage(db);
}

function ensureTdccStorage(db: SqliteSchemaDb): void {
  const columns = new Set(
    (db.prepare("PRAGMA table_info(shareholding_unified)").all() as Array<{ name: string }>)
      .map((column) => column.name),
  );
  for (const [name, type] of [
    ["total_people", "INTEGER"],
    ["whale_shares", "INTEGER"],
    ["whale_people", "INTEGER"],
  ] as const) {
    if (!columns.has(name)) db.exec(`ALTER TABLE shareholding_unified ADD COLUMN ${name} ${type}`);
  }
  const tdcc = schemaObject(db, "tdcc_shareholding");
  if (tdcc?.type === "table") {
    const legacyColumns = new Set(
      (db.prepare("PRAGMA table_info(tdcc_shareholding)").all() as Array<{ name: string }>)
        .map((column) => column.name),
    );
    const legacyValue = (column: string, fallback: string) => legacyColumns.has(column) ? column : fallback;
    try {
      db.exec(`
        BEGIN IMMEDIATE;
        INSERT INTO shareholding_unified
          (stock_id, date, total_shares, whale_ratio, retail_ratio,
           total_people, whale_shares, whale_people, source, updated_at)
        SELECT stock_id, date,
          ${legacyValue("total_shares", "NULL")},
          ${legacyValue("whale_ratio", "NULL")},
          ${legacyValue("retail_ratio", "NULL")},
          ${legacyValue("total_people", "NULL")},
          ${legacyValue("whale_shares", "NULL")},
          ${legacyValue("whale_people", "NULL")},
          'tdcc', ${legacyValue("updated_at", "datetime('now', 'localtime')")}
        FROM tdcc_shareholding
        WHERE 1
        ON CONFLICT(stock_id, date) DO UPDATE SET
          total_shares = COALESCE(excluded.total_shares, shareholding_unified.total_shares),
          whale_ratio = COALESCE(excluded.whale_ratio, shareholding_unified.whale_ratio),
          retail_ratio = COALESCE(excluded.retail_ratio, shareholding_unified.retail_ratio),
          total_people = COALESCE(excluded.total_people, shareholding_unified.total_people),
          whale_shares = COALESCE(excluded.whale_shares, shareholding_unified.whale_shares),
          whale_people = COALESCE(excluded.whale_people, shareholding_unified.whale_people),
          source = 'tdcc',
          updated_at = COALESCE(excluded.updated_at, shareholding_unified.updated_at,
            datetime('now', 'localtime'));
        DROP TABLE tdcc_shareholding;
        COMMIT;
      `);
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch { /* transaction already closed */ }
      throw error;
    }
  }
  db.exec(`
    DROP TRIGGER IF EXISTS tdcc_shareholding_insert;
    DROP TRIGGER IF EXISTS tdcc_shareholding_update;
    DROP TRIGGER IF EXISTS tdcc_shareholding_delete;
    DROP VIEW IF EXISTS tdcc_shareholding;
    CREATE VIEW tdcc_shareholding AS
      SELECT stock_id, date, total_shares, whale_ratio, retail_ratio,
             total_people, whale_shares, whale_people, source, updated_at
      FROM shareholding_unified
      WHERE source = 'tdcc';
    CREATE TRIGGER tdcc_shareholding_insert
      INSTEAD OF INSERT ON tdcc_shareholding
      BEGIN
        INSERT INTO shareholding_unified
          (stock_id, date, total_shares, whale_ratio, retail_ratio,
           total_people, whale_shares, whale_people, source, updated_at)
        VALUES
          (NEW.stock_id, NEW.date, NEW.total_shares, NEW.whale_ratio, NEW.retail_ratio,
           NEW.total_people, NEW.whale_shares, NEW.whale_people,
           'tdcc', COALESCE(NEW.updated_at, datetime('now', 'localtime')))
        ON CONFLICT(stock_id, date) DO UPDATE SET
          total_shares = COALESCE(excluded.total_shares, shareholding_unified.total_shares),
          whale_ratio = COALESCE(excluded.whale_ratio, shareholding_unified.whale_ratio),
          retail_ratio = COALESCE(excluded.retail_ratio, shareholding_unified.retail_ratio),
          total_people = COALESCE(excluded.total_people, shareholding_unified.total_people),
          whale_shares = COALESCE(excluded.whale_shares, shareholding_unified.whale_shares),
          whale_people = COALESCE(excluded.whale_people, shareholding_unified.whale_people),
          source = 'tdcc',
          updated_at = COALESCE(excluded.updated_at, shareholding_unified.updated_at,
            datetime('now', 'localtime'));
      END;
    CREATE TRIGGER tdcc_shareholding_update
      INSTEAD OF UPDATE ON tdcc_shareholding
      BEGIN
        UPDATE shareholding_unified SET
          total_shares = NEW.total_shares, whale_ratio = NEW.whale_ratio,
          retail_ratio = NEW.retail_ratio, total_people = NEW.total_people,
          whale_shares = NEW.whale_shares, whale_people = NEW.whale_people,
          source = 'tdcc',
          updated_at = COALESCE(NEW.updated_at, datetime('now', 'localtime'))
        WHERE stock_id = OLD.stock_id AND date = OLD.date;
      END;
    CREATE TRIGGER tdcc_shareholding_delete
      INSTEAD OF DELETE ON tdcc_shareholding
      BEGIN
        DELETE FROM shareholding_unified
        WHERE stock_id = OLD.stock_id AND date = OLD.date AND source = 'tdcc';
      END;
  `);
}

export function ensureCanonicalSchema(db: SqliteSchemaDb): void {
  ensurePriceStorage(db);
  ensureInstitutionalStorage(db);
  ensureSupportingTables(db);
}

export function ensureCanonicalIndexes(db: SqliteSchemaDb): void {
  const priceTable = schemaObject(db, "stock_history")?.type === "table" ? "stock_history" : "stock_price";
  const institutionalTable = schemaObject(db, "institutional_data")?.type === "table"
    ? "institutional_data"
    : "stock_institutional";
  const priceDateIndex = priceTable === "stock_history"
    ? "idx_stock_history_date"
    : "idx_stock_price_date";
  const priceStockDateIndex = priceTable === "stock_history"
    ? "idx_stock_history_stock_date"
    : "idx_stock_price_stock_date";
  const institutionalIndex = institutionalTable === "institutional_data"
    ? "idx_institutional_stock_date"
    : "idx_stock_institutional_stock_date";
  db.exec(`
    CREATE INDEX IF NOT EXISTS ${priceDateIndex} ON ${priceTable}(date);
    CREATE INDEX IF NOT EXISTS ${priceStockDateIndex} ON ${priceTable}(stock_id, date DESC);
    CREATE INDEX IF NOT EXISTS idx_meta_market ON stock_meta(market);
    CREATE INDEX IF NOT EXISTS ${institutionalIndex}
      ON ${institutionalTable}(stock_id, date DESC);
    CREATE INDEX IF NOT EXISTS idx_shareholding_unified_stock_date
      ON shareholding_unified(stock_id, date DESC);
  `);
}

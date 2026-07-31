import { ensureCanonicalIndexes, ensureCanonicalSchema } from "./sqliteSchema";

interface MigrationDb {
  exec(sql: string): unknown;
  prepare(sql: string): {
    get(...args: unknown[]): unknown;
    all(...args: unknown[]): unknown[];
    run(...args: unknown[]): unknown;
  };
  transaction(fn: () => void): () => void;
}

const MIGRATIONS = [
  {
    version: 1,
    name: "analysis_evidence_tables",
    sql: `
      CREATE TABLE IF NOT EXISTS analysis_snapshots (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL UNIQUE,
        stock_id TEXT NOT NULL,
        as_of TEXT,
        retrieved_at TEXT NOT NULL,
        snapshot_json TEXT NOT NULL,
        quality_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_analysis_snapshots_stock_asof
        ON analysis_snapshots(stock_id, as_of DESC);

      CREATE TABLE IF NOT EXISTS analysis_job_reports (
        job_id TEXT NOT NULL,
        framework_id TEXT NOT NULL,
        status TEXT NOT NULL,
        report_markdown TEXT,
        claims_json TEXT NOT NULL DEFAULT '[]',
        evidence_json TEXT NOT NULL DEFAULT '{}',
        error TEXT,
        started_at INTEGER,
        ended_at INTEGER,
        PRIMARY KEY (job_id, framework_id)
      );
      CREATE INDEX IF NOT EXISTS idx_analysis_job_reports_job
        ON analysis_job_reports(job_id);
    `,
  },
  {
    version: 2,
    name: "analysis_jobs_table",
    sql: `
      CREATE TABLE IF NOT EXISTS analysis_jobs (
        id TEXT PRIMARY KEY,
        stock_id TEXT NOT NULL,
        stock_name TEXT,
        framework_ids TEXT NOT NULL,
        framework_count INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        per_framework TEXT NOT NULL DEFAULT '{}',
        error TEXT,
        started_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_analysis_jobs_status
        ON analysis_jobs(status);
      CREATE INDEX IF NOT EXISTS idx_analysis_jobs_updated
        ON analysis_jobs(updated_at DESC);
    `,
  },
  {
    version: 3,
    name: "analysis_job_leases",
    apply(db: MigrationDb) {
      const columns = new Set((db.prepare("PRAGMA table_info(analysis_jobs)").all() as Array<{ name: string }>).map((column) => column.name));
      if (!columns.has("worker_id")) db.exec("ALTER TABLE analysis_jobs ADD COLUMN worker_id TEXT");
      if (!columns.has("lease_until")) db.exec("ALTER TABLE analysis_jobs ADD COLUMN lease_until INTEGER");
      if (!columns.has("attempt_count")) db.exec("ALTER TABLE analysis_jobs ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0");
      if (!columns.has("dedupe_key")) db.exec("ALTER TABLE analysis_jobs ADD COLUMN dedupe_key TEXT");
      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_analysis_jobs_active_dedupe
          ON analysis_jobs(dedupe_key)
          WHERE dedupe_key IS NOT NULL AND status IN ('pending', 'running');
        CREATE INDEX IF NOT EXISTS idx_analysis_jobs_lease
          ON analysis_jobs(status, lease_until);
      `);
    },
  },
  {
    version: 4,
    name: "core_tables_indexes",
    apply(db: MigrationDb) {
      ensureCanonicalIndexes(db);
    },
  },
  {
    version: 5,
    name: "ordinary_stocks_only",
    apply(db: MigrationDb) {
      const ordinary = "(stock_id GLOB '[1-8][0-9][0-9][0-9]' OR stock_id GLOB '9[02-9][0-9][0-9]')";
      const objectType = (name: string) => (
        db.prepare("SELECT type FROM sqlite_master WHERE name = ?").get(name) as { type?: string } | undefined
      )?.type;
      const priceTable = objectType("stock_history") === "table" ? "stock_history" : "stock_price";
      const institutionalTable = objectType("institutional_data") === "table"
        ? "institutional_data"
        : "stock_institutional";
      const tdccTable = objectType("shareholding_unified") === "table"
        ? "shareholding_unified"
        : "tdcc_shareholding";
      for (const table of [priceTable, institutionalTable, tdccTable, "stock_meta", "dividend_events"]) {
        db.exec(`DELETE FROM ${table} WHERE NOT ${ordinary};`);
      }
      for (const [trigger, table] of [
        ["stock_history_ordinary_only", priceTable],
        ["institutional_ordinary_only", institutionalTable],
        ["shareholding_ordinary_only", tdccTable],
        ["stock_meta_ordinary_only", "stock_meta"],
        ["dividend_events_ordinary_only", "dividend_events"],
      ]) {
        db.exec(`
          CREATE TRIGGER IF NOT EXISTS ${trigger}
          BEFORE INSERT ON ${table}
          WHEN NOT (NEW.stock_id GLOB '[1-8][0-9][0-9][0-9]'
                    OR NEW.stock_id GLOB '9[02-9][0-9][0-9]')
          BEGIN
            SELECT RAISE(ABORT, 'only ordinary stock IDs are allowed');
          END;
        `);
      }
    },
  },
] as const;

export function runMigrations(db: MigrationDb): void {
  ensureCanonicalSchema(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  const applied = db.prepare("SELECT 1 FROM schema_migrations WHERE version = ?");
  const record = db.prepare("INSERT INTO schema_migrations (version, name) VALUES (?, ?)");
  for (const migration of MIGRATIONS) {
    if (applied.get(migration.version)) continue;
    db.transaction(() => {
      if ("sql" in migration) db.exec(migration.sql);
      if ("apply" in migration) migration.apply(db);
      record.run(migration.version, migration.name);
    })();
  }
}

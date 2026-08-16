import path from "path";
import fs from "fs";
import os from "os";
import { runMigrations } from "./lib/migrations";
import { ensureCanonicalSchema } from "./lib/sqliteSchema";
import { resolveRuntimeMode } from "./lib/runtimeMode";
import { loadSqliteDriver } from "./lib/sqliteDriver";

let db: any = null;

export function resolveDatabasePath(
  cwd = process.cwd(),
  configuredPath = process.env.SQLITE_DB_PATH,
): string {
  if (!configuredPath?.trim()) {
    throw new Error("SQLITE_DB_PATH is required in test mode");
  }
  return path.resolve(cwd, configuredPath);
}

export function resolveTestDatabasePath(
  cwd = process.cwd(),
  configuredPath = process.env.SQLITE_DB_PATH,
  tempDirectory = os.tmpdir(),
): string {
  const dbPath = resolveDatabasePath(cwd, configuredPath);
  const relative = path.relative(path.resolve(tempDirectory), dbPath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("SQLITE_DB_PATH must point to a file inside the OS temporary directory in test mode");
  }
  return dbPath;
}

export function initDb() {
  if (resolveRuntimeMode() !== "test") {
    throw new Error("SQLite is disabled in cloud mode");
  }
  const dbPath = resolveTestDatabasePath();
  try {
    const Database = loadSqliteDriver();
    // Ensure the folder exists
    const dbDir = path.dirname(dbPath);
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }

    // Initialize/Create Database if it doesn't exist
    const tempDb = new Database(dbPath); // open in read-write mode to initialize schema
    const tableCheck = tempDb.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('stock_history', 'stock_price') LIMIT 1",
    ).get();
    const needsInit = !tableCheck;
    ensureCanonicalSchema(tempDb);
    
    if (needsInit) console.log(`[DB] Creating test SQLite database/tables at ${dbPath}`);
    
    runMigrations(tempDb);
    tempDb.close();

    // Now open database connection for application usage
    db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
    db.pragma('synchronous = NORMAL');
    console.log(`[DB] Connected to SQLite: ${dbPath}`);
    return db;
  } catch (err: any) {
    console.warn(`[DB] SQLite connection failed: ${err.message}. Stock APIs disabled.`);
    db = null;
    return null;
  }
}

export function getDb() {
  if (resolveRuntimeMode() !== "test") {
    throw new Error("SQLite is disabled in cloud mode");
  }
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

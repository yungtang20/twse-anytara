import { createRequire } from "node:module";
import path from "node:path";
import type BetterSqlite3 from "better-sqlite3";

type SqliteDriver = typeof BetterSqlite3;

let cachedDriver: SqliteDriver | null = null;

/**
 * Load the native SQLite adapter only when test or maintenance code explicitly
 * asks for it. Cloud production can import SQLite-aware modules without loading
 * better-sqlite3 or requiring its native binary to be installed.
 */
export function loadSqliteDriver(): SqliteDriver {
  if (cachedDriver) return cachedDriver;
  const localRequire = createRequire(path.join(process.cwd(), "package.json"));
  const loaded = localRequire("better-sqlite3") as { default?: SqliteDriver } | SqliteDriver;
  cachedDriver = typeof loaded === "function" ? loaded : loaded.default ?? null;
  if (!cachedDriver) throw new Error("better-sqlite3 did not expose a database constructor");
  return cachedDriver;
}

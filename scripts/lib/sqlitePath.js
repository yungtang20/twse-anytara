import { existsSync, statSync } from "node:fs";
import path from "node:path";

export function requireExplicitSqlitePath() {
  const configuredPath = process.env.SQLITE_DB_PATH?.trim();
  if (!configuredPath) {
    throw new Error("SQLITE_DB_PATH is required for SQLite maintenance");
  }
  const resolvedPath = path.resolve(configuredPath);
  if (!existsSync(resolvedPath) || !statSync(resolvedPath).isFile()) {
    throw new Error(`SQLite database path must be an existing file: ${resolvedPath}`);
  }
  return resolvedPath;
}

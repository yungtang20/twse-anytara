import Database from "better-sqlite3";
import { requireExplicitSqlitePath } from "./lib/sqlitePath";

if (!process.argv.includes("--execute")) {
  throw new Error("Refusing destructive SQLite reset without --execute");
}
const db = new Database(requireExplicitSqlitePath(), { fileMustExist: true });
db.prepare("DELETE FROM stock_price").run();
db.prepare("DELETE FROM stock_institutional").run();
db.prepare("DELETE FROM tdcc_shareholding").run();
console.log("Deleted old data from SQLite. Now running full pull...");

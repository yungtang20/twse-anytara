import Database from "better-sqlite3";
import { requireExplicitSqlitePath } from "./lib/sqlitePath";

const db = new Database(requireExplicitSqlitePath(), { readonly: true, fileMustExist: true });
const count = db.prepare("SELECT count(*) as c FROM stock_price WHERE stock_id='2330'").get() as { c: number };
console.log(`SQLite has ${count.c} trading days for 2330.`);

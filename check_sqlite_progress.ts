import Database from "better-sqlite3";
import { requireExplicitSqlitePath } from "./scripts/lib/sqlitePath";

const db = new Database(requireExplicitSqlitePath(), { readonly: true, fileMustExist: true });
const count = db.prepare("SELECT count(*) as c, min(date) as min_date, max(date) as max_date FROM stock_price WHERE stock_id='2330'").get();
console.log(count);

import Database from "better-sqlite3";
const db = new Database("twstock/taiwan_stock_unified.db");
const row = db.prepare("SELECT count(*) as c, min(date) as mn, max(date) as mx FROM stock_price WHERE stock_id='2330'").get();
console.log(row);

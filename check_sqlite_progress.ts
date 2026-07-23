import Database from "better-sqlite3";
const db = new Database("twstock/taiwan_stock_unified.db");
const count = db.prepare("SELECT count(*) as c, min(date) as min_date, max(date) as max_date FROM stock_price WHERE stock_id='2330'").get();
console.log(count);

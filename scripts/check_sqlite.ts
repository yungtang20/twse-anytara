import Database from "better-sqlite3";
const db = new Database("twstock/taiwan_stock_unified.db");
const count = db.prepare("SELECT count(*) as c FROM stock_price WHERE stock_id='2330'").get() as { c: number };
console.log(`SQLite has ${count.c} trading days for 2330.`);

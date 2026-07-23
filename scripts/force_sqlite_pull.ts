import Database from "better-sqlite3";
const db = new Database("twstock/taiwan_stock_unified.db");
db.prepare("DELETE FROM stock_price").run();
db.prepare("DELETE FROM stock_institutional").run();
db.prepare("DELETE FROM tdcc_shareholding").run();
console.log("Deleted old data from SQLite. Now running full pull...");

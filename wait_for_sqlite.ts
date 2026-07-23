import Database from "better-sqlite3";
import { execSync } from "child_process";

const db = new Database("twstock/taiwan_stock_unified.db");

async function wait() {
  while (true) {
    const { c } = db.prepare("SELECT count(*) as c FROM stock_price WHERE stock_id='2330'").get() as any;
    console.log(`Current SQLite days for 2330: ${c}`);
    if (c >= 500) {
      console.log("We reached 500+ days!");
      break;
    }
    await new Promise(r => setTimeout(r, 5000));
  }
}

wait();

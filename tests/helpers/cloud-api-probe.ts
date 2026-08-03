import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { request } from "node:http";
import type { Server } from "node:http";
import path from "node:path";
import Database from "better-sqlite3";
import express from "express";

const sandbox = process.argv[2];
if (!sandbox) throw new Error("cloud-api-probe requires an OS-temp sandbox path");

process.chdir(sandbox);
process.env.MARKET_DATA_MODE = "cloud";
process.env.NODE_ENV = "test";
for (const key of [
  "SUPABASE_URL",
  "VITE_SUPABASE_URL",
  "SUPABASE_ANON_KEY",
  "VITE_SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
]) delete process.env[key];

const baitPath = path.join(sandbox, "sqlite-fallback-must-not-be-used.db");
process.env.SQLITE_DB_PATH = baitPath;
process.env.TRADE_RISK_SQLITE_PATH = baitPath;

const bait = new Database(baitPath);
bait.exec(`
  CREATE TABLE sentinel (value TEXT NOT NULL);
  INSERT INTO sentinel VALUES ('must-remain-byte-identical');
  CREATE TABLE stock_meta (
    stock_id TEXT PRIMARY KEY,
    stock_name TEXT,
    market TEXT,
    type TEXT,
    status TEXT
  );
  INSERT INTO stock_meta VALUES ('2330', 'local bait', 'TSE', 'COMMON', 'active');
  CREATE TABLE stock_trade_risk (
    id INTEGER PRIMARY KEY,
    stock_id TEXT NOT NULL,
    market TEXT NOT NULL,
    risk_type TEXT NOT NULL,
    risk_level TEXT NOT NULL,
    reason TEXT NOT NULL,
    restrictions TEXT NOT NULL,
    announced_date TEXT,
    start_date TEXT NOT NULL,
    end_date TEXT,
    source TEXT NOT NULL,
    source_url TEXT NOT NULL,
    source_updated_at TEXT,
    fetched_at TEXT NOT NULL,
    is_active INTEGER NOT NULL,
    raw_data TEXT,
    record_key TEXT
  );
  INSERT INTO stock_trade_risk VALUES (
    1, '2330', 'TWSE', 'attention', 'medium', 'LOCAL_SQLITE_BAIT',
    'must never escape in cloud mode', '2026-07-31', '2026-07-31', NULL,
    'sqlite-bait', 'https://invalid.example/', '2026-07-31',
    '2026-07-31T00:00:00Z', 1, '{}', 'bait'
  );
`);
bait.close();

const digest = () => createHash("sha256").update(readFileSync(baitPath)).digest("hex");
const beforeDigest = digest();
let outboundFetches = 0;
globalThis.fetch = (async () => {
  outboundFetches += 1;
  throw new Error("outbound network is forbidden in cloud API boundary tests");
}) as typeof fetch;

let server: Server | undefined;

function get(port: number, urlPath: string): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path: urlPath, method: "GET" }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode || 0, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
        } catch (error) { reject(error); }
      });
    });
    req.setTimeout(5_000, () => req.destroy(new Error(`probe request timed out: ${urlPath}`)));
    req.once("error", reject);
    req.end();
  });
}

async function closeServer(instance: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      instance.closeAllConnections();
      reject(new Error("probe server shutdown timed out"));
    }, 5_000);
    instance.close((error) => {
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    });
  });
}

let output: string;
try {
  const { default: apiRouter } = await import("../../server/routes");
  const app = express();
  app.use(express.json());
  app.use(apiRouter);
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("probe server startup timed out")), 5_000);
    server?.once("listening", () => {
      clearTimeout(timer);
      resolve();
    });
    server?.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") throw new Error("probe server has no TCP address");
  const responses = Object.fromEntries(await Promise.all([
    ["history", "/api/stock/2330/history"],
    ["quote", "/api/stock/2330/quote"],
    ["stockRisk", "/api/stock/2330/trade-risks"],
    ["marketRisk", "/api/market/trade-risks?active=true"],
    ["riskStatus", "/api/status/trade-risk"],
  ].map(async ([name, url]) => [name, await get(address.port, url)])));
  output = JSON.stringify({
    responses,
    outboundFetches,
    sqliteUnchanged: beforeDigest === digest(),
    sqliteSidecars: ["-wal", "-shm"].filter((suffix) => existsSync(`${baitPath}${suffix}`)),
  });
} finally {
  if (server?.listening) await closeServer(server);
}

await new Promise<void>((resolve, reject) => {
  process.stdout.write(`${output!}\n`, (error) => error ? reject(error) : resolve());
});

import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { request } from "node:http";
import https from "node:https";
import path from "node:path";
import Database from "better-sqlite3";
import express from "express";

const sandbox = process.argv[2];
type Scenario =
  | "unconfigured"
  | "reachable"
  | "unauthorized"
  | "forbidden"
  | "no-content"
  | "timeout"
  | "stats-failed";
const scenario = process.argv[3] as Scenario | undefined;
if (!sandbox || !scenario) throw new Error("cloud-health-stats-probe requires a sandbox and scenario");

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

if (scenario !== "unconfigured") {
  process.env.SUPABASE_URL = "https://stub-project.supabase.invalid";
  process.env.SUPABASE_ANON_KEY = "stub-anon-key";
}

const baitPath = path.join(sandbox, "sqlite-must-not-open.db");
process.env.SQLITE_DB_PATH = baitPath;
process.env.TRADE_RISK_SQLITE_PATH = baitPath;
const bait = new Database(baitPath);
bait.exec("CREATE TABLE sentinel (value TEXT NOT NULL); INSERT INTO sentinel VALUES ('unchanged');");
bait.close();
const digest = () => createHash("sha256").update(readFileSync(baitPath)).digest("hex");
const beforeDigest = digest();

let outboundFetches = 0;
let healthProbe: {
  pathname: string;
  searchParams: Record<string, string>;
  method: string;
  apikey: string | null;
  authorization: string | null;
} | undefined;
globalThis.fetch = (async (input, init) => {
  outboundFetches += 1;
  const url = new URL(String(input));
  const headers = new Headers(init?.headers);
  healthProbe = {
    pathname: url.pathname,
    searchParams: Object.fromEntries(url.searchParams),
    method: init?.method || "GET",
    apikey: headers.get("apikey"),
    authorization: headers.get("authorization"),
  };
  if (scenario === "timeout") {
    return await new Promise<Response>((_resolve, reject) => {
      const rejectTimeout = () => reject(new DOMException("The operation was aborted", "AbortError"));
      if (init?.signal?.aborted) rejectTimeout();
      else init?.signal?.addEventListener("abort", rejectTimeout, { once: true });
    });
  }
  const statusByScenario: Partial<Record<Scenario, number>> = {
    reachable: 200,
    unauthorized: 401,
    forbidden: 403,
    "no-content": 204,
  };
  const status = statusByScenario[scenario];
  if (status) return new Response(null, { status });
  throw new Error("fetch failed: outbound network is forbidden in boundary tests");
}) as typeof fetch;

https.get = ((..._args: unknown[]) => {
  outboundFetches += 1;
  const blockedRequest = new EventEmitter();
  queueMicrotask(() => blockedRequest.emit(
    "error",
    new Error("fetch failed: outbound HTTPS is forbidden in boundary tests"),
  ));
  return blockedRequest;
}) as typeof https.get;

const { default: statusRouter } = await import("../../server/routes/status");
const app = express();
app.use(statusRouter);
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve, reject) => {
  server.once("listening", resolve);
  server.once("error", reject);
});
const address = server.address();
if (!address || typeof address === "string") throw new Error("probe server has no TCP address");
const port = address.port;

function get(urlPath: string): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path: urlPath, method: "GET" }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      res.on("end", () => {
        try {
          resolve({
            status: res.statusCode || 0,
            body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>,
          });
        } catch (error) { reject(error); }
      });
    });
    req.setTimeout(4_000, () => req.destroy(new Error("probe request timed out")));
    req.once("error", reject);
    req.end();
  });
}

const requests = scenario === "stats-failed"
  ? [["twse", "/api/twse-stats"], ["otc", "/api/otc-stats"]] as const
  : [["health", "/api/health"]] as const;
const responses = Object.fromEntries(
  await Promise.all(requests.map(async ([name, url]) => [name, await get(url)])),
);
const output = JSON.stringify({
  responses,
  outboundFetches,
  healthProbe,
  sqliteUnchanged: beforeDigest === digest(),
  sqliteSidecars: ["-wal", "-shm"].filter((suffix) => existsSync(`${baitPath}${suffix}`)),
});
await new Promise<void>((resolve) => server.close(() => resolve()));
process.stdout.write(`${output}\n`);

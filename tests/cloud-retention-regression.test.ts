import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

test("latest retention function uses actual stored price dates", async () => {
  const directory = new URL("../supabase/migrations/", import.meta.url);
  const files = (await readdir(directory)).filter((name) => name.endsWith(".sql")).sort();
  const definitions: string[] = [];
  for (const file of files) {
    const sql = await readFile(new URL(file, directory), "utf8");
    if (sql.includes("create or replace function public.enforce_cloud_retention")) definitions.push(sql);
  }
  const latest = definitions.at(-1) ?? "";
  const retention = latest.split("create or replace function public.market_retention_status")[0];
  assert.match(retention, /select distinct date\s+from public\.stock_price/i);
  assert.doesNotMatch(retention, /from public\.trading_calendar/i);
});

test("safe cloud capacity does not run retention before market upload", async () => {
  const source = await readFile(new URL("../scripts/syncData.ts", import.meta.url), "utf8");
  const body = source.match(/async function prepareCloudWrite[\s\S]*?\n}/)?.[0] ?? "";
  assert.ok(body.indexOf("getStorageStatus()") < body.indexOf("enforceRetention()"));
  assert.match(body, /if \(storage\.database_bytes >= WRITE_CEILING_BYTES\)[\s\S]*enforceRetention\(\)/);
});

test("retention status scans the price-date index once", async () => {
  const directory = new URL("../supabase/migrations/", import.meta.url);
  const files = (await readdir(directory)).filter((name) => name.endsWith(".sql")).sort();
  const definitions: string[] = [];
  for (const file of files) {
    const sql = await readFile(new URL(file, directory), "utf8");
    if (sql.includes("create or replace function public.market_retention_status")) definitions.push(sql);
  }
  const latest = definitions.at(-1) ?? "";
  assert.match(latest, /price_dates as materialized\s*\(\s*select distinct date from public\.stock_price/i);
  assert.match(latest, /select count\(\*\) from price_dates/i);
});

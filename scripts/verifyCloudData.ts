import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import express from "express";
import { once } from "events";
import apiRouter from "../server/routes";
import { fetchAnalysisSnapshot } from "../server/mvpMcpRoutes";
import { createSupabaseAdminClient } from "./lib/supabaseAdmin";

dotenv.config();

const admin = createSupabaseAdminClient();
const url = process.env.SUPABASE_URL;
const anonKey = process.env.SUPABASE_ANON_KEY;
if (!url || !anonKey) throw new Error("SUPABASE_URL and SUPABASE_ANON_KEY are required");
const publicClient = createClient(url, anonKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

async function tableStatus(table: string, dateColumn = "date") {
  const [{ count, error: countError }, { data, error: dateError }] = await Promise.all([
    admin.from(table).select("*", { count: "exact", head: true }),
    admin.from(table).select(dateColumn).order(dateColumn, { ascending: false }).limit(1).maybeSingle(),
  ]);
  if (countError) throw new Error(`${table} count: ${countError.message}`);
  if (dateError) throw new Error(`${table} date: ${dateError.message}`);
  const latestRow = data as Record<string, unknown> | null;
  return { table, rows: count || 0, latest: latestRow?.[dateColumn] || null };
}

async function run() {
  const { data: storageData, error: storageError } = await admin.rpc("cloud_storage_status");
  if (storageError) throw new Error(storageError.message);
  const storage = Array.isArray(storageData) ? storageData[0] : storageData;
  const databaseBytes = Number(storage?.database_bytes || 0);
  const budgetBytes = Number(storage?.budget_bytes || 500 * 1024 * 1024);
  if (databaseBytes >= budgetBytes) throw new Error(`Database exceeds budget: ${databaseBytes}`);

  const tables = await Promise.all([
    tableStatus("stock_price"),
    tableStatus("stock_institutional"),
    tableStatus("tdcc_shareholding"),
    tableStatus("stock_meta", "last_trade_date"),
  ]);
  const { data: retentionData, error: retentionError } = await admin.rpc("market_retention_status");
  if (retentionError) throw new Error(`market_retention_status: ${retentionError.message}`);
  const retention = Array.isArray(retentionData) ? retentionData[0] : retentionData;
  if (Number(retention?.price_dates || 0) > 512) {
    throw new Error(`Price retention exceeded 512 trading dates: ${retention?.price_dates}`);
  }

  const { data: publicPrice, error: publicReadError } = await publicClient
    .from("stock_price")
    .select("stock_id,date")
    .order("date", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (publicReadError || !publicPrice) {
    throw new Error(`Anonymous market-data read failed: ${publicReadError?.message || "no data"}`);
  }

  const { error: publicWriteError } = await publicClient
    .from("stock_meta")
    .insert({
      stock_id: "RLS_TEST",
      stock_name: "must_not_write",
      market: "TSE",
      source: "verification",
    });
  if (!publicWriteError) throw new Error("Anonymous write unexpectedly succeeded");

  const dashboardCards: Record<string, number> = {};
  for (const card of ["movers", "recent_dividend", "trust_buy_2day", "break_ma200", "limit_up_yesterday"]) {
    const { data, error } = await publicClient.rpc("market_dashboard", {
      card,
      result_limit: card === "movers" ? 100 : 10,
    });
    if (error) throw new Error(`market_dashboard(${card}): ${error.message}`);
    dashboardCards[card] = Array.isArray(data)
      ? data.length
      : card === "movers" && data && typeof data === "object"
        ? Object.keys(data).length
        : 0;
  }

  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use(apiRouter);
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Cannot start verification server");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const apiChecks: Record<string, unknown> = {};
  try {
    for (const [name, path] of [
      ["quote", "/api/stock/2330/quote"],
      ["history", "/api/stock/2330/history?days=3"],
      ["institutional", "/api/stock/2330/institutional"],
      ["shareholding", "/api/stock/2330/shareholding"],
      ["ma", "/api/stock/2330/ma-analysis"],
      ["dashboard", "/api/dashboard/trust-buy-2day"],
    ]) {
      const response = await fetch(`${baseUrl}${path}`);
      const payload = await response.json() as Record<string, unknown>;
      if (!response.ok || payload.success !== true || payload.source !== "supabase") {
        throw new Error(`${name} API did not return Supabase data`);
      }
      apiChecks[name] = true;
    }
  } finally {
    server.close();
    await once(server, "close");
  }

  const aiSnapshot = await fetchAnalysisSnapshot("2330", undefined, ["morgan_stanley"]);
  if (aiSnapshot.series.TaiwanStockPrice?.source !== "supabase") {
    throw new Error("AI snapshot did not use Supabase prices");
  }

  console.log(JSON.stringify({
    databaseMiB: Number((databaseBytes / 1024 / 1024).toFixed(1)),
    budgetMiB: Number((budgetBytes / 1024 / 1024).toFixed(1)),
    tables,
    retention,
    anonymousRead: true,
    anonymousWriteBlocked: true,
    dashboardCards,
    apiChecks,
    aiSnapshotSource: aiSnapshot.series.TaiwanStockPrice.source,
  }, null, 2));
}

run().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

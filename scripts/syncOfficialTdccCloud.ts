import path from "node:path";
import { pathToFileURL } from "node:url";
import { downloadTdccCSV, filterTdccRecordsByEligibleStocks, parseTdccCSV,
  type TdccRecord } from "../server/lib/tdccDownload.js";
import { isOrdinaryStockId } from "../server/lib/stockUniverse.js";
import { createSupabaseAdminClient } from "./lib/supabaseAdmin.js";

const WRITE_CEILING_BYTES = 450 * 1024 * 1024;
const BATCH_SIZE = 500;
const MINIMUM_COVERAGE_RATIO = 0.95;
const TDCC_COLUMNS = ["stock_id", "date", "total_shares", "whale_ratio", "retail_ratio",
  "total_people", "whale_shares", "whale_people", "source"] as const;

export type OfficialTdccCloudRow = TdccRecord & { source: string };

export interface OfficialTdccCloudDependencies {
  downloadCsv?: () => Promise<string>;
  loadEligibleStockIds?: () => Promise<Set<string>>;
  loadCloudRows?: (date: string) => Promise<OfficialTdccCloudRow[]>;
  readDatabaseBytes?: () => Promise<number>;
  upsertRows?: (rows: TdccRecord[]) => Promise<void>;
}

export interface OfficialTdccCloudResult {
  mode: "dry-run" | "execute";
  date: string;
  records: number;
  eligibleStocks: number;
  matchedStocks: number;
  missingStocks: number;
  coverageRatio: number;
  plannedRows: number;
  writtenRows: number;
}

type AdminClient = ReturnType<typeof createSupabaseAdminClient>;

function parseMode(args: string[]): "dry-run" | "execute" {
  if (args.some((arg) => !["--dry-run", "--execute"].includes(arg))) throw new Error("tdcc_unknown_argument");
  if (args.includes("--dry-run") && args.includes("--execute")) throw new Error("tdcc_conflicting_mode");
  return args.includes("--execute") ? "execute" : "dry-run";
}

async function loadEligibleStockIds(client: AdminClient): Promise<Set<string>> {
  const eligible = new Set<string>();
  for (let offset = 0; ; offset += 1_000) {
    const { data, error } = await client.from("stock_meta")
      .select("stock_id,status,type,market").order("stock_id").range(offset, offset + 999);
    if (error) throw new Error(`tdcc_stock_meta_read_failed:${error.message}`);
    for (const row of data || []) {
      const stockId = String(row.stock_id ?? "");
      if (row.status === "active" && ["COMMON", "stock"].includes(String(row.type))
        && ["TSE", "OTC"].includes(String(row.market)) && isOrdinaryStockId(stockId)) eligible.add(stockId);
    }
    if (!data || data.length < 1_000) break;
  }
  return eligible;
}

async function readDatabaseBytes(client: AdminClient): Promise<number> {
  const { data, error } = await client.rpc("cloud_storage_status");
  if (error) throw new Error(`tdcc_capacity_read_failed:${error.message}`);
  const row = Array.isArray(data) ? data[0] : data;
  const bytes = Number(row?.database_bytes);
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error("tdcc_capacity_invalid");
  return bytes;
}

async function loadCloudRows(client: AdminClient, date: string): Promise<OfficialTdccCloudRow[]> {
  const rows: OfficialTdccCloudRow[] = [];
  for (let offset = 0; ; offset += 1_000) {
    const { data, error } = await client.from("tdcc_shareholding").select(TDCC_COLUMNS.join(","))
      .eq("date", date).order("stock_id").range(offset, offset + 999);
    if (error) throw new Error(`tdcc_cloud_read_failed:${error.message}`);
    rows.push(...((data || []) as unknown as OfficialTdccCloudRow[]));
    if (!data || data.length < 1_000) break;
  }
  return rows;
}

async function upsertRows(client: AdminClient, records: TdccRecord[]): Promise<void> {
  for (let offset = 0; offset < records.length; offset += BATCH_SIZE) {
    const rows = records.slice(offset, offset + BATCH_SIZE).map((record) => ({ ...record, source: "tdcc" }));
    const { error } = await client.from("tdcc_shareholding")
      .upsert(rows, { onConflict: "stock_id,date" });
    if (error) throw new Error(`tdcc_cloud_upsert_failed:${error.message}`);
  }
}

export function evaluateOfficialTdccCoverage(matchedStocks: number, eligibleStocks: number) {
  if (!Number.isSafeInteger(eligibleStocks) || eligibleStocks <= 0) {
    throw new Error("tdcc_eligible_stock_universe_empty");
  }
  if (!Number.isSafeInteger(matchedStocks) || matchedStocks < 0 || matchedStocks > eligibleStocks) {
    throw new Error("tdcc_official_coverage_invalid");
  }
  const coverageRatio = matchedStocks / eligibleStocks;
  if (coverageRatio < MINIMUM_COVERAGE_RATIO) throw new Error("tdcc_official_coverage_below_threshold");
  return { matchedStocks, eligibleStocks, missingStocks: eligibleStocks - matchedStocks, coverageRatio };
}

function validateHeader(csv: string): void {
  const header = csv.replace(/^﻿/, "").split(/\r?\n/, 1)[0].split(",")
    .map((value) => value.replace(/^['"]|['"]$/g, "").trim());
  const expected = ["資料日期", "證券代號", "持股分級", "人數", "股數", "占集保庫存數比例%"];
  if (expected.some((value, index) => header[index] !== value)) throw new Error("tdcc_official_header_invalid");
}

function desiredCloudRow(record: TdccRecord): OfficialTdccCloudRow {
  return { ...record, source: "tdcc" };
}

function sameCloudRow(left: OfficialTdccCloudRow, right: OfficialTdccCloudRow): boolean {
  return TDCC_COLUMNS.every((column) => Object.is(left[column], right[column]));
}

export function planOfficialTdccCloudRows(records: TdccRecord[],
  cloudRows: OfficialTdccCloudRow[]): TdccRecord[] {
  const cloud = new Map<string, OfficialTdccCloudRow>();
  for (const row of cloudRows) {
    const key = `${row.stock_id}\u0000${row.date}`;
    if (cloud.has(key)) throw new Error(`tdcc_cloud_duplicate_key:${row.stock_id}:${row.date}`);
    cloud.set(key, row);
  }
  return records.filter((record) => {
    const current = cloud.get(`${record.stock_id}\u0000${record.date}`);
    return !current || !sameCloudRow(desiredCloudRow(record), current);
  }).sort((left, right) => left.date.localeCompare(right.date) || left.stock_id.localeCompare(right.stock_id));
}

function validateOfficialPayload(csv: string, eligible: ReadonlySet<string>) {
  if (eligible.size === 0) throw new Error("tdcc_eligible_stock_universe_empty");
  validateHeader(csv);
  const parsed = parseTdccCSV(csv);
  const filtered = filterTdccRecordsByEligibleStocks(parsed, eligible);
  if (!parsed.date || parsed.parsedRows <= 0 || filtered.records.length === 0) {
    throw new Error("tdcc_official_payload_empty");
  }
  const coverage = evaluateOfficialTdccCoverage(filtered.report.matchedSymbols, eligible.size);
  if (filtered.records.some((record) => record.date !== parsed.date)) throw new Error("tdcc_official_date_mismatch");
  return { date: parsed.date, records: filtered.records, coverage };
}

export async function runOfficialTdccCloudSync(args: string[] = process.argv.slice(2),
  dependencies: OfficialTdccCloudDependencies = {}): Promise<OfficialTdccCloudResult> {
  const mode = parseMode(args);
  let client: AdminClient | null = null;
  const admin = (): AdminClient => {
    client ??= createSupabaseAdminClient();
    return client;
  };
  const eligible = await (dependencies.loadEligibleStockIds ?? (() => loadEligibleStockIds(admin())))();
  const csv = await (dependencies.downloadCsv ?? downloadTdccCSV)();
  const payload = validateOfficialPayload(csv, eligible);
  const cloudRows = await (dependencies.loadCloudRows ?? ((date) => loadCloudRows(admin(), date)))(payload.date);
  const planned = planOfficialTdccCloudRows(payload.records, cloudRows);
  if (planned.length > 0) {
    const databaseBytes = await (dependencies.readDatabaseBytes ?? (() => readDatabaseBytes(admin())))();
    const estimatedDatabaseBytes = databaseBytes + planned.length * 1_024;
    if (estimatedDatabaseBytes >= WRITE_CEILING_BYTES) throw new Error("tdcc_cloud_capacity_blocked");
  }
  if (mode === "execute" && planned.length > 0) {
    await (dependencies.upsertRows ?? ((rows) => upsertRows(admin(), rows)))(planned);
  }
  return { mode, date: payload.date, records: payload.records.length,
    ...payload.coverage, plannedRows: planned.length,
    writtenRows: mode === "execute" ? planned.length : 0 };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  runOfficialTdccCloudSync().then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch((error) => {
      process.stderr.write(`${JSON.stringify({ status: "failed",
        error: error instanceof Error ? error.message : String(error) })}\n`);
      process.exitCode = 1;
    });
}

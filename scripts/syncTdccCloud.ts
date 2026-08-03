import { createHash } from "node:crypto";
import { createReadStream, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import { createSupabaseAdminClient } from "./lib/supabaseAdmin.js";
import {
  buildTdccCloudSyncPlan,
  executeTdccUpsertBatches,
  syncTdccPages,
  type TdccCloudSyncRow,
  type TdccSyncCursor,
  type TdccSyncRow,
} from "../server/lib/syncBridge.js";

const PROJECT_REF = "lboyyozisexmmcntemcy";
const TABLE = "tdcc_shareholding";
const SAFE_DATABASE_BYTES = 450 * 1024 * 1024;
const PAGE_SIZE = 1_000;
const BATCH_SIZE = 500;
const COLUMNS = [
  "stock_id", "date", "total_shares", "whale_ratio", "retail_ratio",
  "total_people", "whale_shares", "whale_people", "source",
] as const;

interface Options {
  dbPath: string;
  checkpointPath: string;
  execute: boolean;
}

interface Checkpoint {
  official_dates?: unknown;
  failures?: unknown;
  no_data?: unknown;
  completion_status?: unknown;
}

interface CloudRow extends TdccSyncRow { source?: string }
type SqliteDatabase = InstanceType<typeof Database>;

function parseOptions(args: string[]): Options {
  let dbPath = "";
  let checkpointPath = "";
  let execute = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--db") dbPath = args[++index] || "";
    else if (arg === "--checkpoint") checkpointPath = args[++index] || "";
    else if (arg === "--execute") execute = true;
    else if (arg === "--dry-run") execute = false;
    else throw new Error(`unknown_argument:${arg}`);
  }
  if (!dbPath) throw new Error("missing_required_argument:--db");
  if (!checkpointPath) throw new Error("missing_required_argument:--checkpoint");
  return { dbPath: path.resolve(dbPath), checkpointPath: path.resolve(checkpointPath), execute };
}

async function sha256(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex").toUpperCase();
}

function asFiniteNonnegativeInteger(name: string, value: string | undefined): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`missing_or_invalid_capacity:${name}`);
  return parsed;
}

function key(stockId: string, date: string): string {
  return `${stockId}\u0000${date}`;
}

function checkpointEvidence(checkpointPath: string, eligible: ReadonlySet<string>, localRows: CloudRow[]) {
  const checkpoint = JSON.parse(readFileSync(checkpointPath, "utf8")) as Checkpoint;
  const officialDates = Array.isArray(checkpoint.official_dates)
    ? checkpoint.official_dates.filter((value): value is string => typeof value === "string") : [];
  const uniqueDates = new Set(officialDates);
  const legalDates = officialDates.every((value) => /^\d{4}-\d{2}-\d{2}$/.test(value)
    && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)));
  const failures = checkpoint.failures && typeof checkpoint.failures === "object"
    ? Object.keys(checkpoint.failures) : ["invalid_failures"];
  const noData = new Set<string>();
  let malformedNoData = 0;
  if (checkpoint.no_data && typeof checkpoint.no_data === "object" && !Array.isArray(checkpoint.no_data)) {
    for (const [stockId, dates] of Object.entries(checkpoint.no_data)) {
      if (!Array.isArray(dates)) { malformedNoData += 1; continue; }
      for (const date of dates) {
        if (typeof date !== "string") malformedNoData += 1;
        else noData.add(key(stockId, date));
      }
    }
  } else malformedNoData += 1;
  const stored = new Set(localRows.filter((row) => eligible.has(row.stock_id)).map((row) => key(row.stock_id, row.date)));
  let unresolvedPairs = 0;
  let overlapPairs = 0;
  for (const stockId of eligible) {
    for (const date of officialDates) {
      const pair = key(stockId, date);
      if (stored.has(pair) && noData.has(pair)) overlapPairs += 1;
      if (!stored.has(pair) && !noData.has(pair)) unresolvedPairs += 1;
    }
  }
  let outsideRequestedNoDataPairs = 0;
  for (const pair of noData) {
    const [stockId, date] = pair.split("\u0000");
    if (!eligible.has(stockId) || !uniqueDates.has(date)) outsideRequestedNoDataPairs += 1;
  }
  return {
    completionStatus: checkpoint.completion_status,
    officialDates: officialDates.length,
    officialDatesUnique: uniqueDates.size,
    legalDates,
    failureCount: failures.length,
    requestedPairs: eligible.size * officialDates.length,
    storedPairs: stored.size,
    officialNoDataPairs: noData.size,
    unresolvedPairs,
    overlapPairs,
    outsideRequestedNoDataPairs,
    malformedNoData,
  };
}

async function collectLocalRows(db: SqliteDatabase): Promise<CloudRow[]> {
  const statement = db.prepare(`
    SELECT stock_id, date, total_shares, whale_ratio, retail_ratio,
           total_people, whale_shares, whale_people, source
    FROM shareholding_unified
    WHERE source = 'tdcc'
      AND (date > ? OR (date = ? AND stock_id > ?))
    ORDER BY date, stock_id
    LIMIT ?
  `);
  const rows: CloudRow[] = [];
  await syncTdccPages(
    (cursor, limit) => statement.all(cursor?.date || "", cursor?.date || "", cursor?.stockId || "", limit) as CloudRow[],
    async (page) => { rows.push(...page); },
    null,
    PAGE_SIZE,
  );
  return rows;
}

function eligibleStockIds(db: SqliteDatabase): Set<string> {
  const rows = db.prepare(`
    SELECT stock_id FROM stock_meta
    WHERE status = 'active' AND type = 'COMMON' AND market IN ('TSE','OTC')
      AND (stock_id GLOB '[1-8][0-9][0-9][0-9]' OR stock_id GLOB '9[02-9][0-9][0-9]')
    ORDER BY stock_id
  `).all() as Array<{ stock_id: string }>;
  return new Set(rows.map((row) => row.stock_id));
}

async function collectCloudRows(client: ReturnType<typeof createSupabaseAdminClient>): Promise<CloudRow[]> {
  const rows: CloudRow[] = [];
  await syncTdccPages(async (cursor: TdccSyncCursor | null, limit: number) => {
    let query = client.from(TABLE).select(COLUMNS.join(","))
      .order("date", { ascending: true }).order("stock_id", { ascending: true }).limit(limit);
    if (cursor) query = query.or(`date.gt.${cursor.date},and(date.eq.${cursor.date},stock_id.gt.${cursor.stockId})`);
    const { data, error } = await query;
    if (error) throw new Error(`cloud_read_failed:${error.message}`);
    return (data || []) as unknown as CloudRow[];
  }, async (page) => { rows.push(...page); }, null, PAGE_SIZE);
  return rows;
}

function assertProject(): void {
  const url = process.env.SUPABASE_URL;
  if (!url || new URL(url).hostname !== `${PROJECT_REF}.supabase.co`) throw new Error("supabase_project_mismatch");
}

export async function runTdccCloudSync(args: string[]): Promise<Record<string, unknown>> {
  const options = parseOptions(args);
  assertProject();
  const beforeSha = await sha256(options.dbPath);
  const db = new Database(options.dbPath, { readonly: true, fileMustExist: true });
  db.pragma("query_only = ON");
  let localRows: CloudRow[];
  let eligible: Set<string>;
  let quickCheck: string;
  let duplicateKeys: number;
  try {
    quickCheck = String((db.pragma("quick_check", { simple: true }) as string) || "");
    duplicateKeys = Number((db.prepare(`SELECT COUNT(*) count FROM (
      SELECT stock_id,date FROM shareholding_unified WHERE source='tdcc'
      GROUP BY stock_id,date HAVING COUNT(*) > 1
    )`).get() as { count: number }).count);
    eligible = eligibleStockIds(db);
    localRows = await collectLocalRows(db);
  } finally {
    db.close();
  }
  const checkpoint = checkpointEvidence(options.checkpointPath, eligible, localRows);
  const client = createSupabaseAdminClient();
  const cloudRows = await collectCloudRows(client);
  const plan = buildTdccCloudSyncPlan(localRows, cloudRows, eligible);
  const cloudDatabaseBytes = asFiniteNonnegativeInteger(
    "TDCC_CLOUD_DATABASE_BYTES", process.env.TDCC_CLOUD_DATABASE_BYTES,
  );
  const cloudRelationBytes = asFiniteNonnegativeInteger(
    "TDCC_CLOUD_RELATION_BYTES", process.env.TDCC_CLOUD_RELATION_BYTES,
  );
  const averageRelationBytes = cloudRows.length === 0 ? 256 : cloudRelationBytes / cloudRows.length;
  const estimatedDatabaseBytes = Math.ceil(cloudDatabaseBytes
    + plan.rowsToUpsert.length * Math.max(256, averageRelationBytes) * 1.5);
  const blocked: string[] = [];
  if (quickCheck !== "ok") blocked.push("sqlite_quick_check_failed");
  if (duplicateKeys !== 0) blocked.push("local_duplicate_keys");
  if (checkpoint.completionStatus !== "official_available_data_complete") blocked.push("checkpoint_not_complete");
  if (checkpoint.officialDates !== 51 || checkpoint.officialDatesUnique !== 51 || !checkpoint.legalDates) {
    blocked.push("invalid_official_dates");
  }
  if (checkpoint.failureCount !== 0) blocked.push("checkpoint_failures_present");
  if (checkpoint.unresolvedPairs !== 0 || checkpoint.overlapPairs !== 0
    || checkpoint.outsideRequestedNoDataPairs !== 0 || checkpoint.malformedNoData !== 0
    || checkpoint.storedPairs + checkpoint.officialNoDataPairs !== checkpoint.requestedPairs) {
    blocked.push("local_reconciliation_failed");
  }
  if (plan.rowsToUpsert.length !== plan.localOnlyKeys + plan.contentDifferentKeys) blocked.push("plan_count_mismatch");
  if (estimatedDatabaseBytes >= SAFE_DATABASE_BYTES) blocked.push("capacity_safety_line_exceeded");
  const schemaMappingMissing = COLUMNS.filter((column) => cloudRows.length > 0 && !(column in cloudRows[0]));
  if (schemaMappingMissing.length > 0) blocked.push("schema_mapping_missing");
  const afterDryReadSha = await sha256(options.dbPath);
  if (afterDryReadSha !== beforeSha) blocked.push("sqlite_changed_during_plan");
  const baseReport = {
    status: blocked.length === 0 ? "ready" : "blocked",
    mode: options.execute ? "execute" : "dry-run",
    projectRef: PROJECT_REF,
    table: TABLE,
    databasePath: options.dbPath,
    checkpointPath: options.checkpointPath,
    sqliteSha256Before: beforeSha,
    sqliteSha256AfterPlan: afterDryReadSha,
    quickCheck,
    duplicateKeys,
    eligibleStocks: eligible.size,
    localTdccRows: localRows.length,
    cloudRowsBefore: cloudRows.length,
    ...checkpoint,
    localOnlyKeys: plan.localOnlyKeys,
    cloudOnlyKeys: plan.cloudOnlyKeys,
    contentDifferentKeys: plan.contentDifferentKeys,
    identicalKeys: plan.identicalKeys,
    plannedRows: plan.rowsToUpsert.length,
    schemaMappingMissing,
    cloudDatabaseBytesBefore: cloudDatabaseBytes,
    cloudRelationBytesBefore: cloudRelationBytes,
    estimatedDatabaseBytes,
    safeDatabaseBytes: SAFE_DATABASE_BYTES,
    destructiveOperations: 0,
    tdccRequests: 0,
    blocked,
  };
  console.log(JSON.stringify({ event: "execution_plan", ...baseReport }));
  if (!options.execute) return baseReport;
  if (blocked.length > 0) throw new Error(`tdcc_cloud_sync_blocked:${blocked.join(",")}`);
  const writeResult = await executeTdccUpsertBatches(plan.rowsToUpsert, BATCH_SIZE, async (batch) => {
    const { error } = await client.from(TABLE).upsert(batch, { onConflict: "stock_id,date" });
    if (error) throw new Error(error.message);
  }, (progress) => console.log(JSON.stringify({ event: "batch_committed", ...progress })));
  const cloudAfter = await collectCloudRows(client);
  const verification = buildTdccCloudSyncPlan(localRows, cloudAfter, eligible);
  const finalSha = await sha256(options.dbPath);
  if (finalSha !== beforeSha) throw new Error("sqlite_changed_during_execute");
  if (verification.rowsToUpsert.length !== 0) {
    throw new Error(`cloud_verification_failed:${verification.rowsToUpsert.length}`);
  }
  const result = {
    ...baseReport,
    status: "complete",
    writtenRows: writeResult.writtenRows,
    successfulBatches: writeResult.successfulBatches,
    failedBatches: writeResult.failedBatches,
    cloudRowsAfter: cloudAfter.length,
    remainingLocalToCloudGap: verification.localOnlyKeys,
    remainingContentDifferences: verification.contentDifferentKeys,
    sqliteSha256After: finalSha,
  };
  console.log(JSON.stringify({ event: "complete", ...result }));
  return result;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  runTdccCloudSync(process.argv.slice(2)).catch((error) => {
    console.error(JSON.stringify({ status: "failed", error: error instanceof Error ? error.message : String(error) }));
    process.exitCode = 1;
  });
}

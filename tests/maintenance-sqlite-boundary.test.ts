import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const projectRoot = process.cwd();

function read(relativePath: string): string {
  return readFileSync(path.join(projectRoot, relativePath), "utf8");
}

const sqliteMaintenanceScripts = [
  "check_sqlite.ts",
  "check_sqlite_progress.ts",
  "wait_for_sqlite.ts",
  "scripts/_inspect_db.ts",
  "scripts/_status.ts",
  "scripts/backfillTdccLocal.ts",
  "scripts/bulk_load_512.ts",
  "scripts/check_sqlite.ts",
  "scripts/complete_and_fetch_today.js",
  "scripts/fast_sync.js",
  "scripts/force_sqlite_pull.ts",
  "scripts/pull_from_supabase.js",
] as const;

const unsafePathScripts: string[] = [];
for (const relativePath of sqliteMaintenanceScripts) {
  const source = read(relativePath);
  const usesFailClosedPathHelper = /requireExplicitSqlitePath/.test(source);
  const hasExplicitPathInput = usesFailClosedPathHelper || /(?:process\.env\.[A-Z][A-Z0-9_]*SQLITE[A-Z0-9_]*|--(?:database|db-path))/.test(source);
  const rejectsMissingPath = usesFailClosedPathHelper || /throw new Error\([^)]*(?:SQLite|database|DB)[^)]*(?:path|required|設定|指定)/is.test(source);
  const hasProjectLocalFallback = /twstock[\\/]["']?\s*,?\s*["']taiwan_stock_unified\.db|twstock[\\/]taiwan_stock_unified\.db/i.test(source);
  const databaseOpenCount = source.match(/new Database\(/g)?.length ?? 0;
  const failClosedOpenCount = source.match(/fileMustExist\s*:\s*(?:true|readonly)/g)?.length ?? 0;
  const canCreateMissingDatabase = failClosedOpenCount < databaseOpenCount;

  if (!hasExplicitPathInput || !rejectsMissingPath || hasProjectLocalFallback || canCreateMissingDatabase) {
    unsafePathScripts.push(relativePath);
  }
}

const packageJson = JSON.parse(read("package.json")) as {
  scripts?: Record<string, string>;
};
const tdccBackfillSource = read("scripts/backfillTdccLocal.ts");
const hasTdccCliEntrypoint = /import\.meta\.url[\s\S]{0,300}runTdccLocal\(/.test(tdccBackfillSource);
const hasDisabledTdccCliGuard = /import\.meta\.url[\s\S]{0,300}throw new Error\([^)]*disabled during database-authority phase one/i.test(tdccBackfillSource);
const dangerousTdccCommands = [
  ...(packageJson.scripts?.["report:tdcc-dry-run"] ? ["report:tdcc-dry-run"] : []),
  ...(packageJson.scripts?.["backfill:tdcc"] && !hasDisabledTdccCliGuard ? ["backfill:tdcc"] : []),
];

const tradeRisksSource = read("server/lib/tradeRisks.ts");
const tradeRiskCliSource = read("scripts/syncTradeRisks.ts");
const tradeRiskViolations = [
  ...(/path\.resolve\(process\.cwd\(\),\s*["']\.\.["'],\s*["']twstock["'],\s*["']taiwan_stock_unified\.db["']\)/.test(tradeRisksSource)
    ? ["trade-risk SQLite still defaults to ../twstock/taiwan_stock_unified.db"]
    : []),
  ...(/if\s*\(!riskPath\)\s*return\s+getDb\(\)/.test(tradeRisksSource)
    ? ["trade-risk SQLite falls back to getDb() when its path is missing"]
    : []),
  ...(!/TRADE_RISK_SQLITE_PATH/.test(tradeRisksSource)
    ? ["trade-risk SQLite path is not explicit"]
    : []),
  ...(!/throw new Error\([^)]*(?:TRADE_RISK_SQLITE_PATH|trade.risk|SQLite)[^)]*(?:required|existing|設定|指定)/is.test(tradeRisksSource)
    ? ["trade-risk SQLite does not fail closed when its explicit path is missing"]
    : []),
  ...(!/existsSync\(/.test(tradeRisksSource)
    ? ["trade-risk SQLite does not verify that the explicit path exists"]
    : []),
  ...(!/new Database\([^;]*readonly\s*:\s*true[^;]*fileMustExist\s*:\s*true/s.test(tradeRisksSource)
    ? ["trade-risk SQLite is not opened readonly with fileMustExist"]
    : []),
  ...(packageJson.scripts?.["sync:trade-risks"] && !/throw new Error\([^)]*disabled during database-authority phase one/i.test(tradeRiskCliSource)
    ? ["sync:trade-risks CLI is still enabled during phase one"]
    : []),
];

const violations = [
  ...unsafePathScripts.map((file) => `unsafe SQLite path: ${file}`),
  ...dangerousTdccCommands.map((name) => `direct npm TDCC command: ${name}`),
  ...(hasTdccCliEntrypoint ? ["TDCC backfill still has a direct CLI entrypoint"] : []),
  ...tradeRiskViolations,
];

assert.deepEqual(
  violations,
  [],
  `Phase-one maintenance boundary violations:\n${violations.join("\n")}`,
);

console.log("Maintenance SQLite boundary checks passed");

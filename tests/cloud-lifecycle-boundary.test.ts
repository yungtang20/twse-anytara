import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import ts from "typescript";
import { resolveDatabasePath, resolveTestDatabasePath } from "../server/db";
import { resolveRuntimeMode } from "../server/lib/runtimeMode";

const projectRoot = path.resolve(import.meta.dirname, "..");
const serverPath = path.join(projectRoot, "server.ts");
const serverSource = fs.readFileSync(serverPath, "utf8");
const sourceFile = ts.createSourceFile(
  serverPath,
  serverSource,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TS,
);

type LifecycleCall =
  | "initDb"
  | "getDb"
  | "resumeInterruptedJobs"
  | "startTdccScheduler"
  | "syncTdcc"
  | "backfillTdccHistory";

const lifecycleCalls: readonly LifecycleCall[] = [
  "initDb",
  "getDb",
  "resumeInterruptedJobs",
  "startTdccScheduler",
  "syncTdcc",
  "backfillTdccHistory",
];

function callName(node: ts.CallExpression): string | null {
  if (ts.isIdentifier(node.expression)) return node.expression.text;
  if (ts.isPropertyAccessExpression(node.expression)) return node.expression.name.text;
  return null;
}

function isTestModeCondition(node: ts.Expression): boolean {
  const condition = node.getText(sourceFile);
  return /(?:DATA_MODE|dataMode|mode|isTest)/i.test(condition)
    && /["']test["']/.test(condition);
}

function isInsideTestModeBoundary(node: ts.Node): boolean {
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    if (ts.isIfStatement(current) && isTestModeCondition(current.expression)) return true;
    if (ts.isConditionalExpression(current) && isTestModeCondition(current.condition)) return true;
  }
  return false;
}

function unguardedLifecycleCalls(): Record<LifecycleCall, number> {
  const counts = Object.fromEntries(lifecycleCalls.map((name) => [name, 0])) as Record<LifecycleCall, number>;
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const name = callName(node);
      if (name && lifecycleCalls.includes(name as LifecycleCall) && !isInsideTestModeBoundary(node)) {
        counts[name as LifecycleCall] += 1;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return counts;
}

const cloudCalls = unguardedLifecycleCalls();

assert.equal(cloudCalls.initDb, 0, "cloud startup must not call initDb");
assert.equal(cloudCalls.getDb, 0, "cloud startup must not call getDb");
assert.equal(cloudCalls.resumeInterruptedJobs, 0, "cloud startup must not resume the SQLite job queue");
assert.equal(cloudCalls.startTdccScheduler, 0, "cloud startup must not start the TDCC scheduler");

const cloudSqliteArtifactCreators = cloudCalls.initDb + cloudCalls.getDb;
assert.equal(
  cloudSqliteArtifactCreators,
  0,
  "cloud startup must not create a SQLite DB, WAL, or SHM artifact",
);

assert.equal(cloudCalls.syncTdcc, 0, "cloud startup TDCC sync count must remain zero");
assert.equal(cloudCalls.backfillTdccHistory, 0, "cloud startup TDCC backfill count must remain zero");

assert.equal(resolveRuntimeMode(undefined), "cloud", "cloud must be the fail-safe default mode");
assert.equal(resolveRuntimeMode("cloud"), "cloud");
assert.equal(resolveRuntimeMode("test"), "test");
assert.throws(() => resolveRuntimeMode("local"), /Expected "cloud" or "test"/);

assert.throws(
  () => resolveDatabasePath(projectRoot, undefined),
  /SQLITE_DB_PATH is required/,
  "test SQLite must not have a project-local default",
);
assert.throws(
  () => resolveTestDatabasePath(projectRoot, path.join(projectRoot, "twstock", "test.db")),
  /OS temporary directory/,
  "test SQLite must reject project-local database paths",
);
const explicitTempDb = path.join(os.tmpdir(), `trinity-cloud-boundary-${process.pid}-${Date.now()}`, "test.db");
assert.equal(
  resolveTestDatabasePath(projectRoot, explicitTempDb),
  path.resolve(explicitTempDb),
  "test SQLite must accept an explicit path under the OS temp directory",
);

for (const artifact of [explicitTempDb, `${explicitTempDb}-wal`, `${explicitTempDb}-shm`]) {
  assert.equal(fs.existsSync(artifact), false, `source-contract test must not create ${artifact}`);
}

console.log("cloud lifecycle boundary contract passed");

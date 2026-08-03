import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const projectRoot = path.resolve(import.meta.dirname, "..");

function parse(relativePath: string): ts.SourceFile {
  const absolutePath = path.join(projectRoot, relativePath);
  return ts.createSourceFile(
    absolutePath,
    fs.readFileSync(absolutePath, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
}

function callName(node: ts.CallExpression): string | null {
  if (ts.isIdentifier(node.expression)) return node.expression.text;
  if (ts.isPropertyAccessExpression(node.expression)) return node.expression.name.text;
  return null;
}

function callsWithin(node: ts.Node): ts.CallExpression[] {
  const calls: ts.CallExpression[] = [];
  const visit = (child: ts.Node): void => {
    if (ts.isCallExpression(child)) calls.push(child);
    ts.forEachChild(child, visit);
  };
  visit(node);
  return calls.sort((left, right) => left.getStart() - right.getStart());
}

function isCloudBoundaryCall(call: ts.CallExpression, sourceFile: ts.SourceFile): boolean {
  const name = callName(call) || "";
  if (/(?:require|assert).*(?:test|runtime)|rejectCloud/i.test(name)) return true;
  const text = call.getText(sourceFile);
  return /resolveRuntimeMode/.test(text);
}

function assertGuardPrecedesDanger(
  node: ts.Node,
  sourceFile: ts.SourceFile,
  dangerousNames: ReadonlySet<string>,
  message: string,
): void {
  const calls = callsWithin(node);
  const firstDanger = calls.find((call) => dangerousNames.has(callName(call) || ""));
  assert.ok(firstDanger, `${message}: expected a protected local-side-effect call`);
  const guard = calls.find((call) => call.getStart() < firstDanger.getStart() && isCloudBoundaryCall(call, sourceFile));
  assert.ok(guard, `${message}: cloud must fail closed before ${callName(firstDanger)}`);
}

function routeHandler(
  sourceFile: ts.SourceFile,
  method: "get" | "post" | "use",
  route?: string,
): ts.FunctionLikeDeclaration {
  let found: ts.FunctionLikeDeclaration | undefined;
  const visit = (node: ts.Node): void => {
    if (found || !ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) {
      if (!found) ts.forEachChild(node, visit);
      return;
    }
    if (node.expression.expression.getText(sourceFile) !== "router" || node.expression.name.text !== method) return;
    const routeMatches = route === undefined
      || (ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text === route);
    if (!routeMatches) return;
    const handler = [...node.arguments].reverse().find((argument) =>
      ts.isArrowFunction(argument) || ts.isFunctionExpression(argument));
    if (handler && (ts.isArrowFunction(handler) || ts.isFunctionExpression(handler))) found = handler;
  };
  ts.forEachChild(sourceFile, visit);
  assert.ok(found, `missing ${method.toUpperCase()} ${route || "middleware"}`);
  return found;
}

function namedFunction(sourceFile: ts.SourceFile, name: string): ts.FunctionLikeDeclaration {
  let found: ts.FunctionLikeDeclaration | undefined;
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) found = node;
    else if (!found) ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
  assert.ok(found, `missing handler ${name}`);
  return found;
}

const syncBackfillRoutes = parse("server/routes/syncBackfill.ts");
assertGuardPrecedesDanger(
  routeHandler(syncBackfillRoutes, "post", "/api/sync-daily"),
  syncBackfillRoutes,
  new Set(["exec"]),
  "POST /api/sync-daily",
);
assertGuardPrecedesDanger(
  routeHandler(syncBackfillRoutes, "post", "/api/trigger-update"),
  syncBackfillRoutes,
  new Set(["spawn", "fetch"]),
  "POST /api/trigger-update",
);

const settingsRoutes = parse("server/routes/settings.ts");
assertGuardPrecedesDanger(
  routeHandler(settingsRoutes, "post", "/api/settings/cleanup"),
  settingsRoutes,
  new Set(["pruneSupabaseData"]),
  "POST /api/settings/cleanup",
);

const analysisRoutes = parse("server/routes/analysisTdcc.ts");
const analysisMiddleware = routeHandler(analysisRoutes, "use");
const analysisUseCall = callsWithin(analysisRoutes).find((call) =>
  ts.isPropertyAccessExpression(call.expression)
  && call.expression.expression.getText(analysisRoutes) === "router"
  && call.expression.name.text === "use");
assert.ok(analysisUseCall, "analysis/TDCC routes must install a path-scoped middleware");
assert.ok(
  analysisUseCall.arguments.length > 1 && !ts.isFunctionLike(analysisUseCall.arguments[0]),
  "analysis/TDCC cloud guard must be path-scoped and must not swallow subsequent routers",
);
const guardedPaths = analysisUseCall.arguments[0].getText(analysisRoutes);
for (const requiredPrefix of ["/api/analysis-mvp", "/api/job", "/api/tdcc", "/api/bridge"]) {
  assert.match(guardedPaths, new RegExp(requiredPrefix.replaceAll("/", "\\/")));
}
assert.doesNotMatch(guardedPaths, /trade-risks|\/api\/market|\/api\/status/);
const analysisDanger = new Set([
  "mvpMcpHandler", "jobBatchHandler", "jobGetHandler", "jobDeleteHandler",
  "jobDeleteAllHandler", "jobCancelHandler", "jobListHandler", "ingestTdccCSV",
  "syncTdcc", "tdccSyncHandler", "tdccStatusHandler", "getBridgeStatus",
  "pushTdccToSupabase",
]);
const firstProtectedRouteCall = callsWithin(analysisRoutes).find((call) =>
  analysisDanger.has(callName(call) || ""));
assert.ok(firstProtectedRouteCall, "analysis/TDCC routes must contain protected calls");
const analysisGuard = callsWithin(analysisMiddleware).find((call) =>
  isCloudBoundaryCall(call, analysisRoutes));
assert.ok(
  analysisGuard && analysisMiddleware.getStart() < firstProtectedRouteCall.getStart(),
  "analysis, job, TDCC, and bridge routes must reject cloud before local handlers run",
);

assertGuardPrecedesDanger(
  routeHandler(syncBackfillRoutes, "post", "/api/local/backfill-finmind"),
  syncBackfillRoutes,
  new Set(["getDb", "scrapePriceFromYahoo", "fetch"]),
  "POST /api/local/backfill-finmind",
);

const mvpRoutes = parse("server/mvpMcpRoutes.ts");
const handlerDangers: Record<string, ReadonlySet<string>> = {
  jobBatchHandler: new Set(["startJob"]),
  jobGetHandler: new Set(["getJob"]),
  jobListHandler: new Set(["listJobs"]),
  jobCancelHandler: new Set(["cancelJob"]),
  jobDeleteHandler: new Set(["deleteJob"]),
  jobDeleteAllHandler: new Set(["deleteAllJobs"]),
  tdccSyncHandler: new Set(["syncTdcc"]),
  tdccStatusHandler: new Set(["getTdccSqliteStatus", "getTdccUniverseStatus"]),
};

for (const [handlerName, dangerousNames] of Object.entries(handlerDangers)) {
  assertGuardPrecedesDanger(
    namedFunction(mvpRoutes, handlerName),
    mvpRoutes,
    dangerousNames,
    handlerName,
  );
}

console.log("cloud admin SQLite boundary contract passed");

# Legacy Framework Analysis Seam Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 將舊版框架分析從 Express 路由模組抽出，消除 `mvpMcpRoutes.ts` 與 `jobQueue.ts` 的循環相依，同時完整保留既有資料、錯誤與路由行為。

**Architecture:** 新增無 Express、工作佇列及 SQLite 依賴的 `server/lib/legacyFrameworkAnalysis.ts`，集中 FinMind 擷取、快照建構、框架提示與 NVIDIA 報告生成。路由只透過窄介面驗證框架 ID，工作佇列與基本面路由直接依賴新模組；TypeScript AST 邊界測試固定單向相依。

**Tech Stack:** Node.js 24+, TypeScript 5.8, Express 4, Node test runner, `tsx`, TypeScript Compiler API, Vite, esbuild

## Global Constraints

- 正式執行模式維持 cloud-only；SQLite 僅限作業系統暫存目錄的測試模式。
- 不新增、移除或升級任何套件；不得變更 `package-lock.json`。
- 不變更 Supabase schema、migration、RLS、權限或雲端設定。
- 不執行同步、回填、刪除、`npm run verify:cloud` 或任何正式資料異動。
- 不更改 FinMind/NVIDIA 請求、重試、快取、框架提示、資料充分性判定、錯誤文字、HTTP 狀態或工作佇列行為。
- 保留目前 dirty worktree 中所有使用者及既有修改；不得 reset、clean、還原或覆蓋無關檔案。
- 未經使用者明確授權，不 stage、commit、push 或建立 PR；本計畫以 diff 與實際驗證輸出作為 checkpoint。
- CodeGraph 目前比 checkout 落後 234 個檔案；圖譜只作初始定位，實作以目前原始碼為準。
- 未實際執行的檢查只能記為「未驗證」，不得記為成功或失敗。

## File Structure

- Create `server/lib/legacyFrameworkAnalysis.ts`: 舊版框架分析的唯一實作與窄介面；不得匯入 Express、路由、工作佇列、`server/db.ts` 或 `better-sqlite3`。
- Create `tests/legacy-framework-analysis-boundary.test.ts`: 以 TypeScript AST 解析真實 import/export graph，防止循環與路由反向耦合復發。
- Modify `server/mvpMcpRoutes.ts`: 僅保留 HTTP handler、雲端拒絕邊界、工作佇列與 TDCC 協調。
- Modify `server/lib/jobQueue.ts`: 從新分析模組取得快照與框架分析，不再匯入路由。
- Modify `server/routes/fundamentals.ts`: 從新分析模組取得 FinMind/財務快照能力。
- Modify `tests/self-check.ts`: 將既有資料集選擇與 FinMind fallback 檢查指向新的實作擁有者。
- Modify `tests/test-suite-registration.test.ts`: 要求 canonical `npm test` 註冊新邊界測試。
- Modify `package.json`: 將新測試加入 canonical `npm test`；其他 scripts 與 dependencies 不動。

---

### Task 1: Extract and lock the one-way legacy analysis seam

**Files:**
- Create: `tests/legacy-framework-analysis-boundary.test.ts`
- Create: `server/lib/legacyFrameworkAnalysis.ts`
- Modify: `package.json:12`
- Modify: `server/mvpMcpRoutes.ts:1-606`
- Modify: `server/lib/jobQueue.ts:5-8`
- Modify: `server/routes/fundamentals.ts:1-4`
- Modify: `tests/self-check.ts:23,203-206,666-671,761-767`
- Modify: `tests/test-suite-registration.test.ts:8-47`

**Interfaces:**
- Consumes: `StockSnapshot`, `SnapshotRow`, `EvidenceSummary`, `ReportClaim`, `FRAMEWORK_CONTRACTS`, existing FinMind/cloud/cache/financial/NVIDIA helpers.
- Produces: `AnalysisSnapshot`, `FundamentalDatasetResult`, `FrameworkAnalysisResult`, `selectFinMindDatasetNames(frameworkIds?: string[]): string[]`, `fetchFundamentalDataset(stockId, datasetName, signal?)`, `fetchAnalysisSnapshot(stockId, signal?, frameworkIds?)`, `fetchFinancialSnapshot(stockId, signal?, identityOverride?)`, `isLegacyFrameworkId(value: string): boolean`, and `runFrameworkAnalysis(stockId, frameworkId, signal?, suppliedSnapshot?)`.

- [ ] **Step 1: Write the failing architecture-boundary test and register it**

Create `tests/legacy-framework-analysis-boundary.test.ts` with this complete test:

```ts
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";
import ts from "typescript";

const workspaceRoot = fileURLToPath(new URL("../", import.meta.url));

type ModuleEdge = {
  kind: "import" | "export";
  specifier: string;
  target: string | null;
};

function normalizeWorkspacePath(absolutePath: string): string {
  return path.relative(workspaceRoot, absolutePath).replaceAll("\\", "/");
}

function resolveLocalModule(fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null;
  const base = path.resolve(workspaceRoot, path.dirname(fromFile), specifier);
  const candidates = [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")];
  const resolved = candidates.find((candidate) => existsSync(candidate)) ?? `${base}.ts`;
  return normalizeWorkspacePath(resolved);
}

async function moduleEdges(file: string): Promise<ModuleEdge[]> {
  const sourceText = await readFile(path.join(workspaceRoot, file), "utf8");
  const sourceFile = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const edges: ModuleEdge[] = [];
  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const specifier = statement.moduleSpecifier.text;
      edges.push({ kind: "import", specifier, target: resolveLocalModule(file, specifier) });
      continue;
    }
    if (ts.isExportDeclaration(statement) && statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) {
      const specifier = statement.moduleSpecifier.text;
      edges.push({ kind: "export", specifier, target: resolveLocalModule(file, specifier) });
    }
  }
  return edges;
}

test("legacy framework analysis keeps a one-way dependency seam", async () => {
  const violations = new Set<string>();
  const legacyModule = "server/lib/legacyFrameworkAnalysis.ts";
  const routeModule = "server/mvpMcpRoutes.ts";

  for (const edge of await moduleEdges("server/lib/jobQueue.ts")) {
    if (edge.target === routeModule) violations.add("jobQueue imports the HTTP route module");
  }
  for (const edge of await moduleEdges("server/routes/fundamentals.ts")) {
    if (edge.target === routeModule) violations.add("fundamentals imports the HTTP route module");
  }

  if (!existsSync(path.join(workspaceRoot, legacyModule))) {
    violations.add("legacy analysis module is missing");
  } else {
    for (const edge of await moduleEdges(legacyModule)) {
      if (
        edge.specifier === "express"
        || edge.specifier === "better-sqlite3"
        || edge.target === routeModule
        || edge.target === "server/lib/jobQueue.ts"
        || edge.target === "server/db.ts"
        || edge.target?.startsWith("server/routes/")
      ) {
        violations.add(`legacy analysis has forbidden dependency: ${edge.specifier}`);
      }
    }
  }

  for (const edge of await moduleEdges(routeModule)) {
    if (edge.kind === "export" && edge.target === legacyModule) {
      violations.add("HTTP route module re-exports the analysis interface");
    }
  }

  assert.deepEqual([...violations].sort(), []);
});
```

Append `tests/legacy-framework-analysis-boundary.test.ts` to the `test` command in `package.json`, before `tests/test-suite-registration.test.ts`. Add `"legacy-framework-analysis-boundary.test.ts"` to the suite array in `tests/test-suite-registration.test.ts`.

- [ ] **Step 2: Run the focused test and verify the RED state**

Run:

```powershell
npx tsx --test tests/legacy-framework-analysis-boundary.test.ts
```

Expected: the test executes and fails its assertion with these architectural violations, rather than a syntax or loader error:

```text
fundamentals imports the HTTP route module
jobQueue imports the HTTP route module
legacy analysis module is missing
```

If it passes, the test does not describe the current cycle and must be corrected before any production file is moved.

- [ ] **Step 3: Create the analysis module by moving the existing implementation exactly once**

Create `server/lib/legacyFrameworkAnalysis.ts`. Use these imports, adjusted only for its location inside `server/lib`:

```ts
import { buildStockSnapshot, formatSnapshotForPrompt, type SnapshotRow, type StockSnapshot } from "./stockSnapshot";
import { validateEvidenceReport, type EvidenceSummary, type ReportClaim } from "./evidenceReport";
import { fetchWithOneRetry } from "./fetchRetry";
import { evaluateFrameworkEligibility, FRAMEWORK_CONTRACTS } from "./frameworkEligibility";
import { fetchCloudMeta, fetchCloudPrices, fetchCloudShareholding } from "./cloudMarketData";
import { createBoundedMemoryCache, finMindMemoryCache, type FinMindCacheResult } from "./finmindCache";
import { FINANCIAL_DATASETS, normalizeFinancialSnapshot, type NormalizedFinancialSnapshot } from "./financialNormalization";
import { generateNvidiaReport, hasNvidiaApiKey, nvidiaModel } from "./nvidiaAi";
import { fetchInstitutionalHoldingSnapshot, formatInstitutionalHoldingEvidence } from "./institutionalHoldings";
```

Move the current `server/mvpMcpRoutes.ts:18-502` definitions into the new module in their existing order and with their existing bodies unchanged:

```text
FINMIND and normalizedFinancialCache
DynamicSettings and getDynamicSettings
Taipei date helpers and FINMIND_DATASETS
FinMindResult, FinMindPayload, requestFinMind, waitForFinMindCache, fetchFinMind
AnalysisSnapshot and selectFinMindDatasetNames
fetchIdentity and normalizedFinancials
FundamentalDatasetResult and fetchFundamentalDataset
fetchAnalysisSnapshot and fetchFinancialSnapshot
FRAMEWORK_PROMPTS
FrameworkAnalysisResult and runFrameworkAnalysis
```

Keep `AnalysisSnapshot`, `FundamentalDatasetResult`, `FrameworkAnalysisResult`, `selectFinMindDatasetNames`, the three fetch functions, and `runFrameworkAnalysis` exported with their current signatures. Make `DynamicSettings` and `getDynamicSettings` module-private because no current consumer imports them.

Immediately after `FRAMEWORK_PROMPTS`, add the only new production function:

```ts
export function isLegacyFrameworkId(value: string): boolean {
  return Object.hasOwn(FRAMEWORK_PROMPTS, value);
}
```

This predicate must use the real prompt map so the accepted framework set remains byte-for-byte equivalent to the current `Object.keys(FRAMEWORK_PROMPTS)` behavior; do not export `FRAMEWORK_PROMPTS`.

- [ ] **Step 4: Reduce `mvpMcpRoutes.ts` to route coordination**

Replace its top imports with exactly the dependencies used by the retained handlers:

```ts
// MVP HTTP routes for the legacy test-mode analysis queue and TDCC operations.
import type { Request, Response } from "express";
import { startJob, getJob, listJobs, cancelJob, deleteJob, deleteAllJobs } from "./lib/jobQueue";
import { syncTdcc, getTdccSqliteStatus, getTdccUniverseStatus } from "./lib/tdccDownload";
import { resolveRuntimeMode } from "./lib/runtimeMode";
import { isOrdinaryStockId } from "./lib/stockUniverse";
import { hasNvidiaApiKey } from "./lib/nvidiaAi";
import { isLegacyFrameworkId } from "./lib/legacyFrameworkAnalysis";
```

Delete the moved definitions from this route file. Retain `rejectCloudLocalOperation` and every handler currently at `server/mvpMcpRoutes.ts:504-606` with existing response status, response body, queue and TDCC calls unchanged. In `jobBatchHandler`, replace only the prompt-map lookup:

```ts
const frameworks = requestedFrameworks.filter(isLegacyFrameworkId);
const finalFrameworks = frameworks.length ? frameworks : ["goldman"];
```

Remove `const validIds = Object.keys(FRAMEWORK_PROMPTS);`. Do not export or re-export anything from the analysis module through `mvpMcpRoutes.ts`.

- [ ] **Step 5: Point every consumer and existing assertion at the new owner**

In `server/lib/jobQueue.ts`, replace both route imports with one local library import:

```ts
import {
  fetchAnalysisSnapshot,
  runFrameworkAnalysis,
  type AnalysisSnapshot,
} from "./legacyFrameworkAnalysis";
```

In `server/routes/fundamentals.ts`, use:

```ts
import { fetchFinancialSnapshot, fetchFundamentalDataset } from "../lib/legacyFrameworkAnalysis";
```

In `tests/self-check.ts`, use:

```ts
import { selectFinMindDatasetNames } from "../server/lib/legacyFrameworkAnalysis";
```

Move the existing source-owner assertions without weakening them:

```ts
for (const runtimeFile of [
  "server/lib/finmindCache.ts",
  "server/lib/legacyFrameworkAnalysis.ts",
  "server/routes/fundamentals.ts",
]) {
  const source = readFileSync(path.join(process.cwd(), runtimeFile), "utf8");
  assert.equal(source.includes("stock_dataset_cache"), false, `${runtimeFile} must not access Supabase stock_dataset_cache`);
}

const legacyFrameworkAnalysisSource = readFileSync(
  path.join(process.cwd(), "server", "lib", "legacyFrameworkAnalysis.ts"),
  "utf8",
);
assert.match(legacyFrameworkAnalysisSource, /return token && failed \? request\(""\) : first/);
assert.doesNotMatch(legacyFrameworkAnalysisSource, /error: "missing_api_key"/);
```

Keep the existing `selectFinMindDatasetNames` assertions at `tests/self-check.ts:761-767` unchanged; only their import source changes. Do not modify `tests/cloud-admin-sqlite-boundary.test.ts`, because it correctly verifies the retained route handlers and their cloud guard.

- [ ] **Step 6: Run focused GREEN verification**

Run each command independently and record its actual exit code:

```powershell
npx tsx --test tests/legacy-framework-analysis-boundary.test.ts
npx tsx tests/self-check.ts
npx tsx --test tests/cloud-admin-sqlite-boundary.test.ts tests/test-suite-registration.test.ts
```

Expected:

- the new boundary test passes with no violations;
- self-check prints `self-check: ok`;
- cloud admin boundary and test registration suites exit `0`;
- there are no module-cycle initialization errors, TypeScript loader errors, or unhandled rejections.

If a check fails, fix production code for the reported mismatch; do not delete or relax the assertion.

- [ ] **Step 7: Review the task diff before broader verification**

Run read-only checks:

```powershell
git status --short
git diff -- server/mvpMcpRoutes.ts server/lib/jobQueue.ts server/routes/fundamentals.ts tests/self-check.ts tests/test-suite-registration.test.ts package.json
git diff --no-index -- NUL server/lib/legacyFrameworkAnalysis.ts
git diff --no-index -- NUL tests/legacy-framework-analysis-boundary.test.ts
```

The two `git diff --no-index` commands are expected to return exit `1` when they successfully display a new untracked file; that exit code is not an implementation failure. The global worktree status will also show pre-existing user-owned changes. Within the edits attributable to this task, scope must be exactly the files listed for Task 1 plus the ignored spec/plan documents. Confirm prompt strings and bodies of the moved fetch/analysis functions are unchanged. Do not clean, restore, stage, or commit any unrelated working-tree entry.

---

### Task 2: Run canonical verification and capture the remaining unverified boundary

**Files:**
- Verify only: all Task 1 files
- No new production files or behavior

**Interfaces:**
- Consumes: the one-way analysis seam completed in Task 1.
- Produces: executed local evidence for type safety, canonical tests, AI evaluation, and production bundling.

- [ ] **Step 1: Run TypeScript type checking**

Run:

```powershell
npm run typecheck
```

Expected: exit `0` with no TypeScript errors. A failure is fixed at the owner identified by the diagnostic; do not add broad casts or weaken `strict` settings.

- [ ] **Step 2: Run the canonical registered test suite**

Run:

```powershell
npm test
```

Expected: exit `0`, `self-check: ok`, the new `legacy framework analysis keeps a one-way dependency seam` test is present, and all registered tests pass. The exact pass count must be reported from the command output rather than assumed from the prior 221-test baseline.

- [ ] **Step 3: Run the canonical AI evaluation**

Run:

```powershell
npm run test:eval
```

Expected: exit `0` and the evaluation gate reports its actual success result. This remains local fixture/config validation and must not invoke production-data mutations.

- [ ] **Step 4: Build the production artifacts**

Run:

```powershell
npm run build
```

Expected: exit `0`; TypeScript, Vite client build, and esbuild server bundle all finish successfully. Do not run `npm run clean` before or after the build because the existing `dist` state is user-owned unless separately authorized.

- [ ] **Step 5: Perform final evidence review without Git mutation**

Run:

```powershell
git diff --check
git status --short
git diff --stat
```

Then inspect the complete targeted diffs and report:

- whether the circular import is absent in current source;
- every command actually executed, exit code, and observed result;
- any check not run as `未驗證`;
- that no cloud sync/backfill/delete/verification was run;
- that no stage, commit, push, reset, clean or unrelated-file modification was performed.

The Supabase blank-migration replay remains `未驗證` while Docker/Podman is unavailable; it is outside this module-seam completion verdict and must not be mislabeled as failed.

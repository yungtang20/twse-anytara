import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (file: string) => readFile(new URL(`../${file}`, import.meta.url), "utf8");

test("npm test registers every cloud SQLite boundary suite", async () => {
  const pkg = JSON.parse(await read("package.json")) as { scripts?: Record<string, string> };
  const command = pkg.scripts?.test ?? "";
  assert.match(command, /tests\/self-check\.ts/);
  for (const suite of [
    "market-stats-enrichment.test.ts",
    "cloud-retention-regression.test.ts",
    "daily-sync-dispatch.test.ts",
    "cloud-lifecycle-boundary.test.ts",
    "cloud-api-boundary.test.ts",
    "cloud-admin-sqlite-boundary.test.ts",
    "maintenance-sqlite-boundary.test.ts",
    "cloud-ai-ui-boundary.test.ts",
    "cloud-health-stats-boundary.test.ts",
    "ai-research-boundary.test.ts",
    "research-context.test.ts",
    "research-context-cloud-adapter.test.ts",
    "stock-strategy-research.test.ts",
    "ai-research-packet.test.ts",
    "ai-research-richness.test.ts",
    "ai-research-evidence.test.ts",
    "ai-research-auditor.test.ts",
    "ai-research-prompt-isolation.test.ts",
    "ai-research-structured-findings.test.ts",
    "ai-research-policy.test.ts",
    "ai-research-latest-blockers.test.ts",
    "ai-research-non-finite.test.ts",
    "ai-research-numeric-policy.test.ts",
    "ai-research-model-gateway.test.ts",
    "ai-research-router-adapter.test.ts",
    "ai-research-model-runner.test.ts",
    "ai-research-publication-gate.test.ts",
    "ai-research-orchestrator.test.ts",
    "ai-research-report-route.test.ts",
    "ai-research-report-ui.test.ts",
    "ai-research-investment-conclusion.test.ts",
    "ai-research-valuation.test.ts",
    "ai-research-recommendation-ui.test.ts",
    "tdcc-cloud-sync.test.ts",
    "legacy-framework-analysis-boundary.test.ts",
    "ai-provider-connection.test.ts",
    "public-endpoint.test.ts",
    "openai-compatible-transport.test.ts",
    "ai-abuse-guard.test.ts",
    "maintenance-execution-guard.test.ts",
    "supabase-blank-replay.test.ts",
    "production-runtime.test.ts",
  ]) {
    assert.match(command, new RegExp(`tests/${suite.replaceAll(".", "\\.")}`));
  }
});

test("CI explicitly runs typecheck and the registered npm test suite", async () => {
  const pkg = JSON.parse(await read("package.json")) as { scripts?: Record<string, string> };
  assert.equal(pkg.scripts?.lint, "eslint . --max-warnings=0");
  assert.equal(pkg.scripts?.["test:ui"], "vitest run");
  const workflow = await read(".github/workflows/ci.yml");
  assert.match(workflow, /run:\s*npm run typecheck/);
  assert.match(workflow, /run:\s*npm run lint/);
  assert.match(workflow, /run:\s*npm test/);
  assert.match(workflow, /run:\s*npm run test:ui/);
  assert.match(workflow, /supabase-blank-replay:/);
  assert.match(workflow, /supabase@2\.114\.0 db reset/);
  assert.match(workflow, /verify:supabase-security -- --local/);
});

test("README documents only cloud and test data modes", async () => {
  const readme = await read("README.md");
  assert.doesNotMatch(readme, /MARKET_DATA_MODE=local/);
  assert.doesNotMatch(readme, /SQLite（獨立本機模式）/);
  assert.match(readme, /MARKET_DATA_MODE=test/);
});

test("cloud API probe shuts down through finally without forced process exit", async () => {
  const probe = await read("tests/helpers/cloud-api-probe.ts");
  assert.doesNotMatch(probe, /process\.exit\s*\(/);
  assert.match(probe, /finally\s*{/);
  assert.match(probe, /instance\.close/);
});

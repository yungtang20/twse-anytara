import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const projectRoot = path.resolve(import.meta.dirname, "..");
const read = (relativePath: string): string =>
  fs.readFileSync(path.join(projectRoot, relativePath), "utf8");

function collectSourceFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return collectSourceFiles(fullPath);
    return /\.(?:ts|tsx)$/.test(entry.name) ? [fullPath] : [];
  });
}

const app = read("src/App.tsx");
const navigation = read("src/lib/navigation.ts");
const researchView = read("src/components/views/AIResearchView.tsx");
const productionSource = collectSourceFiles(path.join(projectRoot, "src"))
  .map((file) => fs.readFileSync(file, "utf8"))
  .join("\n");
const serverGuard = read("server/routes/analysisTdcc.ts");

assert.match(app, /AIResearchView/, "App must render the replacement AI research page");
assert.match(navigation, /ai-analysis/, "the existing #/ai-analysis navigation contract must remain valid");
assert.match(researchView, /AI 綜合研究/);
assert.match(researchView, /runAIResearch/);
assert.match(researchView, /機械驗證預覽/);

assert.doesNotMatch(productionSource, /LegacyAIAnalysisView/);
assert.doesNotMatch(
  productionSource,
  /\/api\/jobs?(?:\/|\b)|\/api\/job\/batch/,
  "production frontend must not retain legacy job fetches",
);
assert.doesNotMatch(researchView, /setInterval|poll|deleteHistory|clearAllHistory|startRun/i,
  "AI research view must not poll or expose legacy job controls");
assert.doesNotMatch(researchView, /啟動分析|刪除紀錄|重試分析/);
assert.doesNotMatch(researchView, /正式報告|已驗證/);

for (const prefix of ["/api/ai-analysis", "/api/analysis-mvp", "/api/job", "/api/jobs"]) {
  assert.ok(serverGuard.includes(JSON.stringify(prefix)), `cloud server guard must retain ${prefix}`);
}
assert.match(serverGuard, /status\(410\)/, "legacy AI routes must remain disabled in cloud mode");

console.log("cloud AI UI boundary contract passed");

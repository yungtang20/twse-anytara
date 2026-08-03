import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const read = (relativePath: string) => readFile(path.join(root, relativePath), "utf8");

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(fullPath);
    return /\.(?:ts|tsx)$/.test(entry.name) ? [fullPath] : [];
  }));
  return nested.flat();
}

test("navigation says AI 綜合研究 while preserving #/ai-analysis", async () => {
  const [sidebar, bottomNav, navigation] = await Promise.all([
    read("src/components/Sidebar.tsx"),
    read("src/components/BottomNav.tsx"),
    read("src/lib/navigation.ts"),
  ]);
  assert.match(sidebar, /AI 綜合研究/);
  assert.match(bottomNav, /AI 綜合研究/);
  assert.match(navigation, /ai-analysis/);
});

test("production frontend contains AIResearchView and no legacy job workflow", async () => {
  const app = await read("src/App.tsx");
  const researchView = await read("src/components/views/AIResearchView.tsx");
  const files = await sourceFiles(path.join(root, "src"));
  const productionSource = (await Promise.all(files.map((file) => readFile(file, "utf8")))).join("\n");

  assert.match(app, /AIResearchView/);
  assert.match(researchView, /機械驗證預覽/);
  assert.doesNotMatch(productionSource, /LegacyAIAnalysisView/);
  assert.doesNotMatch(productionSource, /\/api\/jobs?(?:\/|\b)|\/api\/job\/batch/);
  assert.doesNotMatch(researchView, /setInterval|poll|deleteHistory|clearAllHistory|startRun/i);
  assert.doesNotMatch(researchView, /啟動分析|刪除紀錄|重試分析/);
});

test("research context production modules exclude SQLite, paid AI, real keys, and sample fallback", async () => {
  const source = [
    await read("shared/researchContext.ts"),
    await read("server/lib/researchContext.ts"),
    await read("server/lib/researchContextCloudAdapter.ts"),
    await read("server/lib/stockStrategyResearch.ts"),
    await read("server/routes/aiResearch.ts"),
  ].join("\n");

  assert.doesNotMatch(source, /better-sqlite3|from\s+["'][^"']*(?:\/db|jobQueue)["']|initDb|getDb|SQLITE_DB_PATH|TRADE_RISK_SQLITE_PATH/);
  assert.doesNotMatch(source, /api\.nvidia\.com|generativelanguage|api\.openai\.com|NVIDIA_API_KEY|OPENAI_API_KEY/i);
  assert.doesNotMatch(source, /sample(?:Context|Research)|mock(?:Context|Research)|fake(?:Context|Research)/i);
  assert.doesNotMatch(source, /value\s*\|\|\s*null/);
});

test("context route returns the exact fail-closed 503 payload", async () => {
  const routes = await import("../server/routes/aiResearch.js") as {
    createAiResearchContextHandler: (aggregator: { aggregate(stockId: string): Promise<unknown> }) =>
      (request: { params: { stockId: string } }, response: {
        status(code: number): unknown;
        json(body: unknown): unknown;
      }) => Promise<void>;
  };
  let statusCode = 200;
  let body: unknown;
  const response = {
    status(code: number) { statusCode = code; return response; },
    json(value: unknown) { body = value; return response; },
  };
  const handler = routes.createAiResearchContextHandler({
    async aggregate() { throw new Error("research_context_unavailable"); },
  });

  await handler({ params: { stockId: "2330" } }, response);
  assert.equal(statusCode, 503);
  assert.deepEqual(body, { success: false, error: "research_context_unavailable" });
});

test("context route distinguishes invalid IDs, ineligible stocks, and unavailable cloud data", async () => {
  const routes = await import("../server/routes/aiResearch.js") as {
    createAiResearchContextHandler: (aggregator: { aggregate(stockId: string): Promise<unknown> }) =>
      (request: { params: { stockId: string } }, response: {
        status(code: number): unknown;
        json(body: unknown): unknown;
      }) => Promise<void>;
  };
  const invoke = async (stockId: string, error: string) => {
    let statusCode = 200;
    let body: unknown;
    const response = {
      status(code: number) { statusCode = code; return response; },
      json(value: unknown) { body = value; return response; },
    };
    const handler = routes.createAiResearchContextHandler({ async aggregate() { throw new Error(error); } });
    await handler({ params: { stockId } }, response);
    return { statusCode, body };
  };

  assert.deepEqual(await invoke("abc", "must not run"), {
    statusCode: 400,
    body: { success: false, error: "invalid_stock_id" },
  });
  assert.deepEqual(await invoke("0050", "stock_not_eligible_for_research"), {
    statusCode: 422,
    body: { success: false, error: "stock_not_eligible_for_research" },
  });
  assert.deepEqual(await invoke("2330", "research_context_unavailable"), {
    statusCode: 503,
    body: { success: false, error: "research_context_unavailable" },
  });
});

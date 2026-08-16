import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const read = (file: string) => readFile(path.join(root, file), "utf8");

test("frontend client exposes one abortable POST report request and fixed errors", async () => {
  const source = await read("src/lib/api.ts");
  const reportFunction = source.slice(source.indexOf("export async function runAIResearch"),
    source.indexOf("export async function", source.indexOf("export async function runAIResearch") + 1));
  assert.match(reportFunction, /method:\s*["']POST["']/);
  assert.match(reportFunction, /\/api\/ai-research\/stocks\/\$\{encodeURIComponent\(stockId\)\}\/report/);
  assert.match(reportFunction, /signal/);
  assert.equal((reportFunction.match(/\bfetch\s*\(/g) ?? []).length, 1);
  assert.doesNotMatch(reportFunction, /\/api\/(?:job|jobs|analysis-mvp|ai-analysis)/);
});

test("frontend client performs one request, preserves server errors, and propagates abort", async () => {
  const api = await import("../src/lib/api.js");
  const originalFetch = globalThis.fetch;
  const successPayload = { success: true, publicationReady: false, semanticGrounding: "unverified",
    publishedReport: null, draft: null, auditSummary: {}, providerMetadata: [], recommendation: null, valuation: null };
  try {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (input, init) => {
      calls.push({ url: String(input), init });
      return new Response(JSON.stringify(successPayload), { status: 200 });
    }) as typeof fetch;
    await api.runAIResearch("2330");
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /\/api\/ai-research\/stocks\/2330\/report$/);
    assert.equal(calls[0].init?.method, "POST");

    globalThis.fetch = (async () => new Response(JSON.stringify({ success: false,
      error: "ai_research_provider_unavailable" }), { status: 503 })) as typeof fetch;
    await assert.rejects(() => api.runAIResearch("2330"), /ai_research_provider_unavailable/);

    const controller = new AbortController();
    globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () =>
        reject(new DOMException("aborted", "AbortError")), { once: true }))) as typeof fetch;
    const pending = api.runAIResearch("2330", controller.signal);
    controller.abort();
    await assert.rejects(() => pending, (error: unknown) => error instanceof DOMException && error.name === "AbortError");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("AIResearchView renders a formal report only when publication gate is ready", async () => {
  const [view, presentation] = await Promise.all([
    read("src/components/views/AIResearchView.tsx"),
    read("src/lib/aiResearchPresentation.ts"),
  ]);
  for (const text of ["股票代號", "產生 AI 綜合研究", "執行中", "取消", "資料完整度",
    "AI 服務資訊", "機械驗證預覽", "正式研究報告", "資料限制", "資料來源與佐證", "查看技術詳細資料",
    "此內容為 AI 機械驗證預覽，尚未完成語意發布驗證，不構成投資建議。"] ) {
    assert.match(view, new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), text);
  }
  for (const text of ["撐壓分析", "均線趨勢", "籌碼動能", "型態偵測"]) {
    assert.match(presentation, new RegExp(text), text);
  }
  assert.match(view, /runAIResearch/);
  assert.match(view, /AbortController/);
  assert.match(view, /report\.publicationReady\s*\?\s*<PublishedReportPanel[^:]+:\s*<PreviewPanel/s);
  assert.match(view, /report\.publicationReady\s*&&\s*!report\.publishedReport/);
  assert.match(view, /研究報告契約錯誤/);
  assert.doesNotMatch(view, /title="Data quality"|title="Provider \/ Model"|title="Citations \/ 來源識別"/);
  assert.match(view, /<details/);
  assert.match(view, /<summary/);
  assert.match(view, /groundingLabel\(published\.semanticGrounding\)/);
  assert.match(view, /模型選擇的有界假設/);
  assert.match(view, /strategyLabel\(id\)/);
  assert.match(view, /signalLabel\(strategy\.signal\)/);
  assert.match(view, /scenarioLabel\(scenario\.name\)/);
  assert.match(view, /researchErrorLabel\(code\)/);
  assert.doesNotMatch(view, /fetchResearchContext|\/api\/job|\/api\/jobs|\/api\/analysis-mvp|\/api\/ai-analysis|setInterval|poll/i);
  assert.doesNotMatch(view, /candidate|untrustedEvidence|ResearchPacket/);
  assert.match(presentation, /ai_research_model_output_invalid:\s*"AI 模型回傳內容未通過研究契約驗證"/);
  assert.match(presentation, /ai_research_provider_timeout:\s*"AI 研究供應商回應逾時，請稍後再試"/);
  assert.match(presentation, /ai_research_provider_response_invalid:\s*"AI 研究供應商回傳格式無效"/);
  assert.match(presentation, /ai_research_provider_rate_limited:\s*"AI 研究供應商請求過於頻繁，請稍後再試"/);
  assert.match(presentation, /ai_research_provider_rejected:\s*"AI 研究供應商拒絕請求，請檢查金鑰或權限"/);
  assert.match(presentation, /ai_research_provider_server_error:\s*"AI 研究供應商服務異常，請稍後再試"/);
});

test("report presenter route and production factory remain isolated", async () => {
  const [route, presenter, factory, runner] = await Promise.all([
    read("server/routes/aiResearch.ts"),
    read("server/lib/aiResearchReportPresenter.ts"),
    read("server/lib/aiResearchProduction.ts"),
    read("server/lib/aiResearchModelRunner.ts"),
  ]);
  assert.doesNotMatch(route, /isLoopbackRequest|requireAdminRequest|authorizeAdminRequest/);
  assert.match(route, /resolveAIProviderConnection/);
  assert.match(route, /createAIAbuseGuard/);
  assert.match(route, /presentAIResearchReport/);
  assert.doesNotMatch(route, /buildResearchPacket|buildAIResearchModelRequest|auditResearchReport|createCloudResearchContextAdapter|Supabase|SQLite/i);
  assert.match(factory, /ResearchContextAggregator/);
  assert.match(factory, /createCloudResearchContextAdapter/);
  assert.match(factory, /createAIResearchRouterModelRunner/);
  assert.match(factory, /createAIResearchRouterModelRunner\(clock\)/);
  assert.match(runner, /gateResearchPublication/);
  assert.match(factory, /AIResearchOrchestrator/);
  assert.doesNotMatch(`${presenter}\n${route}`, /apiKey|rawPrompt|untrustedEvidence|providerResponse|stack/i);
  assert.match(presenter, /publication_contract_invariant/);
  assert.match(presenter, /if \(formal[^]*recommendation:\s*null,\s*valuation:\s*null/);
});

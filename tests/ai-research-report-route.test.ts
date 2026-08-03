import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { createAIResearchReportHandler } from "../server/routes/aiResearch.js";
import type { AIResearchRunResult } from "../server/lib/aiResearchOrchestrator.js";
import { AIResearchOrchestrator } from "../server/lib/aiResearchOrchestrator.js";
import { AIResearchModelRunner } from "../server/lib/aiResearchModelRunner.js";
import { AIResearchModelGatewayError, InMemoryAIResearchModelGateway } from "../server/lib/aiResearchModelGateway.js";
import { auditResearchReport } from "../server/lib/aiResearchReportAuditor.js";
import { buildResearchPacket } from "../server/lib/aiResearchPacket.js";
import { ResearchContextAggregator } from "../server/lib/researchContext.js";
import { createResearchContextAdapter } from "./helpers/research-context-fixtures.js";

class FakeRequest extends EventEmitter {
  params: { stockId: string };
  socket: { remoteAddress: string };

  constructor(stockId: string, address = "127.0.0.1") {
    super();
    this.params = { stockId };
    this.socket = { remoteAddress: address };
  }
}

function fakeResponse() {
  let status = 200;
  let body: unknown;
  const response = {
    status(code: number) { status = code; return response; },
    json(value: unknown) { body = value; return response; },
  };
  return { response, snapshot: () => ({ status, body }) };
}

const failure = (error: Extract<AIResearchRunResult, { success: false }>["error"]): AIResearchRunResult => ({
  success: false, error, publicationReady: false, publishedReport: null,
});

function successResult(): AIResearchRunResult {
  return {
    success: true, publicationReady: false, semanticGrounding: "unverified", publishedReport: null,
    draft: { status: "mechanical-preview-only", claims: [{ id: "market", kind: "market_snapshot",
      stance: "neutral", text: "收盤資料為 100 元", evidenceIds: ["ev:price"], limitations: [], estimated: false }],
      conclusion: "結論狀態：中性候選。" },
    audit: { mechanicalPassed: true, publicationReady: false, semanticGrounding: "unverified",
      citationCoverage: 1, invalidCitationIds: [], unsupportedFindingIds: [], prohibitedClaims: [],
      errors: [], warnings: [], draft: null, publishedReport: null },
    providerMetadata: [{ provider: "fake", model: "fake-model", durationMs: 8,
      usage: { inputTokens: null, outputTokens: null } }],
    reportContext: {
      dataQuality: { informationRichness: "B", status: "partial", missingDatasets: ["financials"],
        staleDatasets: [], warnings: [] },
      strategies: {
        sr: { status: "ok", date: "2026-07-31", signal: "HOLD" },
        ma: { status: "ok", date: "2026-07-31", signal: "HOLD" },
        chips: { status: "ok", date: "2026-07-31", signal: "HOLD" },
        pattern: { status: "ok", date: "2026-07-31", signal: "HOLD" },
      },
      sources: [{ id: "supabase:stock_price", dataset: "stock_price", provider: "supabase",
        asOf: "2026-07-31", estimated: false }],
    },
  } as AIResearchRunResult;
}

async function invoke(stockId: string, result: AIResearchRunResult, address = "127.0.0.1") {
  let calls = 0;
  const orchestrator = { async research(): Promise<AIResearchRunResult> { calls += 1; return result; } };
  const handler = createAIResearchReportHandler(orchestrator);
  const request = new FakeRequest(stockId, address);
  const response = fakeResponse();
  await handler(request as never, response.response);
  return { ...response.snapshot(), calls };
}

async function invokeHandler(
  handler: ReturnType<typeof createAIResearchReportHandler>,
  stockId: string,
  address = "127.0.0.1",
) {
  const request = new FakeRequest(stockId, address);
  const response = fakeResponse();
  await handler(request as never, response.response);
  return response.snapshot();
}

async function controlledContext() {
  return new ResearchContextAggregator(createResearchContextAdapter(), {
    clock: () => new Date("2026-08-02T03:04:05.000Z"), asOfDate: "2026-07-31",
  }).aggregate("2330");
}

async function controlledCandidate() {
  const packet = buildResearchPacket(await controlledContext());
  const price = packet.evidence.find((item) => item.field === "market.price");
  const date = packet.evidence.find((item) => item.field === "market.latestDate");
  assert.ok(price && date);
  return { schemaVersion: 1, stockId: packet.stockId, asOf: packet.asOf,
    contextFingerprint: packet.contextFingerprint, dataQuality: packet.dataQuality,
    findings: [{ id: "market", kind: "market_snapshot", stance: "neutral", fragments: [
      { evidenceId: price.id, role: "value", format: "value_with_unit" },
      { evidenceId: date.id, role: "date", format: "date" },
    ] }], conclusion: { verdict: "neutral", supportingFindingIds: [], opposingFindingIds: [],
      limitationFindingIds: [], aiConfidence: null, investmentCertainty: null }, citations: [price.id, date.id] };
}

test("report route rejects non-loopback and invalid IDs before orchestrator", async () => {
  assert.deepEqual(await invoke("2330", successResult(), "203.0.113.8"), {
    status: 403, body: { success: false, error: "ai_research_loopback_required" }, calls: 0,
  });
  assert.deepEqual(await invoke("bad-id", successResult()), {
    status: 400, body: { success: false, error: "invalid_stock_id" }, calls: 0,
  });
});

test("report route maps every orchestrator failure to fixed HTTP errors", async () => {
  for (const [error, status] of [
    ["ai_research_stock_not_eligible", 422],
    ["ai_research_context_unavailable", 503],
    ["ai_research_insufficient_data", 422],
    ["ai_research_provider_unavailable", 503],
    ["ai_research_provider_rate_limited", 429],
    ["ai_research_provider_rejected", 502],
    ["ai_research_provider_server_error", 502],
    ["ai_research_provider_timeout", 504],
    ["ai_research_provider_response_invalid", 502],
    ["ai_research_model_output_invalid", 502],
    ["ai_research_contract_error", 500],
  ] as const) {
    const result = await invoke(error === "ai_research_stock_not_eligible" ? "0050" : "2330", failure(error));
    assert.deepEqual(result, { status, body: { success: false, error }, calls: 1 }, error);
  }
});

test("model-output-invalid route keeps internal diagnostics out of the fixed HTTP error", async () => {
  const auditDiagnostics = {
    reasonCodes: ["invalid_report_field", "unsupported_finding"],
    invalidCitationCount: 2, unsupportedFindingCount: 1, prohibitedClaimCount: 0,
  };
  const diagnosed = { ...failure("ai_research_model_output_invalid"), auditDiagnostics } as AIResearchRunResult;
  const result = await invoke("2330", diagnosed);
  assert.deepEqual(result, {
    status: 502,
    body: { success: false, error: "ai_research_model_output_invalid" },
    calls: 1,
  });
  assert.doesNotMatch(JSON.stringify(result.body), /candidate|prompt|evidence|reasoning|api.?key|raw/i);
});

test("report route timeout exceeds the provider timeout while preserving injected scheduling", async () => {
  let delay = 0;
  const handler = createAIResearchReportHandler({ async research() { return successResult(); } }, {
    scheduleTimeout: (_callback, timeoutMs) => { delay = timeoutMs; return 1; },
    clearScheduledTimeout: () => {},
  });
  const result = await invokeHandler(handler, "2330");
  assert.equal(result.status, 200);
  assert.equal(delay, 315_000);
  assert.ok(delay > 300_000);
});

test("successful report response is a strict UI allowlist", async () => {
  const unsafe = { ...successResult(), apiKey: "secret", rawPrompt: "prompt",
    candidate: { raw: true }, untrustedEvidence: { secret: true }, packet: { evidence: [] } } as unknown as AIResearchRunResult;
  const result = await invoke("2330", unsafe);
  assert.equal(result.status, 200);
  const body = result.body as Record<string, unknown>;
  assert.deepEqual(Object.keys(body).sort(), ["auditSummary", "draft", "providerMetadata", "publicationReady",
    "publishedReport", "recommendation", "semanticGrounding", "success", "valuation"].sort());
  assert.deepEqual(Object.keys(body.auditSummary as object).sort(), ["citationCoverage", "citations", "dataQuality",
    "limitations", "mechanicalPassed", "sources", "strategies", "warnings"].sort());
  assert.doesNotMatch(JSON.stringify(body), /secret|rawPrompt|candidate|untrustedEvidence|packet|apiKey/i);
  assert.equal(body.publicationReady, false);
  assert.equal(body.publishedReport, null);
});

test("route exposes the formal report only after server-grounded publication", async () => {
  const base = successResult();
  if (!base.success) throw new Error("fixture_failure");
  const claim = base.draft!.claims[0];
  const recommendation = { verdict: "HOLD" as const, label: "持有" as const, horizonMonths: 12 as const,
    confidence: 0.5, supportingFindingIds: [claim.id], opposingFindingIds: [], riskFindingIds: [],
    confidenceGrounding: "model-estimate-unverified" as const };
  const valuation = { method: "PE" as const, asOf: "2026-07-31", currentPrice: 100,
    metric: { name: "EPS" as const, value: 10, period: "2025-12-31", sourceId: "finmind:financials", estimated: false },
    scenarios: [{ name: "conservative" as const, multiple: 8, targetPrice: 80, expectedReturnRatio: -0.2, expectedReturnPercent: -20 },
      { name: "base" as const, multiple: 10, targetPrice: 100, expectedReturnRatio: 0, expectedReturnPercent: 0 },
      { name: "optimistic" as const, multiple: 12, targetPrice: 120, expectedReturnRatio: 0.2, expectedReturnPercent: 20 }],
    assumptionGrounding: "model-selected-bounded-assumptions" as const };
  const formal = { ...base, publicationReady: true as const, semanticGrounding: "server-grounded" as const,
    draft: null, publishedReport: { status: "formally-published" as const,
      generatedAt: "2026-08-02T04:05:06.000Z", semanticGrounding: "server-grounded" as const,
      claims: [claim], conclusion: "伺服器落地結論",
      conclusionFindingIds: { supporting: [claim.id], opposing: [], limitations: [] }, recommendation, valuation,
      grounding: { facts: "server-grounded" as const, calculations: "server-calculated" as const,
        valuationMultiples: "model-selected-bounded-assumptions" as const,
        recommendationConfidence: "model-estimate-unverified" as const } },
    audit: { ...base.audit, publicationReady: true, semanticGrounding: "server-grounded" as const,
      draft: null, publishedReport: null }, apiKey: "must-not-leak", rawCandidate: { secret: true } } as unknown as AIResearchRunResult;
  const result = await invoke("2330", formal);
  assert.equal(result.status, 200);
  const body = result.body as Record<string, unknown>;
  assert.equal(body.publicationReady, true);
  assert.equal(body.semanticGrounding, "server-grounded");
  assert.equal((body.publishedReport as { generatedAt: string }).generatedAt, "2026-08-02T04:05:06.000Z");
  assert.equal(body.draft, null);
  assert.equal(body.recommendation, null);
  assert.equal(body.valuation, null);
  assert.doesNotMatch(JSON.stringify(body), /must-not-leak|rawCandidate|apiKey/i);
});

test("presenter fails closed when publication readiness and formal report disagree", async () => {
  const inconsistent = { ...successResult(), publicationReady: true,
    semanticGrounding: "server-grounded", publishedReport: null } as unknown as AIResearchRunResult;
  assert.deepEqual(await invoke("2330", inconsistent), { status: 500,
    body: { success: false, error: "ai_research_contract_error" }, calls: 1 });
});

test("request abort propagates the signal and never becomes provider success", async () => {
  const request = new FakeRequest("2330");
  const response = fakeResponse();
  let receivedSignal: AbortSignal | undefined;
  const orchestrator = { research(_stockId: string, options?: { signal?: AbortSignal }) {
    receivedSignal = options?.signal;
    queueMicrotask(() => request.emit("aborted"));
    return new Promise<AIResearchRunResult>((resolve) => receivedSignal?.addEventListener("abort", () =>
      resolve(failure("ai_research_aborted")), { once: true }));
  } };
  await createAIResearchReportHandler(orchestrator)(request as never, response.response);
  assert.equal(receivedSignal?.aborted, true);
  assert.deepEqual(response.snapshot(), { status: 499,
    body: { success: false, error: "ai_research_aborted" } });
});

test("route timeout aborts the orchestrator and returns 504", async () => {
  const request = new FakeRequest("2330");
  const response = fakeResponse();
  let receivedSignal: AbortSignal | undefined;
  const orchestrator = { research(_stockId: string, options?: { signal?: AbortSignal }) {
    receivedSignal = options?.signal;
    return new Promise<AIResearchRunResult>(() => {});
  } };
  const handler = createAIResearchReportHandler(orchestrator, {
    timeoutMs: 1,
    scheduleTimeout(callback) { queueMicrotask(callback); return 1; },
    clearScheduledTimeout() {},
  });
  await handler(request as never, response.response);
  assert.equal(receivedSignal?.aborted, true);
  assert.deepEqual(response.snapshot(), { status: 504,
    body: { success: false, error: "ai_research_timeout" } });
});

test("controlled smoke uses only fake gateways for success eligibility security and provider failure", async () => {
  const context = await controlledContext();
  const primary = new InMemoryAIResearchModelGateway([{ candidate: await controlledCandidate(), provider: "fake",
    model: "controlled", durationMs: 1, usage: { inputTokens: null, outputTokens: null } }]);
  const contexts = { async aggregate(stockId: string) {
    if (stockId === "0050") throw new Error("stock_not_eligible_for_research");
    return context;
  } };
  const handler = createAIResearchReportHandler(new AIResearchOrchestrator(contexts,
    new AIResearchModelRunner(primary, auditResearchReport)));
  const success = await invokeHandler(handler, "2330");
  assert.equal(success.status, 200);
  assert.equal((success.body as { draft?: { status?: string } }).draft?.status, "mechanical-preview-only");
  assert.deepEqual(await invokeHandler(handler, "0050"), { status: 422,
    body: { success: false, error: "ai_research_stock_not_eligible" } });
  assert.deepEqual(await invokeHandler(handler, "bad-id"), { status: 400,
    body: { success: false, error: "invalid_stock_id" } });
  assert.deepEqual(await invokeHandler(handler, "2330", "203.0.113.8"), { status: 403,
    body: { success: false, error: "ai_research_loopback_required" } });
  assert.equal(primary.calls.length, 1);

  const failedPrimary = new InMemoryAIResearchModelGateway([new AIResearchModelGatewayError("network")]);
  const failedHandler = createAIResearchReportHandler(new AIResearchOrchestrator(contexts,
    new AIResearchModelRunner(failedPrimary, auditResearchReport)));
  assert.deepEqual(await invokeHandler(failedHandler, "2330"), { status: 503,
    body: { success: false, error: "ai_research_provider_unavailable" } });
  assert.equal(failedPrimary.calls.length, 1);
});

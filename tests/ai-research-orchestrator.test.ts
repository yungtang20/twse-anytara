import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { AIResearchModelRunner } from "../server/lib/aiResearchModelRunner.js";
import { InMemoryAIResearchModelGateway } from "../server/lib/aiResearchModelGateway.js";
import { AIResearchOrchestrator } from "../server/lib/aiResearchOrchestrator.js";
import { auditResearchReport } from "../server/lib/aiResearchReportAuditor.js";
import { ResearchContextAggregator } from "../server/lib/researchContext.js";
import type { AIResearchPacket } from "../shared/aiResearch.js";
import { buildResearchPacket } from "../server/lib/aiResearchPacket.js";
import { createResearchContextAdapter } from "./helpers/research-context-fixtures.js";

async function validCandidate(): Promise<unknown> {
  const context = await new ResearchContextAggregator(createResearchContextAdapter(), {
    clock: () => new Date("2026-08-02T03:04:05.000Z"), asOfDate: "2026-07-31",
  }).aggregate("2330");
  const packet: AIResearchPacket = buildResearchPacket(context);
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

test("orchestrator executes context to unpublished audit through its small interface", async () => {
  const aggregator = new ResearchContextAggregator(createResearchContextAdapter(), {
    clock: () => new Date("2026-08-02T03:04:05.000Z"), asOfDate: "2026-07-31",
  });
  const primary = new InMemoryAIResearchModelGateway([{ candidate: await validCandidate(), provider: "fake",
    model: "deterministic", durationMs: 5, usage: { inputTokens: null, outputTokens: null } }]);
  const result = await new AIResearchOrchestrator(aggregator,
    new AIResearchModelRunner(primary, auditResearchReport)).research("2330");
  assert.equal(result.success, true);
  assert.equal(result.publicationReady, false);
  assert.equal(result.semanticGrounding, "unverified");
  assert.equal(result.publishedReport, null);
  assert.equal(result.draft?.status, "mechanical-preview-only");
  assert.equal(primary.calls.length, 1);
  assert.equal(Object.hasOwn(result, "candidate"), false);
  assert.equal(Object.hasOwn(result, "request"), false);
});

test("Richness C returns insufficient data with zero provider calls", async () => {
  const adapter = createResearchContextAdapter();
  adapter.readMarket = async () => ({ data: { latestDate: "2026-07-31", price: null,
    history: [{ date: "2026-07-31", close: null, volume: 1 }] },
    source: { id: "supabase:stock_price", dataset: "stock_price", provider: "supabase",
      asOf: "2026-07-31", retrievedAt: "2026-08-02T03:04:05.000Z", rowCount: 1,
      estimated: false, status: "available", error: null } });
  const primary = new InMemoryAIResearchModelGateway([]);
  const orchestrator = new AIResearchOrchestrator(new ResearchContextAggregator(adapter, {
    clock: () => new Date("2026-08-02T03:04:05.000Z"), asOfDate: "2026-07-31",
  }), new AIResearchModelRunner(primary, auditResearchReport));
  const result = await orchestrator.research("2330");
  assert.deepEqual(result, { success: false, error: "ai_research_insufficient_data",
    publicationReady: false, publishedReport: null });
  assert.equal(primary.calls.length, 0);
});

test("internal diagnostic seam preserves only sanitized reasons and provider metadata", async () => {
  const aggregator = new ResearchContextAggregator(createResearchContextAdapter(), {
    clock: () => new Date("2026-08-02T03:04:05.000Z"), asOfDate: "2026-07-31",
  });
  const primary = new InMemoryAIResearchModelGateway([{
    candidate: { secretCandidateShape: "must-not-leak" }, provider: "router", model: "glm-5.2",
    durationMs: 8, usage: { inputTokens: 3, outputTokens: 2 },
  }]);
  const result = await new AIResearchOrchestrator(aggregator,
    new AIResearchModelRunner(primary, auditResearchReport)).research("2330");
  assert.equal(result.success, false);
  if (result.success) throw new Error("fixture_failure");
  assert.ok(result.auditDiagnostics?.reasonCodes.includes("invalid_report_field"));
  assert.deepEqual(result.providerMetadata, [{ provider: "router", model: "glm-5.2", durationMs: 8,
    usage: { inputTokens: 3, outputTokens: 2 } }]);
  assert.doesNotMatch(JSON.stringify(result), /must-not-leak|secretCandidateShape/);
});

test("context failures preserve eligibility availability and contract error semantics", async () => {
  for (const [contextError, expected] of [
    ["stock_not_eligible_for_research", "ai_research_stock_not_eligible"],
    ["research_context_unavailable", "ai_research_context_unavailable"],
    ["unexpected_internal_error", "ai_research_contract_error"],
  ] as const) {
    const primary = new InMemoryAIResearchModelGateway([]);
    const contexts = { async aggregate(): Promise<never> { throw new Error(contextError); } };
    const result = await new AIResearchOrchestrator(contexts,
      new AIResearchModelRunner(primary, auditResearchReport)).research("2330");
    assert.deepEqual(result, { success: false, error: expected,
      publicationReady: false, publishedReport: null }, contextError);
    assert.equal(primary.calls.length, 0, contextError);
  }
});

test("pre-aborted research returns aborted before context or provider calls", async () => {
  let contextCalls = 0;
  const contexts = { async aggregate(): Promise<never> {
    contextCalls += 1;
    throw new Error("must_not_run");
  } };
  const primary = new InMemoryAIResearchModelGateway([]);
  const controller = new AbortController();
  controller.abort();
  const result = await new AIResearchOrchestrator(contexts,
    new AIResearchModelRunner(primary, auditResearchReport))
    .research("2330", { signal: controller.signal });
  assert.deepEqual(result, { success: false, error: "ai_research_aborted",
    publicationReady: false, publishedReport: null });
  assert.equal(contextCalls, 0);
  assert.equal(primary.calls.length, 0);
});

test("slice three static isolation has no route persistence SQLite Supabase or production-ready publication", async () => {
  const root = path.resolve(import.meta.dirname, "..");
  const names = (await readdir(path.join(root, "server/lib")))
    .filter((name) => /^aiResearch(?:ModelGateway|RouterAdapter|ModelRunner|Orchestrator)\.ts$/.test(name));
  const sources = await Promise.all(names.map((name) => readFile(path.join(root, "server/lib", name), "utf8")));
  const source = sources.join("\n");
  const orchestrator = await readFile(path.join(root, "server/lib/aiResearchOrchestrator.ts"), "utf8");
  assert.doesNotMatch(orchestrator, /better-sqlite3|SQLite|Supabase|createClient|\.from\s*\(/i);
  assert.doesNotMatch(source, /publicationReady\s*:\s*true/);
  assert.doesNotMatch(source, /runFrameworkAnalysis|jobQueue|migration|persist|insert\s*\(|update\s*\(/i);
  assert.equal(names.length, 4);
  const diagnostic = await readFile(path.join(root, "scripts/diagnoseAIResearch.ts"), "utf8");
  assert.match(diagnostic, /process\.stdout\.write/);
  assert.doesNotMatch(diagnostic, /console\.|candidate|prompt|untrustedEvidence|reasoning|rawResponse|api.?key/i);
});

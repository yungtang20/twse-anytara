import assert from "node:assert/strict";
import test from "node:test";
import { AIResearchModelRunner } from "../server/lib/aiResearchModelRunner.js";
import { AIResearchModelGatewayError, InMemoryAIResearchModelGateway } from "../server/lib/aiResearchModelGateway.js";
import { buildAIResearchModelRequest } from "../server/lib/aiResearchModelRequest.js";
import { auditResearchReport } from "../server/lib/aiResearchReportAuditor.js";
import { gateResearchPublication } from "../server/lib/aiResearchPublicationGate.js";
import { hydrateAIResearchSelection } from "../server/lib/aiResearchSelectionContract.js";
import { buildAIResearchFindingCatalog } from "../server/lib/aiResearchFindingCatalog.js";
import { investmentPacket } from "./helpers/ai-research-investment-fixtures.js";

test("single model runner makes one provider call and passes a schema candidate through Auditor", async () => {
  const packet = await investmentPacket();
  const evidence = (field: string) => packet.evidence.find((item) => item.field === field)!;
  const price = evidence("market.price");
  const date = evidence("market.latestDate");
  const findings = ["positive", "negative"].map((stance) => ({
    id: `market-${stance}`, kind: "market_snapshot", stance, fragments: [
      { evidenceId: price.id, role: "value", format: "value_with_unit" },
      { evidenceId: date.id, role: "date", format: "date" },
    ],
  }));
  const candidate = { schemaVersion: 1, stockId: packet.stockId, asOf: packet.asOf,
    contextFingerprint: packet.contextFingerprint, dataQuality: packet.dataQuality, findings,
    conclusion: { verdict: "neutral", supportingFindingIds: ["market-positive"],
      opposingFindingIds: ["market-negative"], limitationFindingIds: [],
      aiConfidence: null, investmentCertainty: null },
    citations: [price.id, date.id],
    recommendation: { verdict: "HOLD", horizonMonths: 12, confidence: 0.5,
      supportingFindingIds: ["market-positive"], opposingFindingIds: ["market-negative"], riskFindingIds: [] },
    valuation: null };
  const gateway = new InMemoryAIResearchModelGateway([{ candidate, provider: "router",
    model: "glm-5.2", durationMs: 5, usage: { inputTokens: 10, outputTokens: 5 } }]);
  const result = await new AIResearchModelRunner(gateway, auditResearchReport)
    .generateAudited(buildAIResearchModelRequest(packet), packet);
  assert.equal(gateway.calls.length, 1);
  assert.equal(result.success, true);
  assert.equal(result.audit?.mechanicalPassed, true);
  assert.deepEqual(result.providerMetadata.map((item) => item.provider), ["router"]);
  assert.equal(Object.hasOwn(result, "candidate"), false);
});

test("single model runner aborts before audit and never retries", async () => {
  const packet = await investmentPacket();
  const controller = new AbortController();
  let audits = 0;
  const gateway = { async generateCandidate() {
    controller.abort();
    return { candidate: {}, provider: "router" as const, model: "glm-5.2",
      durationMs: 1, usage: { inputTokens: 1, outputTokens: 1 } };
  } };
  const result = await new AIResearchModelRunner(gateway, () => {
    audits += 1;
    return auditResearchReport({}, packet);
  }).generateAudited(buildAIResearchModelRequest(packet), packet, { signal: controller.signal });
  assert.equal(result.error, "ai_research_aborted");
  assert.equal(audits, 0);
});

test("model audit, provider response, provider timeout, and availability failures stay distinct", async () => {
  const packet = await investmentPacket();
  const request = buildAIResearchModelRequest(packet);
  const invalidResult = { candidate: {}, provider: "router" as const,
    model: "glm-5.2", durationMs: 1, usage: { inputTokens: 1, outputTokens: 1 } };
  const invalidGateway = new InMemoryAIResearchModelGateway([invalidResult, invalidResult]);
  const invalid = await new AIResearchModelRunner(invalidGateway, auditResearchReport)
    .generateAudited(request, packet);
  assert.equal(invalid.error, "ai_research_model_output_invalid");
  assert.equal(invalidGateway.calls.length, 2);

  for (const [code, expected] of [
    ["timeout", "ai_research_provider_timeout"],
    ["invalid_json", "ai_research_provider_response_invalid"],
    ["empty_response", "ai_research_provider_response_invalid"],
    ["rate_limited", "ai_research_provider_rate_limited"],
    ["server_error", "ai_research_provider_server_error"],
    ["provider_rejected", "ai_research_provider_rejected"],
    ["not_configured", "ai_research_provider_unavailable"],
    ["network", "ai_research_provider_unavailable"],
  ] as const) {
    const failedGateway = new InMemoryAIResearchModelGateway([new AIResearchModelGatewayError(code)]);
    const failed = await new AIResearchModelRunner(failedGateway, auditResearchReport)
      .generateAudited(request, packet);
    assert.equal(failed.error, expected, code);
    assert.equal(failedGateway.calls.length, 1, code);
  }
});

test("mechanical failure exposes only sanitized audit reason codes and counts", async () => {
  const packet = await investmentPacket();
  const invalidResult = {
    candidate: { secretCandidateShape: "must-not-leak" }, provider: "router", model: "glm-5.2",
    durationMs: 1, usage: { inputTokens: 1, outputTokens: 1 },
  } as const;
  const gateway = new InMemoryAIResearchModelGateway([invalidResult, invalidResult]);
  const result = await new AIResearchModelRunner(gateway, auditResearchReport)
    .generateAudited(buildAIResearchModelRequest(packet), packet);
  assert.equal(result.error, "ai_research_model_output_invalid");
  assert.ok(result.auditDiagnostics?.reasonCodes.includes("invalid_report_field"));
  assert.equal(typeof result.auditDiagnostics?.invalidCitationCount, "number");
  assert.equal(typeof result.auditDiagnostics?.unsupportedFindingCount, "number");
  assert.equal(typeof result.auditDiagnostics?.prohibitedClaimCount, "number");
  assert.doesNotMatch(JSON.stringify(result.auditDiagnostics), /must-not-leak|secretCandidateShape/);
});

test("model runner retries one correctable selection once with trusted diagnostics", async () => {
  const packet = await investmentPacket();
  const strategy = packet.evidence.find((item) => item.field === "strategies.sr.signal");
  assert.ok(strategy);
  strategy.value = "SELL";
  const catalog = buildAIResearchFindingCatalog(packet);
  const positive = catalog.find((item) => item.stance === "positive");
  const negative = catalog.find((item) => item.stance === "negative");
  const price = packet.evidence.find((item) => item.field === "market.price");
  const eps = packet.evidence.find((item) => item.field === "fundamentals.metrics.eps");
  assert.ok(positive && negative && price && eps);
  const choose = (selectedFindingIds: string[], multiples: number[]) => ({ schemaVersion: 2,
    selectedFindingIds, horizonMonths: 12, confidence: 0.6, aiConfidence: 0.6,
    investmentCertainty: 0.5, valuation: { method: "PE", currentPriceEvidenceId: price.id,
      metricEvidenceId: eps.id, scenarios: { conservative: { multiple: multiples[0] },
        base: { multiple: multiples[1] }, optimistic: { multiple: multiples[2] } } } });
  const gateway = new InMemoryAIResearchModelGateway([
    { candidate: choose([positive.id], [101, 102, 103]), provider: "router", model: "glm-5.2",
      durationMs: 5, usage: { inputTokens: 10, outputTokens: 5 } },
    { candidate: choose([positive.id, negative.id], [9, 10, 11]), provider: "router", model: "glm-5.2",
      durationMs: 4, usage: { inputTokens: 11, outputTokens: 5 } },
  ]);
  const result = await new AIResearchModelRunner(gateway, (candidate, context) =>
    gateResearchPublication(hydrateAIResearchSelection(candidate, context), context,
      { clock: () => new Date("2026-08-03T01:00:00Z") }))
    .generateAudited(buildAIResearchModelRequest(packet), packet);
  assert.equal(result.success, true);
  assert.equal(gateway.calls.length, 2);
  assert.equal(result.providerMetadata.length, 2);
  assert.match(gateway.calls[1].systemInstructions, /AI_RESEARCH_CORRECTION_BEGIN/);
  assert.match(gateway.calls[1].systemInstructions, /valuation_multiple_out_of_range/);
  assert.match(gateway.calls[1].systemInstructions, /recommendation_hold_balance_required/);
  assert.doesNotMatch(gateway.calls[1].systemInstructions, /101|102|103/);
});

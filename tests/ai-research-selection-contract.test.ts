import assert from "node:assert/strict";
import test from "node:test";
import { auditResearchReport } from "../server/lib/aiResearchReportAuditor.js";
import { gateResearchPublication } from "../server/lib/aiResearchPublicationGate.js";
import { buildAIResearchFindingCatalog } from "../server/lib/aiResearchFindingCatalog.js";
import { hydrateAIResearchSelection } from "../server/lib/aiResearchSelectionContract.js";
import { buildAIResearchModelRequest } from "../server/lib/aiResearchModelRequest.js";
import { validateResearchFindingRuntime } from "../server/lib/aiResearchFindingPolicy.js";
import { investmentPacket } from "./helpers/ai-research-investment-fixtures.js";

function selection(ids: { positive: string; negative: string }, priceId: string, epsId: string) {
  return {
    schemaVersion: 2,
    selectedFindingIds: [ids.positive, ids.negative],
    horizonMonths: 12, confidence: 0.7, aiConfidence: 0.7, investmentCertainty: 0.6,
    valuation: { method: "PE", currentPriceEvidenceId: priceId, metricEvidenceId: epsId,
      scenarios: { conservative: { multiple: 9 }, base: { multiple: 10 },
        optimistic: { multiple: 11 } } },
  };
}

test("server-generated finding catalog contains only runtime-valid canonical findings", async () => {
  const packet = await investmentPacket();
  const dealer = packet.evidence.find((item) => item.field.endsWith(".dealerNet"));
  const strategy = packet.evidence.find((item) => item.field === "strategies.sr.signal");
  assert.ok(dealer);
  dealer.value = -5;
  assert.ok(strategy);
  strategy.value = "SELL";
  const catalog = buildAIResearchFindingCatalog(packet);
  assert.ok(catalog.length > 0 && catalog.length <= 10);
  for (const finding of catalog) {
    assert.deepEqual(validateResearchFindingRuntime(finding, packet).finding, finding);
  }
  assert.ok(catalog.some((item) => item.kind === "institutional_flow" && item.stance === "positive"));
});

test("selection v2 makes model choose IDs and cannot write finding mechanics or duplicate horizon", async () => {
  const packet = await investmentPacket();
  const request = buildAIResearchModelRequest(packet);
  assert.equal(request.candidateContractVersion, "ai-research-selection.v2");
  const instructions = request.systemInstructions;
  const schema = JSON.parse(instructions.split("AI_RESEARCH_SELECTION_JSON_SCHEMA_BEGIN")[1]
    .split("AI_RESEARCH_SELECTION_JSON_SCHEMA_END")[0].trim()) as {
      required: string[];
      properties: Record<string, { properties?: Record<string, unknown> }>;
    };
  assert.deepEqual(schema.required, ["schemaVersion", "selectedFindingIds", "horizonMonths",
    "confidence", "aiConfidence", "investmentCertainty", "valuation"]);
  assert.equal(Object.hasOwn(schema.properties, "findings"), false);
  assert.equal(Object.hasOwn(schema.properties, "citations"), false);
  assert.equal(Object.hasOwn(schema.properties, "conclusion"), false);
  assert.equal(Object.hasOwn(schema.properties, "recommendation"), false);
  assert.equal(Object.hasOwn(schema.properties.valuation.properties ?? {}, "horizonMonths"), false);
  assert.doesNotMatch(JSON.stringify(schema), /"stance"|"fragments"|"citations"/);
  assert.ok(request.untrustedEvidence.findingCatalog.length > 0);
  assert.match(instructions, /PE 倍數必須大於 0 且不超過 100/);
  assert.match(instructions, /HOLD.*positive.*negative/);
});

test("selection request excludes packet history not referenced by the finding catalog or valuation", async () => {
  const packet = await investmentPacket();
  for (let index = 0; index < 400; index += 1) packet.evidence.push({
    id: `ev:noise-${index}`, dataset: "stock_price", field: `market.history.${index}.close`,
    value: index, unit: "TWD", date: "2025-01-01", sourceId: "supabase:stock_price",
    estimated: false, available: true,
  });
  const request = buildAIResearchModelRequest(packet);
  assert.equal(request.untrustedEvidence.evidence.some((item) => item.id.startsWith("ev:noise-")), false);
  assert.ok(JSON.stringify(request.untrustedEvidence).length < 25_000);
});

test("hydration derives findings, citations, identity, and valuation horizon from trusted server state", async () => {
  const packet = await investmentPacket();
  const strategy = packet.evidence.find((item) => item.field === "strategies.sr.signal");
  assert.ok(strategy);
  strategy.value = "SELL";
  const catalog = buildAIResearchFindingCatalog(packet);
  const positive = catalog.find((item) => item.kind === "institutional_flow" && item.stance === "positive");
  const negative = catalog.find((item) => item.kind === "strategy_result" && item.stance === "negative");
  const price = packet.evidence.find((item) => item.field === "market.price");
  const eps = packet.evidence.find((item) => item.field === "fundamentals.metrics.eps");
  assert.ok(positive && negative && price && eps);
  const hydrated = hydrateAIResearchSelection(selection({ positive: positive.id, negative: negative.id },
    price.id, eps.id), packet);
  assert.equal(hydrated.stockId, packet.stockId);
  assert.deepEqual(hydrated.findings, [positive, negative]);
  assert.deepEqual(hydrated.citations, [...new Set([...positive.fragments, ...negative.fragments]
    .map((item) => item.evidenceId))].sort());
  assert.equal(hydrated.valuation?.horizonMonths, hydrated.recommendation?.horizonMonths);
  const audit = auditResearchReport(hydrated, packet);
  assert.equal(audit.mechanicalPassed, true, audit.errors.join("\n"));
});

test("unknown IDs and attempts to inject model-written findings fail closed", async () => {
  const packet = await investmentPacket();
  const base = { schemaVersion: 2, selectedFindingIds: ["unknown:finding"],
    horizonMonths: 12, confidence: 0.5, aiConfidence: null, investmentCertainty: null,
    valuation: { method: "PE", currentPriceEvidenceId: "missing", metricEvidenceId: "missing",
      scenarios: { conservative: { multiple: 9 }, base: { multiple: 10 }, optimistic: { multiple: 11 } } } };
  assert.throws(() => hydrateAIResearchSelection(base, packet), /selection_finding_not_found/);
  assert.throws(() => hydrateAIResearchSelection({ ...base, findings: [{ id: "forged", stance: "positive",
    fragments: [], citations: [] }] }, packet), /selection_unknown_field:findings/);
  assert.throws(() => hydrateAIResearchSelection({ ...base, selectedFindingIds: [], verdict: "BUY" }, packet),
    /selection_unknown_field:verdict/);
  assert.throws(() => hydrateAIResearchSelection({ ...base, selectedFindingIds: [],
    supportingFindingIds: ["forged"] }, packet), /selection_unknown_field:supportingFindingIds/);
});

test("institutional catalog keeps only the latest data date", async () => {
  const packet = await investmentPacket();
  const current = packet.evidence.find((item) => item.field.endsWith(".foreignNet"));
  const currentDate = packet.evidence.find((item) => item.field.match(/institutional\..*\.date$/));
  assert.ok(current && currentDate);
  packet.evidence.push({ ...current, id: "ev:older-foreign", field: "institutional.2026-07-30.foreignNet",
    date: "2026-07-30" }, { ...currentDate, id: "ev:older-date", field: "institutional.2026-07-30.date",
    value: "2026-07-30", date: "2026-07-30" });
  const institutional = buildAIResearchFindingCatalog(packet)
    .filter((item) => item.kind === "institutional_flow");
  assert.ok(institutional.length > 0);
  assert.ok(institutional.every((item) => item.id.includes("2026-07-31")));
  assert.ok(institutional.every((item) => !item.fragments.some((fragment) => fragment.evidenceId === "ev:older-foreign")));
});

test("server verdict policy downgrades one-domain directional evidence to publishable HOLD", async () => {
  const packet = await investmentPacket();
  for (const strategyId of ["sr", "chips"]) {
    const signal = packet.evidence.find((item) => item.field === `strategies.${strategyId}.signal`);
    assert.ok(signal);
    signal.value = "SELL";
  }
  const catalog = buildAIResearchFindingCatalog(packet);
  const selectedIds = catalog.map((item) => item.id);
  const price = packet.evidence.find((item) => item.field === "market.price");
  const eps = packet.evidence.find((item) => item.field === "fundamentals.metrics.eps");
  assert.ok(price && eps);
  const candidate = hydrateAIResearchSelection({ schemaVersion: 2, selectedFindingIds: selectedIds,
    horizonMonths: 12, confidence: 0.6, aiConfidence: 0.6, investmentCertainty: 0.5,
    valuation: { method: "PE", currentPriceEvidenceId: price.id, metricEvidenceId: eps.id,
      scenarios: { conservative: { multiple: 7 }, base: { multiple: 8 },
        optimistic: { multiple: 9 } } } }, packet);
  assert.equal(candidate.recommendation?.verdict, "HOLD");
  assert.equal(candidate.conclusion.verdict, "neutral");
  const neutralRisk = catalog.find((item) => item.kind === "trade_risk" && item.stance === "neutral");
  assert.ok(neutralRisk);
  assert.equal(candidate.recommendation?.riskFindingIds.includes(neutralRisk.id), false);
  const result = gateResearchPublication(candidate, packet, { clock: () => new Date("2026-08-03T01:00:00Z") });
  assert.equal(result.publicationReady, true, result.errors.join("\n"));
  assert.equal(result.publishedReport?.recommendation.verdict, "HOLD");
});

test("server verdict policy keeps a two-domain one-sided SELL aligned with deep valuation downside", async () => {
  const packet = await investmentPacket();
  const institutional = packet.evidence.find((item) => item.field.endsWith(".institutionalNet"));
  const strategy = packet.evidence.find((item) => item.field === "strategies.sr.signal");
  assert.ok(institutional && strategy);
  institutional.value = -100;
  strategy.value = "SELL";
  const catalog = buildAIResearchFindingCatalog(packet);
  assert.ok(catalog.some((item) => item.kind === "institutional_flow" && item.stance === "negative"));
  assert.ok(catalog.some((item) => item.kind === "strategy_result" && item.stance === "negative"));
  assert.equal(catalog.some((item) => item.stance === "positive"), false);
  const price = packet.evidence.find((item) => item.field === "market.price");
  const eps = packet.evidence.find((item) => item.field === "fundamentals.metrics.eps");
  assert.ok(price && eps);
  const candidate = hydrateAIResearchSelection({ schemaVersion: 2,
    selectedFindingIds: catalog.map((item) => item.id), horizonMonths: 12,
    confidence: 0.6, aiConfidence: 0.6, investmentCertainty: 0.5,
    valuation: { method: "PE", currentPriceEvidenceId: price.id, metricEvidenceId: eps.id,
      scenarios: { conservative: { multiple: 7 }, base: { multiple: 8 },
        optimistic: { multiple: 9 } } } }, packet);
  assert.equal(candidate.recommendation?.verdict, "SELL");
  const result = gateResearchPublication(candidate, packet,
    { clock: () => new Date("2026-08-03T01:00:00Z") });
  assert.equal(result.publicationReady, true, result.errors.join("\n"));
  assert.equal(result.publishedReport?.recommendation.verdict, "SELL");
  assert.ok((result.publishedReport?.valuation.scenarios.find((item) => item.name === "base")
    ?.expectedReturnRatio ?? 0) < -0.05);
});

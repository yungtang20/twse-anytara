import assert from "node:assert/strict";
import test from "node:test";
import { ResearchContextAggregator } from "../server/lib/researchContext.js";
import { createResearchContextAdapter } from "./helpers/research-context-fixtures.js";

async function fixture() {
  const context = await new ResearchContextAggregator(createResearchContextAdapter(), {
    clock: () => new Date("2026-08-02T03:04:05.000Z"), asOfDate: "2026-07-31",
  }).aggregate("2330");
  const { buildResearchPacket } = await import("../server/lib/aiResearchPacket.js");
  return buildResearchPacket(context);
}

function candidate(packet: Awaited<ReturnType<typeof fixture>>) {
  const price = packet.evidence.find((item) => item.field === "market.price");
  const date = packet.evidence.find((item) => item.field === "market.latestDate");
  assert.ok(price);
  assert.ok(date);
  return {
    schemaVersion: 1,
    stockId: packet.stockId,
    asOf: packet.asOf,
    contextFingerprint: packet.contextFingerprint,
    dataQuality: packet.dataQuality,
    findings: [{
      id: "market-price", kind: "market_snapshot", stance: "positive",
      fragments: [{ evidenceId: price.id, role: "value", format: "value_with_unit" },
        { evidenceId: date.id, role: "date", format: "date" }],
    }],
    conclusion: {
      verdict: "neutral", supportingFindingIds: ["market-price"], opposingFindingIds: [],
      limitationFindingIds: [], aiConfidence: 0.5, investmentCertainty: null,
    },
    citations: [price.id, date.id],
  };
}

test("auditor recomputes a valid structured report instead of trusting candidate text", async () => {
  const packet = await fixture();
  const { auditResearchReport } = await import("../server/lib/aiResearchReportAuditor.js");
  const result = auditResearchReport(candidate(packet), packet);
  assert.equal(result.mechanicalPassed, true);
  assert.equal(result.publicationReady, false);
  assert.equal(result.semanticGrounding, "unverified");
  assert.match(result.draft?.conclusion ?? "", /market-price|收盤價/);
});

test("data quality identity is semantic and ignores JSON object key order", async () => {
  const packet = await fixture();
  const { auditResearchReport } = await import("../server/lib/aiResearchReportAuditor.js");
  const quality = packet.dataQuality;
  const reordered = {
    informationRichness: quality.informationRichness,
    warnings: [...quality.warnings],
    staleDatasets: [...quality.staleDatasets],
    missingDatasets: [...quality.missingDatasets],
    status: quality.status,
  };
  const result = auditResearchReport({ ...candidate(packet), dataQuality: reordered }, packet);
  assert.equal(result.mechanicalPassed, true);
  assert.equal(result.errors.includes("data_quality_mismatch"), false);
});

test("legacy free-text report contract fails closed", async () => {
  const packet = await fixture();
  const { auditResearchReport } = await import("../server/lib/aiResearchReportAuditor.js");
  const legacy = {
    ...candidate(packet), findings: undefined,
    bullCase: [{ id: "bankrupt", text: "公司已經破產", evidenceIds: [packet.evidence[0].id] }],
    conclusion: { verdict: "neutral", summary: "公司治理存在重大舞弊" },
  };
  const result = auditResearchReport(legacy, packet);
  assert.equal(result.mechanicalPassed, false);
  assert.equal(result.publicationReady, false);
  assert.equal(result.semanticGrounding, "unverified");
  assert.ok(result.errors.includes("invalid_findings"));
  assert.ok(result.errors.includes("raw_conclusion_summary_forbidden"));
});

test("identity mismatch and duplicate packet evidence never pass mechanically", async () => {
  const packet = await fixture();
  const { auditResearchReport } = await import("../server/lib/aiResearchReportAuditor.js");
  const duplicate = structuredClone(packet);
  duplicate.evidence.push({ ...duplicate.evidence[0], value: "collision" });
  const report = { ...candidate(packet), contextFingerprint: "forged" };
  const result = auditResearchReport(report, duplicate);
  assert.equal(result.mechanicalPassed, false);
  assert.ok(result.errors.includes("context_fingerprint_mismatch"));
  assert.ok(result.errors.includes(`research_evidence_collision:${duplicate.evidence[0].id}`));
});

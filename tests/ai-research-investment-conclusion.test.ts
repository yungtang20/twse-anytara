import assert from "node:assert/strict";
import test from "node:test";
import { evaluateInvestmentConclusion } from "../server/lib/aiResearchInvestmentConclusion.js";
import { auditResearchReport } from "../server/lib/aiResearchReportAuditor.js";
import { investmentFindings, investmentPacket, peValuation, recommendation } from "./helpers/ai-research-investment-fixtures.js";

test("valid BUY HOLD and SELL are deterministically server-rendered", async () => {
  const packet = await investmentPacket();
  const findings = investmentFindings();
  for (const [verdict, label] of [["BUY", "買進"], ["HOLD", "持有"], ["SELL", "賣出"]] as const) {
    const candidate = { recommendation: recommendation(verdict),
      valuation: verdict === "SELL" ? { ...peValuation(packet), scenarios: {
        conservative: { multiple: 4 }, base: { multiple: 8 }, optimistic: { multiple: 9 },
      } } : verdict === "BUY" ? peValuation(packet) : null };
    const result = evaluateInvestmentConclusion(candidate, packet, findings);
    assert.deepEqual(result.errors, [], verdict);
    assert.equal(result.recommendation?.label, label);
  }
});

test("recommendation confidence canonicalizes negative zero through numeric policy", async () => {
  const packet = await investmentPacket();
  const result = evaluateInvestmentConclusion({
    recommendation: { ...recommendation("BUY"), confidence: -0 },
    valuation: peValuation(packet),
  }, packet, investmentFindings());
  assert.deepEqual(result.errors, []);
  assert.equal(result.recommendation?.confidence, 0);
  assert.equal(Object.is(result.recommendation?.confidence, -0), false);
});

test("directional recommendation requires role-consistent multi-domain evidence", async () => {
  const packet = await investmentPacket();
  const findings = investmentFindings();
  const none = evaluateInvestmentConclusion({ recommendation: { ...recommendation("BUY"),
    supportingFindingIds: [] } }, packet, findings);
  assert.ok(none.errors.includes("recommendation_supporting_findings_required:BUY"));
  const oneStrategy = evaluateInvestmentConclusion({ recommendation: { ...recommendation("BUY"),
    supportingFindingIds: ["strategy-positive"] } }, packet, findings);
  assert.ok(oneStrategy.errors.includes("recommendation_directional_support_minimum:BUY"));
  assert.ok(oneStrategy.errors.includes("recommendation_domain_coverage_insufficient:BUY"));
  const wrongRole = evaluateInvestmentConclusion({ recommendation: { ...recommendation("BUY"),
    supportingFindingIds: ["financial-negative", "institutional-positive"] } }, packet, findings);
  assert.ok(wrongRole.errors.includes("recommendation_invalid_supporting_stance:financial-negative"));
});

test("HOLD cannot be evidence-free and richness C forces cited insufficient data", async () => {
  const packet = await investmentPacket();
  const findings = investmentFindings();
  const emptyHold = evaluateInvestmentConclusion({ recommendation: { ...recommendation("HOLD"),
    supportingFindingIds: [], opposingFindingIds: [], riskFindingIds: [] } }, packet, findings);
  assert.ok(emptyHold.errors.includes("recommendation_hold_evidence_required"));
  const sparse = structuredClone(packet);
  sparse.dataQuality.informationRichness = "C";
  const buy = evaluateInvestmentConclusion({ recommendation: recommendation("BUY") }, sparse, findings);
  assert.ok(buy.errors.includes("recommendation_richness_c_requires_insufficient_data"));
  const insufficient = evaluateInvestmentConclusion({ recommendation: recommendation("INSUFFICIENT_DATA") }, sparse, findings);
  assert.deepEqual(insufficient.errors, []);
  assert.equal(insufficient.valuation, null);
});

test("candidate-calculated values and free-text smuggling fail closed", async () => {
  const packet = await investmentPacket();
  const findings = investmentFindings();
  for (const candidate of [
    { recommendation: { ...recommendation("BUY"), targetPrice: 1000 } },
    { recommendation: recommendation("BUY"), valuation: { ...peValuation(packet), expectedReturn: "300%" } },
    { recommendation: recommendation("BUY"), metadata: { note: "目標價 1000" } },
    { recommendation: recommendation("BUY"), summary: "預期報酬 300%" },
    { recommendation: recommendation("BUY"), limitations: ["目\u200b標\u200b價１０００"] },
  ]) {
    const result = evaluateInvestmentConclusion(candidate, packet, findings);
    assert.ok(result.errors.some((error) => error.startsWith("investment_candidate_")), JSON.stringify(result.errors));
  }
});

test("same candidate is deterministic and object key order is irrelevant", async () => {
  const packet = await investmentPacket();
  const findings = investmentFindings();
  const firstCandidate = { recommendation: recommendation("BUY"), valuation: peValuation(packet) };
  const reordered = { valuation: peValuation(packet), recommendation: { ...recommendation("BUY") } };
  assert.deepEqual(evaluateInvestmentConclusion(firstCandidate, packet, findings),
    evaluateInvestmentConclusion(firstCandidate, packet, findings));
  assert.deepEqual(evaluateInvestmentConclusion(firstCandidate, packet, findings),
    evaluateInvestmentConclusion(reordered, packet, findings));
});

test("prohibited scanner allows legal investment terms but catches guarantee evasions", async () => {
  const packet = await investmentPacket();
  const base = { schemaVersion: 1, stockId: packet.stockId, asOf: packet.asOf,
    contextFingerprint: packet.contextFingerprint, dataQuality: packet.dataQuality,
    findings: [], conclusion: { verdict: "neutral", supportingFindingIds: [], opposingFindingIds: [],
      limitationFindingIds: [], aiConfidence: null, investmentCertainty: null }, citations: [],
    recommendation: recommendation("BUY"), valuation: peValuation(packet) };
  const legal = auditResearchReport(base, packet);
  assert.deepEqual(legal.prohibitedClaims, []);
  for (const text of ["保證獲利", "必漲", "穩\u200b賺", "零風險", "ＢＵＹ 但保證獲利"]) {
    const attacked = auditResearchReport({ ...base, metadata: text }, packet);
    assert.ok(attacked.errors.includes("prohibited_claims_present"), text);
  }
});

test("auditor accepts a legal BUY and exposes only server-calculated valuation", async () => {
  const packet = await investmentPacket();
  const evidence = (field: string) => packet.evidence.find((item) => item.field === field)!;
  const priceDate = evidence("market.latestDate");
  const institutionalValue = evidence("institutional.2026-07-31.trustNet");
  const institutionalDate = evidence("institutional.2026-07-31.date");
  const eps = evidence("fundamentals.metrics.eps");
  const risk = evidence("tradeRisks.highestLevel");
  const findings = [
    { id: "financial-positive", kind: "financial_metric", stance: "positive", fragments: [
      { evidenceId: eps.id, role: "value", format: "value_with_unit" }] },
    { id: "financial-negative", kind: "financial_metric", stance: "negative", fragments: [
      { evidenceId: eps.id, role: "value", format: "value_with_unit" }] },
    { id: "institutional-positive", kind: "institutional_flow", stance: "positive", fragments: [
      { evidenceId: institutionalValue.id, role: "value", format: "value_with_unit" },
      { evidenceId: institutionalDate.id, role: "date", format: "date" }] },
    { id: "risk-negative", kind: "trade_risk", stance: "negative", fragments: [
      { evidenceId: risk.id, role: "risk", format: "label" }] },
  ];
  const candidate = { schemaVersion: 1, stockId: packet.stockId, asOf: packet.asOf,
    contextFingerprint: packet.contextFingerprint, dataQuality: packet.dataQuality, findings,
    conclusion: { verdict: "positive", supportingFindingIds: ["financial-positive", "institutional-positive"],
      opposingFindingIds: ["financial-negative"], limitationFindingIds: [], aiConfidence: null, investmentCertainty: null },
    citations: [eps.id, institutionalValue.id, institutionalDate.id, risk.id],
    recommendation: { ...recommendation("BUY"), opposingFindingIds: ["financial-negative"], riskFindingIds: ["risk-negative"] },
    valuation: peValuation(packet) };
  const result = auditResearchReport(candidate, packet);
  assert.deepEqual(result.errors, []);
  assert.equal(result.mechanicalPassed, true);
  assert.equal(result.recommendation?.label, "買進");
  assert.equal(result.valuation?.scenarios[1].targetPrice, 120);
  assert.equal(result.publicationReady, false);
  assert.equal(result.publishedReport, null);
  assert.ok(priceDate);

  for (const [recommendationVerdict, conclusionVerdict] of [
    ["BUY", "neutral"], ["HOLD", "positive"], ["SELL", "positive"],
    ["INSUFFICIENT_DATA", "positive"],
  ] as const) {
    const mismatch = auditResearchReport({
      ...candidate,
      conclusion: { ...candidate.conclusion, verdict: conclusionVerdict },
      recommendation: recommendation(recommendationVerdict),
      valuation: recommendationVerdict === "BUY" ? peValuation(packet) : null,
    }, packet);
    assert.equal(mismatch.mechanicalPassed, false);
    assert.ok(mismatch.errors.includes(
      `recommendation_conclusion_verdict_mismatch:${recommendationVerdict}:${conclusionVerdict}`,
    ), JSON.stringify(mismatch.errors));
  }
});

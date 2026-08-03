import assert from "node:assert/strict";
import test from "node:test";
import { evaluateInvestmentConclusion } from "../server/lib/aiResearchInvestmentConclusion.js";
import { investmentFindings, investmentPacket, peValuation, recommendation } from "./helpers/ai-research-investment-fixtures.js";

test("PE and PB scenarios are calculated only by the server", async () => {
  const packet = await investmentPacket();
  const findings = investmentFindings();
  const pe = evaluateInvestmentConclusion({ recommendation: recommendation("BUY"), valuation: peValuation(packet) }, packet, findings);
  assert.deepEqual(pe.errors, []);
  assert.deepEqual(pe.valuation?.scenarios, [
    { name: "conservative", multiple: 8, targetPrice: 80, expectedReturnRatio: -0.2, expectedReturnPercent: -20 },
    { name: "base", multiple: 12, targetPrice: 120, expectedReturnRatio: 0.2, expectedReturnPercent: 20 },
    { name: "optimistic", multiple: 16, targetPrice: 160, expectedReturnRatio: 0.6, expectedReturnPercent: 60 },
  ]);
  const pbEvidence = packet.evidence.find((item) => item.field.endsWith(".bvps"))!;
  const pb = evaluateInvestmentConclusion({ recommendation: recommendation("BUY"), valuation: {
    ...peValuation(packet, [1, 2.4, 3]), method: "PB", metricEvidenceId: pbEvidence.id,
  } }, packet, findings);
  assert.deepEqual(pb.errors, []);
  assert.equal(pb.valuation?.metric.name, "BVPS");
  assert.equal(pb.valuation?.scenarios[1].targetPrice, 120);
});

test("PE valuation accepts a producer TTM EPS period", async () => {
  const packet = await investmentPacket();
  const findings = investmentFindings();
  packet.fundamentals.metrics.find((metric) => metric.key === "eps")!.period = "TTM";
  packet.evidence.find((item) => item.field === "fundamentals.metrics.eps")!.date = "TTM";
  const result = evaluateInvestmentConclusion({ recommendation: recommendation("BUY"),
    valuation: peValuation(packet) }, packet, findings);
  assert.equal(result.errors.includes("valuation_metric_annual_period_required:EPS"), false, JSON.stringify(result.errors));
  assert.equal(result.valuation?.metric.period, "TTM");
});

test("valuation rejects missing or wrong evidence and unusable metrics", async () => {
  const packet = await investmentPacket();
  const findings = investmentFindings();
  const base = peValuation(packet);
  for (const [change, code] of [
    [{ currentPriceEvidenceId: "missing" }, "valuation_current_price_evidence_not_found:missing"],
    [{ metricEvidenceId: packet.evidence.find((item) => item.field.endsWith(".bvps"))!.id }, "valuation_metric_mismatch:PE"],
  ] as const) {
    const result = evaluateInvestmentConclusion({ recommendation: recommendation("BUY"), valuation: { ...base, ...change } }, packet, findings);
    assert.ok(result.errors.includes(code), JSON.stringify(result.errors));
  }
  const wrongPb = evaluateInvestmentConclusion({ recommendation: recommendation("BUY"), valuation: {
    ...base, method: "PB", metricEvidenceId: packet.evidence.find((item) => item.field.endsWith(".eps"))!.id,
  } }, packet, findings);
  assert.ok(wrongPb.errors.includes("valuation_metric_mismatch:PB"));
  for (const mutate of [
    (copy: typeof packet) => { copy.evidence.find((item) => item.field.endsWith(".eps"))!.available = false; },
    (copy: typeof packet) => { copy.evidence.find((item) => item.field.endsWith(".eps"))!.value = null; },
    (copy: typeof packet) => { copy.dataQuality.staleDatasets.push("financials"); },
    (copy: typeof packet) => { copy.fundamentals.metrics.find((item) => item.key === "eps")!.period = "2026-Q2"; },
  ]) {
    const copy = structuredClone(packet); mutate(copy);
    const result = evaluateInvestmentConclusion({ recommendation: recommendation("BUY"), valuation: peValuation(copy) }, copy, findings);
    assert.ok(result.errors.some((error) => /valuation_metric_(?:unavailable|stale|annual_period_required)/.test(error)), JSON.stringify(result.errors));
  }
});

test("valuation rejects stale stock price data before calculating scenarios", async () => {
  for (const staleDataset of ["stock_price", "supabase:stock_price"]) {
    const packet = await investmentPacket();
    const price = packet.evidence.find((item) => item.field === "market.price")!;
    if (staleDataset.includes(":")) {
      const source = packet.sources.find((item) => item.id === price.sourceId)!;
      packet.dataQuality.staleDatasets.push(source.id);
    } else {
      packet.dataQuality.staleDatasets.push(staleDataset);
    }
    const result = evaluateInvestmentConclusion({
      recommendation: recommendation("BUY"), valuation: peValuation(packet),
    }, packet, investmentFindings());
    assert.equal(result.valuation, null);
    assert.ok(result.errors.includes("valuation_current_price_stale"), JSON.stringify(result.errors));
  }
});

test("scenario and numeric policies reject invalid multiples and price", async () => {
  const packet = await investmentPacket();
  const findings = investmentFindings();
  const badSets = [[12, 8, 16], [Number.NaN, 12, 16], [8, Number.POSITIVE_INFINITY, 16], [-1, 12, 16], [8, 101, 102]];
  for (const values of badSets) {
    const result = evaluateInvestmentConclusion({ recommendation: recommendation("BUY"), valuation: peValuation(packet, values) }, packet, findings);
    assert.ok(result.errors.some((error) => error.startsWith("valuation_multiple_")), JSON.stringify(result.errors));
  }
  const zero = structuredClone(packet);
  zero.evidence.find((item) => item.field === "market.price")!.value = 0;
  const result = evaluateInvestmentConclusion({ recommendation: recommendation("BUY"), valuation: peValuation(zero) }, zero, findings);
  assert.ok(result.errors.includes("valuation_current_price_must_be_positive"));
  const forged = peValuation(packet) as ReturnType<typeof peValuation> & {
    scenarios: ReturnType<typeof peValuation>["scenarios"] & { base: { multiple: number; targetPrice: number } };
  };
  forged.scenarios.base = { multiple: 12, targetPrice: 1 };
  const smuggled = evaluateInvestmentConclusion({ recommendation: recommendation("BUY"), valuation: forged }, packet, findings);
  assert.ok(smuggled.errors.includes("investment_candidate_calculated_field_forbidden:candidate.valuation.scenarios.base.targetPrice"));
});

test("zero expected return is canonical zero and input changes alter server results", async () => {
  const packet = await investmentPacket();
  const findings = investmentFindings();
  const neutral = evaluateInvestmentConclusion({ recommendation: recommendation("HOLD"),
    valuation: peValuation(packet, [8, 10, 12]) }, packet, findings);
  const ratio = neutral.valuation?.scenarios[1].expectedReturnRatio;
  assert.equal(ratio, 0);
  assert.equal(Object.is(ratio, -0), false);
  const changedPrice = structuredClone(packet);
  changedPrice.evidence.find((item) => item.field === "market.price")!.value = 80;
  const changed = evaluateInvestmentConclusion({ recommendation: recommendation("BUY"),
    valuation: peValuation(changedPrice) }, changedPrice, findings);
  assert.notEqual(changed.valuation?.scenarios[1].expectedReturnRatio,
    evaluateInvestmentConclusion({ recommendation: recommendation("BUY"), valuation: peValuation(packet) }, packet, findings)
      .valuation?.scenarios[1].expectedReturnRatio);
});

test("SELL cannot contradict a positive base return and estimated metric is marked", async () => {
  const packet = await investmentPacket();
  const findings = investmentFindings();
  const sell = evaluateInvestmentConclusion({ recommendation: recommendation("SELL"), valuation: peValuation(packet) }, packet, findings);
  assert.ok(sell.errors.includes("recommendation_base_return_direction_mismatch:SELL"));
  packet.evidence.find((item) => item.field.endsWith(".eps"))!.estimated = true;
  const estimated = evaluateInvestmentConclusion({ recommendation: recommendation("BUY"), valuation: peValuation(packet) }, packet, findings);
  assert.equal(estimated.valuation?.metric.estimated, true);
});

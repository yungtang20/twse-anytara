import assert from "node:assert/strict";
import test from "node:test";
import { gateResearchPublication } from "../server/lib/aiResearchPublicationGate.js";
import type { AIResearchPacket, AIResearchReportCandidate, StructuredResearchFinding } from "../shared/aiResearch.js";
import { investmentPacket, peValuation, recommendation } from "./helpers/ai-research-investment-fixtures.js";

function evidence(packet: AIResearchPacket, field: string) {
  const item = packet.evidence.find((entry) => entry.field === field);
  if (!item) throw new Error(`fixture_evidence_missing:${field}`);
  return item;
}

function finding(id: string, kind: StructuredResearchFinding["kind"],
  stance: StructuredResearchFinding["stance"], fragments: StructuredResearchFinding["fragments"],
  extra: Partial<StructuredResearchFinding> = {}): StructuredResearchFinding {
  return { id, kind, stance, fragments, ...extra };
}

async function publicationFixture() {
  const packet = await investmentPacket();
  packet.strategies.sr.signal = "BUY";
  packet.strategies.ma.signal = "SELL";
  packet.strategies.chips.signal = "HOLD";
  packet.strategies.pattern.signal = "UNKNOWN";
  for (const [strategy, signal] of Object.entries({ sr: "BUY", ma: "SELL", chips: "HOLD", pattern: "UNKNOWN" })) {
    evidence(packet, `strategies.${strategy}.signal`).value = signal;
  }
  packet.tdcc.retailRatio = 20;
  Object.assign(evidence(packet, "tdcc.retailRatio"), { value: 20, available: true });
  packet.dataQuality.missingDatasets = ["TaiwanStockDividend"];
  packet.dataQuality.status = "partial";

  const tdccSource = evidence(packet, "tdcc.whaleRatio").sourceId;
  const institutionalSource = evidence(packet, "institutional.2026-07-31.trustNet").sourceId;
  packet.evidence.push(
    { id: "ev:tdcc:whale:previous", dataset: "tdcc_shareholding", field: "tdcc.whaleRatio",
      value: 50, unit: "%", date: "2026-07-24", sourceId: tdccSource, estimated: false, available: true },
    { id: "ev:tdcc:retail:previous", dataset: "tdcc_shareholding", field: "tdcc.retailRatio",
      value: 25, unit: "%", date: "2026-07-24", sourceId: tdccSource, estimated: false, available: true },
    { id: "ev:tdcc:date:previous", dataset: "tdcc_shareholding", field: "tdcc.date",
      value: "2026-07-24", unit: "date", date: "2026-07-24", sourceId: tdccSource, estimated: false, available: true },
    { id: "ev:institutional:negative", dataset: "stock_institutional",
      field: "institutional.2026-07-30.dealerNet", value: -5, unit: "shares", date: "2026-07-30",
      sourceId: institutionalSource, estimated: false, available: true },
    { id: "ev:institutional:negative-date", dataset: "stock_institutional",
      field: "institutional.2026-07-30.date", value: "2026-07-30", unit: "date", date: "2026-07-30",
      sourceId: institutionalSource, estimated: false, available: true },
  );
  const dated = (strategy: string) => [
    { evidenceId: evidence(packet, `strategies.${strategy}.signal`).id, role: "subject" as const, format: "label" as const },
    { evidenceId: evidence(packet, `strategies.${strategy}.date`).id, role: "date" as const, format: "date" as const },
  ];
  const findings: StructuredResearchFinding[] = [
    finding("company-neutral", "company_fact", "neutral", [
      { evidenceId: evidence(packet, "company.name").id, role: "subject", format: "label" },
    ]),
    finding("market-neutral", "market_snapshot", "neutral", [
      { evidenceId: evidence(packet, "market.price").id, role: "value", format: "value_with_unit" },
      { evidenceId: evidence(packet, "market.latestDate").id, role: "date", format: "date" },
    ]),
    finding("financial-neutral", "financial_metric", "neutral", [
      { evidenceId: evidence(packet, "fundamentals.metrics.eps").id, role: "value", format: "value_with_unit" },
    ]),
    finding("institutional-positive", "institutional_flow", "positive", [
      { evidenceId: evidence(packet, "institutional.2026-07-31.trustNet").id, role: "value", format: "value_with_unit" },
      { evidenceId: evidence(packet, "institutional.2026-07-31.date").id, role: "date", format: "date" },
    ]),
    finding("institutional-zero", "institutional_flow", "neutral", [
      { evidenceId: evidence(packet, "institutional.2026-07-31.foreignNet").id, role: "value", format: "value_with_unit" },
      { evidenceId: evidence(packet, "institutional.2026-07-31.date").id, role: "date", format: "date" },
    ]),
    finding("institutional-negative", "institutional_flow", "negative", [
      { evidenceId: "ev:institutional:negative", role: "value", format: "value_with_unit" },
      { evidenceId: "ev:institutional:negative-date", role: "date", format: "date" },
    ]),
    finding("strategy-buy", "strategy_result", "positive", dated("sr"), { strategyId: "sr" }),
    finding("strategy-sell", "strategy_result", "negative", dated("ma"), { strategyId: "ma" }),
    finding("strategy-hold", "strategy_result", "neutral", dated("chips"), { strategyId: "chips" }),
    finding("strategy-unknown", "strategy_result", "insufficient", dated("pattern"), { strategyId: "pattern" }),
    finding("risk-none", "trade_risk", "neutral", [
      { evidenceId: evidence(packet, "tradeRisks.highestLevel").id, role: "risk", format: "label" },
    ]),
    finding("whale-rising", "evidence_comparison", "positive", [
      { evidenceId: evidence(packet, "tdcc.whaleRatio").id, role: "current", format: "value_with_unit" },
      { evidenceId: "ev:tdcc:whale:previous", role: "previous", format: "value_with_unit" },
      { evidenceId: evidence(packet, "tdcc.date").id, role: "current_date", format: "date" },
      { evidenceId: "ev:tdcc:date:previous", role: "previous_date", format: "date" },
    ]),
    finding("retail-falling", "evidence_comparison", "positive", [
      { evidenceId: evidence(packet, "tdcc.retailRatio").id, role: "current", format: "value_with_unit" },
      { evidenceId: "ev:tdcc:retail:previous", role: "previous", format: "value_with_unit" },
      { evidenceId: evidence(packet, "tdcc.date").id, role: "current_date", format: "date" },
      { evidenceId: "ev:tdcc:date:previous", role: "previous_date", format: "date" },
    ]),
    finding("dividend-missing", "limitation", "insufficient", [], { limitation: {
      datasetId: "TaiwanStockDividend", reasonCode: "missing_dataset", sourceId: null, asOf: null,
    } }),
  ];
  const citations = [...new Set(findings.flatMap((item) => item.fragments.map((fragment) => fragment.evidenceId)))];
  const candidate: AIResearchReportCandidate = {
    schemaVersion: 1, stockId: packet.stockId, asOf: packet.asOf,
    contextFingerprint: packet.contextFingerprint, dataQuality: structuredClone(packet.dataQuality), findings,
    conclusion: { verdict: "positive",
      supportingFindingIds: ["institutional-positive", "strategy-buy", "whale-rising", "retail-falling"],
      opposingFindingIds: ["strategy-sell"], limitationFindingIds: ["dividend-missing"],
      aiConfidence: 0.8, investmentCertainty: null },
    citations,
    recommendation: { ...recommendation("BUY"),
      supportingFindingIds: ["institutional-positive", "strategy-buy"],
      opposingFindingIds: ["strategy-sell"], riskFindingIds: ["risk-none"] },
    valuation: peValuation(packet),
  };
  return { packet, candidate };
}

test("publication gate derives supported stances and publishes one server-grounded formal report", async () => {
  const { packet, candidate } = await publicationFixture();
  let clockCalls = 0;
  const result = gateResearchPublication(candidate, packet, { clock: () => {
    clockCalls += 1;
    return new Date("2026-08-02T04:05:06.000Z");
  } });
  assert.equal(clockCalls, 1);
  assert.equal(result.publicationReady, true);
  assert.equal(result.semanticGrounding, "server-grounded");
  assert.equal(result.draft, null);
  assert.equal(result.publishedReport?.generatedAt, "2026-08-02T04:05:06.000Z");
  assert.equal(result.publishedReport?.grounding.facts, "server-grounded");
  assert.equal(result.publishedReport?.grounding.calculations, "server-calculated");
  assert.equal(result.publishedReport?.grounding.valuationMultiples, "model-selected-bounded-assumptions");
  assert.equal(result.publishedReport?.recommendation?.confidenceGrounding, "model-estimate-unverified");
  assert.equal(result.publishedReport?.valuation?.assumptionGrounding, "model-selected-bounded-assumptions");
  assert.equal(result.publishedReport?.valuation?.scenarios[1].targetPrice, 120);
  assert.doesNotMatch(JSON.stringify(result.publishedReport), /NVIDIA_API_KEY|systemInstructions|untrustedEvidence|rawCandidate/i);
});

test("stance mismatch and semantically unsupported comparison fail closed before clock", async () => {
  const mismatch = await publicationFixture();
  mismatch.candidate.findings.find((item) => item.id === "market-neutral")!.stance = "positive";
  let calls = 0;
  const rejected = gateResearchPublication(mismatch.candidate, mismatch.packet, { clock: () => {
    calls += 1; return new Date();
  } });
  assert.equal(rejected.publicationReady, false);
  assert.equal(rejected.publishedReport, null);
  assert.ok(rejected.errors.includes("publication_stance_mismatch:market-neutral:positive:neutral"));
  assert.equal(calls, 0);

  const unsupported = await publicationFixture();
  unsupported.packet.evidence.push({ id: "ev:tdcc:shares:previous", dataset: "tdcc_shareholding",
    field: "tdcc.totalShares", value: 900, unit: "shares", date: "2026-07-24",
    sourceId: evidence(unsupported.packet, "tdcc.totalShares").sourceId, estimated: false, available: true });
  const unsupportedFinding = finding("shares-comparison", "evidence_comparison", "positive", [
    { evidenceId: evidence(unsupported.packet, "tdcc.totalShares").id, role: "current", format: "value_with_unit" },
    { evidenceId: "ev:tdcc:shares:previous", role: "previous", format: "value_with_unit" },
    { evidenceId: evidence(unsupported.packet, "tdcc.date").id, role: "current_date", format: "date" },
    { evidenceId: "ev:tdcc:date:previous", role: "previous_date", format: "date" },
  ]);
  unsupported.candidate.findings.push(unsupportedFinding);
  unsupported.candidate.citations = [...new Set([...unsupported.candidate.citations,
    ...unsupportedFinding.fragments.map((item) => item.evidenceId)])];
  const unverified = gateResearchPublication(unsupported.candidate, unsupported.packet, { clock: () => new Date() });
  assert.equal(unverified.publicationReady, false);
  assert.ok(unverified.errors.includes("publication_stance_unverifiable:shares-comparison"));
});

test("server-derived recommendation enforces base return and high-risk veto", async () => {
  const mismatch = await publicationFixture();
  mismatch.candidate.recommendation = { ...mismatch.candidate.recommendation!, verdict: "HOLD" };
  mismatch.candidate.conclusion.verdict = "neutral";
  const wrongVerdict = gateResearchPublication(mismatch.candidate, mismatch.packet, { clock: () => new Date() });
  assert.equal(wrongVerdict.publicationReady, false);
  assert.ok(wrongVerdict.errors.includes("publication_recommendation_mismatch:HOLD:BUY"));

  const vetoed = await publicationFixture();
  vetoed.packet.tradeRisks.highestLevel = "high";
  evidence(vetoed.packet, "tradeRisks.highestLevel").value = "high";
  vetoed.candidate.findings.find((item) => item.id === "risk-none")!.stance = "negative";
  const riskVeto = gateResearchPublication(vetoed.candidate, vetoed.packet, { clock: () => new Date() });
  assert.equal(riskVeto.publicationReady, false);
  assert.ok(riskVeto.errors.includes("publication_recommendation_risk_veto:BUY:high"));
});

test("trade risk none medium high and critical have deterministic server stances", async () => {
  for (const level of ["none", "medium", "high", "critical"] as const) {
    const fixture = await publicationFixture();
    fixture.packet.tradeRisks.highestLevel = level;
    evidence(fixture.packet, "tradeRisks.highestLevel").value = level;
    fixture.candidate.findings.find((item) => item.id === "risk-none")!.stance = level === "none" ? "neutral" : "negative";
    const result = gateResearchPublication(fixture.candidate, fixture.packet, { clock: () =>
      new Date("2026-08-02T04:05:06.000Z") });
    assert.equal(result.errors.some((error) => error.startsWith("publication_stance_")), false, level);
    assert.equal(result.publicationReady, level === "none" || level === "medium", level);
    if (level === "high" || level === "critical") {
      assert.ok(result.errors.includes(`publication_recommendation_risk_veto:BUY:${level}`));
    }
  }
});

test("trusted clock is called only after every gate and invalid throw or candidate timestamps fail closed", async () => {
  for (const clock of [() => new Date("invalid"), () => { throw new Error("clock-secret"); }]) {
    const fixture = await publicationFixture();
    let calls = 0;
    const result = gateResearchPublication(fixture.candidate, fixture.packet, { clock: () => {
      calls += 1; return clock();
    } });
    assert.equal(calls, 1);
    assert.equal(result.publicationReady, false);
    assert.equal(result.publishedReport, null);
    assert.ok(result.errors.includes("publication_clock_invalid"));
    assert.doesNotMatch(JSON.stringify(result), /clock-secret/);
  }
  const fixture = await publicationFixture();
  let calls = 0;
  const result = gateResearchPublication({ ...fixture.candidate,
    generatedAt: "2099-01-01T00:00:00.000Z" } as unknown as AIResearchReportCandidate,
  fixture.packet, { clock: () => { calls += 1; return new Date(); } });
  assert.equal(result.publicationReady, false);
  assert.equal(calls, 0);
  assert.ok(result.errors.includes("invalid_report_field:generatedAt"));
});

test("stale supporting opposing or risk evidence blocks publication before clock", async () => {
  for (const stale of ["stock_institutional", "supabase:stock_institutional"] as const) {
    const fixture = await publicationFixture();
    fixture.packet.dataQuality.staleDatasets = [stale];
    fixture.candidate.dataQuality = structuredClone(fixture.packet.dataQuality);
    let calls = 0;
    const result = gateResearchPublication(fixture.candidate, fixture.packet, { clock: () => {
      calls += 1; return new Date();
    } });
    assert.equal(result.publicationReady, false, stale);
    assert.ok(result.errors.includes("publication_material_finding_stale:institutional-positive"), stale);
    assert.equal(calls, 0, stale);
  }
});

test("published conclusion is rebuilt from every derived material finding instead of candidate cherry-picks", async () => {
  const fixture = await publicationFixture();
  fixture.candidate.conclusion.supportingFindingIds = ["institutional-positive", "strategy-buy"];
  fixture.candidate.conclusion.opposingFindingIds = ["strategy-sell"];
  const result = gateResearchPublication(fixture.candidate, fixture.packet, { clock: () =>
    new Date("2026-08-02T04:05:06.000Z") });
  assert.equal(result.publicationReady, true);
  assert.deepEqual(result.publishedReport?.conclusionFindingIds.supporting,
    ["institutional-positive", "retail-falling", "strategy-buy", "whale-rising"]);
  assert.deepEqual(result.publishedReport?.conclusionFindingIds.opposing,
    ["institutional-negative", "strategy-sell"]);
  assert.deepEqual(result.publishedReport?.conclusionFindingIds.limitations, ["dividend-missing"]);
  for (const id of ["retail-falling", "whale-rising", "institutional-negative"]) {
    assert.match(result.publishedReport?.conclusion ?? "", new RegExp(id.replace("-", "\\-")));
  }
});

test("non-none canonical trade risk cannot be omitted or replaced by a limitation", async () => {
  const fixture = await publicationFixture();
  fixture.packet.tradeRisks.highestLevel = "medium";
  evidence(fixture.packet, "tradeRisks.highestLevel").value = "medium";
  const risk = fixture.candidate.findings.find((item) => item.id === "risk-none")!;
  fixture.candidate.findings = fixture.candidate.findings.filter((item) => item !== risk);
  fixture.candidate.citations = fixture.candidate.citations.filter((id) =>
    !risk.fragments.some((fragment) => fragment.evidenceId === id));
  fixture.candidate.recommendation!.riskFindingIds = ["dividend-missing"];
  let calls = 0;
  const result = gateResearchPublication(fixture.candidate, fixture.packet, { clock: () => {
    calls += 1; return new Date();
  } });
  assert.equal(result.publicationReady, false);
  assert.ok(result.errors.includes("publication_trade_risk_finding_required:medium"));
  assert.equal(calls, 0);
});

test("institutional comparison ignores date segments and counts as institutional domain", async () => {
  const fixture = await publicationFixture();
  const sourceId = evidence(fixture.packet, "institutional.2026-07-31.trustNet").sourceId;
  fixture.packet.evidence.push({ id: "ev:institutional:trust-previous", dataset: "stock_institutional",
    field: "institutional.2026-07-30.trustNet", value: 5, unit: "shares", date: "2026-07-30",
    sourceId, estimated: false, available: true });
  const comparison = finding("institutional-rising", "evidence_comparison", "positive", [
    { evidenceId: evidence(fixture.packet, "institutional.2026-07-31.trustNet").id, role: "current", format: "value_with_unit" },
    { evidenceId: "ev:institutional:trust-previous", role: "previous", format: "value_with_unit" },
    { evidenceId: evidence(fixture.packet, "institutional.2026-07-31.date").id, role: "current_date", format: "date" },
    { evidenceId: "ev:institutional:negative-date", role: "previous_date", format: "date" },
  ]);
  fixture.candidate.findings.push(comparison);
  fixture.candidate.citations = [...new Set([...fixture.candidate.citations,
    ...comparison.fragments.map((item) => item.evidenceId)])];
  fixture.candidate.recommendation!.supportingFindingIds = ["institutional-rising", "strategy-buy"];
  const result = gateResearchPublication(fixture.candidate, fixture.packet, { clock: () =>
    new Date("2026-08-02T04:05:06.000Z") });
  assert.equal(result.publicationReady, true, JSON.stringify(result.errors));
  assert.equal(result.publishedReport?.claims.find((item) => item.id === "institutional-rising")?.stance, "positive");
});

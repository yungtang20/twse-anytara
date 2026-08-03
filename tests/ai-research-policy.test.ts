import assert from "node:assert/strict";
import test from "node:test";
import { ResearchContextAggregator } from "../server/lib/researchContext.js";
import type { AIResearchPacket } from "../shared/aiResearch.js";
import { createResearchContextAdapter } from "./helpers/research-context-fixtures.js";

type Fragment = { evidenceId: string; role: string; format: string; [key: string]: unknown };
type Finding = {
  id: string; kind: string; stance: string; strategyId?: string; fragments: Fragment[];
  limitations?: unknown; limitation?: unknown; [key: string]: unknown;
};

async function packetFixture(): Promise<AIResearchPacket> {
  const context = await new ResearchContextAggregator(createResearchContextAdapter(), {
    clock: () => new Date("2026-08-02T03:04:05.000Z"), asOfDate: "2026-07-31",
  }).aggregate("2330");
  const { buildResearchPacket } = await import("../server/lib/aiResearchPacket.js");
  return buildResearchPacket(context);
}

function evidence(packet: AIResearchPacket, field: string) {
  const item = packet.evidence.find((candidate) => candidate.field === field);
  assert.ok(item, field);
  return item;
}

function marketFinding(packet: AIResearchPacket, overrides: Partial<Finding> = {}): Finding {
  return {
    id: "market", kind: "market_snapshot", stance: "positive",
    fragments: [
      { evidenceId: evidence(packet, "market.price").id, role: "value", format: "value_with_unit" },
      { evidenceId: evidence(packet, "market.latestDate").id, role: "date", format: "date" },
    ],
    ...overrides,
  };
}

function report(packet: AIResearchPacket, findings: Finding[], overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1, stockId: packet.stockId,
    asOf: packet.asOf, contextFingerprint: packet.contextFingerprint, dataQuality: packet.dataQuality,
    findings,
    conclusion: {
      verdict: "neutral",
      supportingFindingIds: findings.filter((item) => item.stance === "positive").map((item) => item.id),
      opposingFindingIds: findings.filter((item) => item.stance === "negative").map((item) => item.id),
      limitationFindingIds: findings.filter((item) => item.kind === "limitation").map((item) => item.id),
      aiConfidence: 0.5, investmentCertainty: null,
    },
    citations: [...new Set(findings.flatMap((item) => item.fragments.map((fragment) => fragment.evidenceId)))],
    ...overrides,
  };
}

async function audit(candidate: unknown, packet: AIResearchPacket) {
  const { auditResearchReport } = await import("../server/lib/aiResearchReportAuditor.js");
  return auditResearchReport(candidate, packet);
}

test("free-text limitation injection fails structurally while only true prohibited claims are classified", async () => {
  const packet = await packetFixture();
  for (const injected of [
    "公司已破產，應立即賣出", "公司涉及舞弊", "建議買進，目標價 1000 元",
  ]) {
    const limitation: Finding = {
      id: "limitation", kind: "limitation", stance: "insufficient", fragments: [], limitations: [injected],
    };
    const result = await audit(report(packet, [marketFinding(packet), limitation]), packet);
    assert.equal(result.mechanicalPassed, false, injected);
    assert.equal(result.publicationReady, false, injected);
    assert.equal(result.semanticGrounding, "unverified", injected);
    if (/破產|舞弊/.test(injected)) assert.ok(result.prohibitedClaims.includes(injected), injected);
    else assert.deepEqual(result.prohibitedClaims, [], injected);
  }
});

test("limitations on factual findings and nested metadata cannot smuggle raw claims", async () => {
  const packet = await packetFixture();
  for (const finding of [
    marketFinding(packet, { limitations: ["公司已破產"] }),
    marketFinding(packet, { metadata: { conclusion: "涉及舞弊，建議賣出" } }),
  ]) {
    const result = await audit(report(packet, [finding]), packet);
    assert.equal(result.mechanicalPassed, false);
    assert.ok(result.prohibitedClaims.length > 0);
  }
});

test("mechanical reference validation never implies publication or semantic verification", async () => {
  const packet = await packetFixture();
  const result = await audit(report(packet, [marketFinding(packet)]), packet);
  assert.equal(result.mechanicalPassed, true);
  assert.equal(result.publicationReady, false);
  assert.equal(result.semanticGrounding, "unverified");
});

test("field role format cardinality and estimated policy fail closed", async () => {
  const packet = await packetFixture();
  const price = evidence(packet, "market.price").id;
  const date = evidence(packet, "market.latestDate").id;
  const asOf = evidence(packet, "asOf").id;
  const companyName = evidence(packet, "company.name").id;
  const cases: Finding[] = [
    marketFinding(packet, { fragments: [{ evidenceId: price, role: "date", format: "date" }, { evidenceId: date, role: "date", format: "date" }] }),
    marketFinding(packet, { fragments: [{ evidenceId: price, role: "value", format: "value_with_unit" }, { evidenceId: date, role: "date", format: "value_with_unit" }] }),
    { id: "company", kind: "company_fact", stance: "neutral", fragments: [{ evidenceId: companyName, role: "subject", format: "value_with_unit" }] },
    marketFinding(packet, { fragments: [{ evidenceId: price, role: "value", format: "value_with_unit" }, { evidenceId: date, role: "value", format: "date" }] }),
    marketFinding(packet, { fragments: [{ evidenceId: price, role: "value", format: "value_with_unit" }] }),
    marketFinding(packet, { fragments: [{ evidenceId: price, role: "value", format: "value_with_unit" }, { evidenceId: date, role: "date", format: "date" }, { evidenceId: asOf, role: "date", format: "date" }] }),
    marketFinding(packet, { fragments: [{ evidenceId: price, role: "value", format: "value_with_unit" }, { evidenceId: asOf, role: "date", format: "date" }] }),
  ];
  const estimated = structuredClone(packet);
  evidence(estimated, "market.price").estimated = true;
  for (const finding of cases) assert.equal((await audit(report(packet, [finding]), packet)).mechanicalPassed, false);
  assert.equal((await audit(report(estimated, [marketFinding(estimated)]), estimated)).mechanicalPassed, false);
});

function comparisonPacket(packet: AIResearchPacket, options: {
  currentField?: string; previousField?: string; currentUnit?: string; previousUnit?: string;
  currentDate?: string | null; previousDate?: string | null; currentValue?: number | string; previousValue?: number | string;
}) {
  const clone = structuredClone(packet);
  const currentDate = Object.hasOwn(options, "currentDate") ? options.currentDate ?? null : "2026-07-31";
  const previousDate = Object.hasOwn(options, "previousDate") ? options.previousDate ?? null : "2026-07-24";
  const tdccSource = evidence(packet, "tdcc.whaleRatio").sourceId;
  const strategySource = evidence(packet, "strategies.ma.confidence").sourceId;
  clone.evidence.push(
    { id: "ev:cmp-current", dataset: "tdcc_shareholding", field: options.currentField ?? "tdcc.whaleRatio",
      value: options.currentValue ?? 52.3, unit: options.currentUnit ?? "%", date: currentDate,
      sourceId: tdccSource, estimated: false, available: true },
    { id: "ev:cmp-previous", dataset: options.previousField?.startsWith("strategies.") ? "strategy_ma" : "tdcc_shareholding",
      field: options.previousField ?? "tdcc.whaleRatio", value: options.previousValue ?? 0.5,
      unit: options.previousUnit ?? "ratio", date: previousDate,
      sourceId: options.previousField?.startsWith("strategies.") ? strategySource : tdccSource,
      estimated: false, available: true },
  );
  return clone;
}

function comparisonFinding(): Finding {
  return { id: "comparison", kind: "evidence_comparison", stance: "neutral", fragments: [
    { evidenceId: "ev:cmp-current", role: "current", format: "value_with_unit" },
    { evidenceId: "ev:cmp-previous", role: "previous", format: "value_with_unit" },
  ] };
}

test("comparison rejects semantic, dimension, date, unit, and role mismatches", async () => {
  const base = await packetFixture();
  const cases = [
    comparisonPacket(base, { previousField: "strategies.ma.confidence", previousValue: 0, previousUnit: "ratio" }),
    comparisonPacket(base, { currentField: "market.price", previousField: "institutional.2026-07-31.foreignNet", currentUnit: "TWD", previousUnit: "shares" }),
    comparisonPacket(base, { previousField: "tdcc.totalShares", previousUnit: "shares" }),
    comparisonPacket(base, { currentDate: null, previousDate: null }),
    comparisonPacket(base, { currentDate: "2099-01-01" }),
    comparisonPacket(base, { currentField: "tdcc.source", previousField: "tdcc.source", currentUnit: "", previousUnit: "", currentValue: "tdcc", previousValue: "other" }),
  ];
  for (const packet of cases) {
    assert.equal((await audit(report(packet, [comparisonFinding()]), packet)).mechanicalPassed, false);
  }
  for (const fragments of [
    [{ evidenceId: "ev:cmp-current", role: "previous", format: "value_with_unit" }, { evidenceId: "ev:cmp-previous", role: "current", format: "value_with_unit" }],
    [{ evidenceId: "ev:cmp-current", role: "current", format: "value_with_unit" }, { evidenceId: "ev:cmp-previous", role: "current", format: "value_with_unit" }],
  ]) {
    const packet = comparisonPacket(base, {});
    assert.equal((await audit(report(packet, [{ ...comparisonFinding(), fragments }]), packet)).mechanicalPassed, false);
  }
});

test("comparison safely normalizes percent and ratio for the same metric with ordered dates", async () => {
  const packet = comparisonPacket(await packetFixture(), {});
  const tdccSource = evidence(packet, "tdcc.whaleRatio").sourceId;
  const currentDate = evidence(packet, "tdcc.date");
  packet.evidence.push({ id: "ev:cmp-previous-date", dataset: "tdcc_shareholding", field: "tdcc.date",
    value: "2026-07-24", unit: "date", date: "2026-07-24", sourceId: tdccSource,
    estimated: false, available: true });
  const finding = { ...comparisonFinding(), fragments: [
    { evidenceId: "ev:cmp-current", role: "current", format: "value_with_unit" },
    { evidenceId: "ev:cmp-previous", role: "previous", format: "value_with_unit" },
    { evidenceId: currentDate.id, role: "current_date", format: "date" },
    { evidenceId: "ev:cmp-previous-date", role: "previous_date", format: "date" },
  ] };
  const result = await audit(report(packet, [finding]), packet);
  assert.equal(result.mechanicalPassed, true);
  assert.equal(result.publicationReady, false);
  assert.match(result.draft?.claims[0].text ?? "", /52\.3%/);
  assert.match(result.draft?.claims[0].text ?? "", /50%/);
  assert.match(result.draft?.claims[0].text ?? "", /上升/);
});

test("conclusion references must agree with finding stance and verdict", async () => {
  const packet = await packetFixture();
  const positive = marketFinding(packet, { id: "positive", stance: "positive" });
  const neutral = marketFinding(packet, { id: "neutral", stance: "neutral" });
  const negative = marketFinding(packet, { id: "negative", stance: "negative" });
  const cases = [
    { findings: [neutral], conclusion: { verdict: "neutral", supportingFindingIds: ["neutral"], opposingFindingIds: [], limitationFindingIds: [], aiConfidence: 0.5, investmentCertainty: null } },
    { findings: [positive], conclusion: { verdict: "neutral", supportingFindingIds: [], opposingFindingIds: ["positive"], limitationFindingIds: [], aiConfidence: 0.5, investmentCertainty: null } },
    { findings: [positive, negative], conclusion: { verdict: "neutral", supportingFindingIds: ["positive"], opposingFindingIds: ["negative", "positive"], limitationFindingIds: [], aiConfidence: 0.5, investmentCertainty: null } },
    { findings: [positive], conclusion: { verdict: "insufficient-data", supportingFindingIds: ["positive"], opposingFindingIds: [], limitationFindingIds: [], aiConfidence: 0, investmentCertainty: 0 } },
  ];
  for (const item of cases) {
    const result = await audit(report(packet, item.findings, { conclusion: item.conclusion }), packet);
    assert.equal(result.mechanicalPassed, false);
  }
});

test("Richness C requires a structured and conclusion-referenced published limitation", async () => {
  const packet = structuredClone(await packetFixture());
  packet.dataQuality.informationRichness = "C";
  packet.dataQuality.status = "partial";
  packet.dataQuality.missingDatasets = ["financials"];
  packet.dataQuality.staleDatasets = ["stock_institutional"];
  const rawMetadata = marketFinding(packet, { limitations: ["financials"] });
  const metadataOnly = report(packet, [rawMetadata], { conclusion: {
    verdict: "insufficient-data", supportingFindingIds: ["market"], opposingFindingIds: [],
    limitationFindingIds: [], aiConfidence: 0, investmentCertainty: null,
  } });
  assert.equal((await audit(metadataOnly, packet)).mechanicalPassed, false);

  const limitation: Finding = { id: "missing-financials", kind: "limitation", stance: "insufficient", fragments: [],
    limitation: { datasetId: "financials", reasonCode: "missing_dataset", sourceId: null, asOf: null } };
  const institutionalSource = packet.sources.find((source) => source.dataset === "stock_institutional");
  assert.ok(institutionalSource);
  const staleLimitation: Finding = { id: "stale-institutional", kind: "limitation", stance: "insufficient", fragments: [],
    limitation: { datasetId: "stock_institutional", reasonCode: "stale_dataset",
      sourceId: institutionalSource.id, asOf: institutionalSource.asOf } };
  const valid = report(packet, [marketFinding(packet), limitation, staleLimitation], { conclusion: {
    verdict: "insufficient-data", supportingFindingIds: ["market"], opposingFindingIds: [],
    limitationFindingIds: ["missing-financials", "stale-institutional"], aiConfidence: 0, investmentCertainty: null,
  } });
  const validResult = await audit(valid, packet);
  assert.equal(validResult.mechanicalPassed, true);
  assert.equal(validResult.publicationReady, false);
  assert.match(validResult.draft?.conclusion ?? "", /financials|財務/);

  const unreferenced = structuredClone(valid);
  unreferenced.conclusion.limitationFindingIds = [];
  assert.equal((await audit(unreferenced, packet)).mechanicalPassed, false);
});

test("direct renderer rejects duplicate registries and every invalid finding policy", async () => {
  const packet = await packetFixture();
  const { renderResearchFinding } = await import("../server/lib/aiResearchFindingRenderer.js");
  const duplicate = structuredClone(packet);
  duplicate.evidence.push({ ...duplicate.evidence[0] });
  assert.throws(() => renderResearchFinding(marketFinding(duplicate) as never, duplicate), /duplicate_evidence/);
  const collision = structuredClone(packet);
  collision.evidence.push({ ...collision.evidence[0], value: "collision" });
  assert.throws(() => renderResearchFinding(marketFinding(collision) as never, collision), /collision/);
  const unauthorized: Finding = { id: "bad-limitation", kind: "limitation", stance: "insufficient", fragments: [],
    limitation: { datasetId: "financials", reasonCode: "company_bankrupt", sourceId: null, asOf: null } };
  assert.throws(() => renderResearchFinding(unauthorized as never, packet), /limitation|reason/);
  assert.throws(() => renderResearchFinding(marketFinding(packet, { fragments: [{ evidenceId: "unknown", role: "value", format: "value" }] }) as never, packet), /not_found/);
  const unavailable = structuredClone(packet);
  evidence(unavailable, "market.price").available = false;
  evidence(unavailable, "market.price").value = null;
  assert.throws(() => renderResearchFinding(marketFinding(unavailable) as never, unavailable), /unavailable/);
  assert.throws(() => renderResearchFinding(marketFinding(packet, { fragments: [
    { evidenceId: evidence(packet, "market.price").id, role: "date", format: "date" },
    { evidenceId: evidence(packet, "market.latestDate").id, role: "date", format: "date" },
  ] }) as never, packet), /policy_mismatch/);
  const estimated = structuredClone(packet);
  evidence(estimated, "market.price").estimated = true;
  assert.throws(() => renderResearchFinding(marketFinding(estimated) as never, estimated), /estimated_not_allowed/);
  const estimatedFinancial = structuredClone(packet);
  const eps = evidence(estimatedFinancial, "fundamentals.metrics.eps");
  eps.value = 13.94;
  eps.available = true;
  eps.estimated = true;
  const renderedEstimate = renderResearchFinding({ id: "estimated-eps", kind: "financial_metric", stance: "neutral",
    fragments: [{ evidenceId: eps.id, role: "value", format: "value_with_unit" }] } as never, estimatedFinancial);
  assert.equal(renderedEstimate.estimated, true);
  assert.match(renderedEstimate.text, /估算/);
  const incompatible = comparisonPacket(packet, { previousField: "strategies.ma.confidence" });
  assert.throws(() => renderResearchFinding(comparisonFinding() as never, incompatible), /comparison/);
});

test("top-level and nested unknown keys fail while only unsafe strings are prohibited", async () => {
  const packet = await packetFixture();
  const top = { ...report(packet, [marketFinding(packet)]), metadata: { note: "目標價 1000 元，建議買進" } };
  const nested = report(packet, [marketFinding(packet, { tools: { instruction: "公司涉及舞弊，應賣出" } })]);
  const topResult = await audit(top, packet);
  assert.equal(topResult.mechanicalPassed, false);
  assert.deepEqual(topResult.prohibitedClaims, []);
  const nestedResult = await audit(nested, packet);
  assert.equal(nestedResult.mechanicalPassed, false);
  assert.ok(nestedResult.prohibitedClaims.length > 0);
});

test("policy auditor and renderer make zero network or provider calls under global fetch deny", async () => {
  const packet = await packetFixture();
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => { calls += 1; throw new Error("network_denied"); }) as typeof fetch;
  try {
    const result = await audit(report(packet, [marketFinding(packet)]), packet);
    assert.equal(result.mechanicalPassed, true);
    const { renderResearchFinding } = await import("../server/lib/aiResearchFindingRenderer.js");
    renderResearchFinding(marketFinding(packet) as never, packet);
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

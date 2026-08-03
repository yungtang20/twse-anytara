import assert from "node:assert/strict";
import test from "node:test";
import { ResearchContextAggregator } from "../server/lib/researchContext.js";
import type { AIResearchPacket, ResearchLimitationReasonCode } from "../shared/aiResearch.js";
import { createResearchContextAdapter } from "./helpers/research-context-fixtures.js";

type FindingKind = "company_fact" | "market_snapshot" | "financial_metric" | "institutional_flow"
  | "tdcc_concentration" | "trade_risk" | "strategy_result" | "evidence_comparison" | "limitation";
type Finding = {
  id: string; kind: FindingKind; stance: "positive" | "neutral" | "negative" | "insufficient";
  strategyId?: "sr" | "ma" | "chips" | "pattern";
  fragments: Array<{ evidenceId: string; role: "subject" | "value" | "current" | "previous" | "date" | "risk";
    format: "value" | "value_with_unit" | "date" | "label" }>;
  limitation?: { datasetId: string; reasonCode: ResearchLimitationReasonCode; sourceId: string | null; asOf: string | null };
  [key: string]: unknown;
};
type Candidate = {
  schemaVersion: 1; stockId: string; asOf: string | null;
  contextFingerprint: string; dataQuality: AIResearchPacket["dataQuality"];
  findings: Finding[];
  conclusion: {
    verdict: "positive" | "neutral" | "negative" | "insufficient-data";
    supportingFindingIds: string[]; opposingFindingIds: string[]; limitationFindingIds: string[];
    aiConfidence: number | null; investmentCertainty: number | null;
    [key: string]: unknown;
  };
  citations: unknown[];
  [key: string]: unknown;
};
type Audit = {
  mechanicalPassed: boolean; publicationReady: boolean;
  semanticGrounding: "structured-evidence-verified" | "unverified";
  errors: string[];
  draft: null | { claims: Array<{ id: string; text: string; evidenceIds: string[]; estimated: boolean }> };
};

async function packetFixture(mutator?: (context: Awaited<ReturnType<typeof contextFixture>>) => void) {
  const context = await contextFixture();
  mutator?.(context);
  const { buildResearchPacket } = await import("../server/lib/aiResearchPacket.js");
  return buildResearchPacket(context);
}

async function contextFixture() {
  return new ResearchContextAggregator(createResearchContextAdapter(), {
    clock: () => new Date("2026-08-02T03:04:05.000Z"), asOfDate: "2026-07-31",
  }).aggregate("2330");
}

const evidenceByField = (packet: AIResearchPacket, field: string) => {
  const evidence = packet.evidence.find((item) => item.field === field);
  assert.ok(evidence, field);
  return evidence;
};

function finding(id: string, kind: FindingKind, evidenceIds: string[], overrides: Partial<Finding> = {}): Finding {
  return {
    id, kind, stance: "neutral",
    fragments: evidenceIds.map((evidenceId) => ({ evidenceId, role: "value", format: "value_with_unit" })),
    ...overrides,
  };
}

function candidate(packet: AIResearchPacket, findings: Finding[]): Candidate {
  return {
    schemaVersion: 1, stockId: packet.stockId,
    asOf: packet.asOf, contextFingerprint: packet.contextFingerprint, dataQuality: packet.dataQuality,
    findings,
    conclusion: {
      verdict: "neutral", supportingFindingIds: findings.filter((item) => item.stance === "positive").map((item) => item.id),
      opposingFindingIds: findings.filter((item) => item.stance === "negative").map((item) => item.id),
      limitationFindingIds: findings.filter((item) => item.kind === "limitation").map((item) => item.id),
      aiConfidence: 0.5, investmentCertainty: null,
    },
    citations: [...new Set(findings.flatMap((item) => item.fragments.map((fragment) => fragment.evidenceId)))],
  };
}

const audit = async (report: unknown, packet: AIResearchPacket): Promise<Audit> => {
  const { auditResearchReport } = await import("../server/lib/aiResearchReportAuditor.js");
  return auditResearchReport(report, packet) as unknown as Audit;
};

test("P0 bankruptcy and governance-fraud raw facts cannot be grounded by market price", async () => {
  const packet = await packetFixture();
  const price = evidenceByField(packet, "market.price").id;
  for (const [id, text] of [["bankrupt", "公司已經破產"], ["fraud", "公司治理存在重大舞弊"]] as const) {
    const raw = finding(id, "market_snapshot", [price], { text });
    const result = await audit(candidate(packet, [raw]), packet);
    assert.equal(result.publicationReady, false);
    assert.equal(result.semanticGrounding, "unverified");
    assert.ok(result.errors.includes(`raw_factual_text_forbidden:${id}`));
  }
  const otherwiseValid = candidate(packet, [finding("market", "market_snapshot", [price])]);
  const topLevelSmuggle = { ...otherwiseValid, bullCase: [{ text: "公司已經破產", evidenceIds: [price] }] };
  const smuggledResult = await audit(topLevelSmuggle, packet);
  assert.equal(smuggledResult.publicationReady, false);
  assert.ok(smuggledResult.errors.includes("invalid_report_field:bullCase"));
});

test("kind and dataset allowlist rejects financial, risk, and strategy cross-domain citations", async () => {
  const packet = await packetFixture();
  const tdcc = evidenceByField(packet, "tdcc.whaleRatio").id;
  const price = evidenceByField(packet, "market.price").id;
  const ma = evidenceByField(packet, "strategies.ma.status").id;
  for (const item of [
    finding("financial-tdcc", "financial_metric", [tdcc]),
    finding("risk-price", "trade_risk", [price]),
    finding("sr-ma", "strategy_result", [ma], { strategyId: "sr" }),
  ]) {
    const result = await audit(candidate(packet, [item]), packet);
    assert.equal(result.publicationReady, false);
    assert.ok(result.errors.some((error) => /finding_(?:domain|policy|measurement)_mismatch/.test(error)));
  }
});

test("strict arrays reject mixed citations, malformed fragments, and non-string limitations", async () => {
  const packet = await packetFixture();
  const price = evidenceByField(packet, "market.price").id;
  const valid = finding("market", "market_snapshot", [price]);
  const injectedFragment = ({ evidenceId: price, role: "value", format: "value", extra: true } as unknown) as Finding["fragments"][number];
  for (const malformed of [
    { ...candidate(packet, [valid]), citations: [price, 123, null, {}] },
    candidate(packet, [{ ...valid, fragments: [injectedFragment] }]),
    candidate(packet, [{ ...valid, limitations: ["ok", 123] }]),
  ]) {
    const result = await audit(malformed, packet);
    assert.equal(result.mechanicalPassed, false);
    assert.ok(result.errors.some((error) => /invalid_(?:citations|fragment|finding)/.test(error)), JSON.stringify(result.errors));
  }
});

test("conclusion references must exist, be unique, and candidate audit or summary is forbidden", async () => {
  const packet = await packetFixture();
  const price = evidenceByField(packet, "market.price").id;
  const valid = candidate(packet, [finding("market", "market_snapshot", [price])]);
  const missing = structuredClone(valid);
  missing.conclusion.supportingFindingIds = ["missing"];
  const duplicate = structuredClone(valid);
  duplicate.conclusion.supportingFindingIds = ["market", "market"];
  const forged = { ...valid, audit: { publicationReady: true }, conclusion: { ...valid.conclusion, summary: "公司已破產" } };
  for (const report of [missing, duplicate, forged]) {
    const result = await audit(report, packet);
    assert.equal(result.publicationReady, false);
  }
  assert.ok((await audit(missing, packet)).errors.includes("unknown_conclusion_finding:missing"));
  assert.ok((await audit(duplicate, packet)).errors.includes("duplicate_conclusion_finding:market"));
  assert.ok((await audit(forged, packet)).errors.includes("candidate_audit_forbidden"));
  assert.ok((await audit(forged, packet)).errors.includes("raw_conclusion_summary_forbidden"));
});

test("citations must exactly equal the unique fragment evidence set", async () => {
  const packet = await packetFixture();
  const price = evidenceByField(packet, "market.price").id;
  const date = evidenceByField(packet, "market.latestDate").id;
  const stockId = evidenceByField(packet, "stockId").id;
  const market = finding("market", "market_snapshot", [], { fragments: [
    { evidenceId: price, role: "value", format: "value_with_unit" },
    { evidenceId: date, role: "date", format: "date" },
  ] });
  const valid = candidate(packet, [market]);
  for (const citations of [[], [price, date, stockId], [price, date, price]]) {
    const result = await audit({ ...valid, citations }, packet);
    assert.equal(result.mechanicalPassed, false);
    assert.ok(result.errors.includes("citations_fragment_set_mismatch") || result.errors.includes(`duplicate_citation:${price}`),
      JSON.stringify(result.errors));
  }
});

test("company evidence uses stock_meta source asOf and preserves null provenance date", async () => {
  const packet = await packetFixture((context) => {
    const source = context.sources.find((item) => item.dataset === "stock_meta");
    assert.ok(source);
    source.asOf = null;
  });
  assert.equal(evidenceByField(packet, "company.name").date, null);
  assert.equal(evidenceByField(packet, "stockId").date, null);
});

test("trade-risk timestamp normalizes to date with documented priority", async () => {
  const packet = await packetFixture((context) => {
    context.tradeRisks = {
      highestLevel: "medium", dataAsOf: "2026-08-01", flags: [{
        risk_type: "attention", announced_date: "2026-07-29", start_date: "2026-07-30",
        source_updated_at: "2026-07-31T23:30:00+08:00", reason: "test",
      }],
    };
  });
  const risk = packet.evidence.filter((item) => item.field.startsWith("tradeRisks.flags.0."));
  assert.ok(risk.length > 0);
  assert.ok(risk.every((item) => item.date === "2026-07-31"));
  assert.equal(evidenceByField(packet, "tradeRisks.flags.0.source_updated_at").value, "2026-07-31");
});

test("trusted renderer permits only policy-authorized estimates and refuses unavailable evidence", async () => {
  const { renderResearchFinding } = await import("../server/lib/aiResearchFindingRenderer.js");
  const estimated = await packetFixture((context) => {
    const source = context.sources.find((item) => item.dataset === "stock_price");
    assert.ok(source);
    source.estimated = true;
  });
  const price = evidenceByField(estimated, "market.price");
  const date = evidenceByField(estimated, "market.latestDate");
  const estimatedMarket = finding("estimated", "market_snapshot", [price.id, date.id], { fragments: [
    { evidenceId: price.id, role: "value", format: "value_with_unit" },
    { evidenceId: date.id, role: "date", format: "date" },
  ] });
  assert.throws(() => renderResearchFinding(estimatedMarket, estimated), /estimated_not_allowed/);
  const unavailable = structuredClone(estimated);
  const target = unavailable.evidence.find((item) => item.id === price.id);
  assert.ok(target);
  target.available = false;
  target.value = null;
  assert.throws(() => renderResearchFinding(estimatedMarket, unavailable), /finding_evidence_unavailable/);
});

test("legacy two-fragment comparison is rejected by the fixed comparison contract", async () => {
  const packet = await packetFixture();
  const price = evidenceByField(packet, "market.price").id;
  const ratio = evidenceByField(packet, "tdcc.whaleRatio").id;
  const comparison = finding("comparison", "evidence_comparison", [price, ratio]);
  const result = await audit(candidate(packet, [comparison]), packet);
  assert.equal(result.publicationReady, false);
  assert.ok(result.errors.some((error) => error.startsWith("comparison_")));
});

test("richness C forces insufficient-data and empty findings are never publication ready", async () => {
  const packet = await packetFixture((context) => {
    context.quality.status = "partial";
    context.quality.missingDatasets = ["financials", "stock_institutional", "tdcc_shareholding"];
    context.fundamentals.status = "unavailable";
    context.institutional.dailyFlows = [];
    context.tdcc.totalShares = null;
    context.tdcc.whaleRatio = null;
  });
  assert.equal(packet.dataQuality.informationRichness, "C");
  const price = evidenceByField(packet, "market.price").id;
  const wrong = candidate(packet, [finding("market", "market_snapshot", [price])]);
  assert.ok((await audit(wrong, packet)).errors.includes("richness_c_requires_insufficient_data_verdict"));
  const empty = candidate(packet, []);
  empty.conclusion.verdict = "insufficient-data";
  const emptyResult = await audit(empty, packet);
  assert.equal(emptyResult.publicationReady, false);
  assert.ok(emptyResult.errors.includes("empty_findings"));
});

test("valid structured report passes mechanically but remains unpublished and semantically unverified", async () => {
  const packet = await packetFixture();
  const stock = finding("company", "company_fact", [evidenceByField(packet, "company.name").id], {
    fragments: [{ evidenceId: evidenceByField(packet, "company.name").id, role: "subject", format: "label" }],
  });
  const market = finding("market", "market_snapshot", [evidenceByField(packet, "market.price").id,
    evidenceByField(packet, "market.latestDate").id], {
    fragments: [
      { evidenceId: evidenceByField(packet, "market.price").id, role: "value", format: "value_with_unit" },
      { evidenceId: evidenceByField(packet, "market.latestDate").id, role: "date", format: "date" },
    ],
  });
  const report = candidate(packet, [stock, market]);
  const result = await audit(report, packet);
  assert.equal(result.mechanicalPassed, true);
  assert.equal(result.publicationReady, false);
  assert.equal(result.semanticGrounding, "unverified");
  assert.equal(result.draft?.claims.length, 2);
  assert.ok(result.draft?.claims.every((item) => item.evidenceIds.length > 0 && item.text.length > 0));
});

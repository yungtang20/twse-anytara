import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { ResearchContextAggregator } from "../server/lib/researchContext.js";
import type { AIResearchPacket, ResearchEvidence } from "../shared/aiResearch.js";
import { createResearchContextAdapter } from "./helpers/research-context-fixtures.js";

type RawFinding = {
  id: string; kind: string; stance: string; fragments: Array<{
    evidenceId: string; role: string; format: string;
  }>;
};

async function twoDayInstitutionalPacket(): Promise<AIResearchPacket> {
  const adapter = createResearchContextAdapter();
  adapter.readInstitutional = async () => ({
    data: { dailyFlows: [
      { date: "2026-07-31", foreignNet: 200, trustNet: 20, dealerNet: -50, institutionalNet: 170 },
      { date: "2026-07-30", foreignNet: -100, trustNet: 10, dealerNet: 25, institutionalNet: -65 },
    ] },
    source: {
      id: "supabase:stock_institutional", dataset: "stock_institutional", provider: "supabase",
      asOf: "2026-07-31", retrievedAt: "2026-08-02T03:04:05.000Z", rowCount: 2,
      estimated: false, status: "available", error: null,
    },
  });
  const context = await new ResearchContextAggregator(adapter, {
    clock: () => new Date("2026-08-02T03:04:05.000Z"), asOfDate: "2026-07-31",
  }).aggregate("2330");
  const { buildResearchPacket } = await import("../server/lib/aiResearchPacket.js");
  return buildResearchPacket(context);
}

function ev(packet: AIResearchPacket, field: string): ResearchEvidence {
  const item = packet.evidence.find((candidate) => candidate.field === field);
  assert.ok(item, field);
  return item;
}

function comparisonFinding(packet: AIResearchPacket, options: {
  currentMetric?: "foreignNet" | "dealerNet";
  previousMetric?: "foreignNet" | "dealerNet";
  currentDateId?: string;
  previousDateId?: string;
} = {}): RawFinding {
  const currentMetric = options.currentMetric ?? "foreignNet";
  const previousMetric = options.previousMetric ?? "foreignNet";
  return {
    id: "institutional-comparison", kind: "evidence_comparison", stance: "neutral",
    fragments: [
      { evidenceId: ev(packet, `institutional.2026-07-31.${currentMetric}`).id, role: "current", format: "value_with_unit" },
      { evidenceId: ev(packet, `institutional.2026-07-30.${previousMetric}`).id, role: "previous", format: "value_with_unit" },
      { evidenceId: options.currentDateId ?? ev(packet, "institutional.2026-07-31.date").id, role: "current_date", format: "date" },
      { evidenceId: options.previousDateId ?? ev(packet, "institutional.2026-07-30.date").id, role: "previous_date", format: "date" },
    ],
  };
}

function marketFinding(packet: AIResearchPacket): RawFinding {
  return { id: "market", kind: "market_snapshot", stance: "positive", fragments: [
    { evidenceId: ev(packet, "market.price").id, role: "value", format: "value_with_unit" },
    { evidenceId: ev(packet, "market.latestDate").id, role: "date", format: "date" },
  ] };
}

function candidate(packet: AIResearchPacket, finding: RawFinding, extra: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1, stockId: packet.stockId, asOf: packet.asOf,
    contextFingerprint: packet.contextFingerprint, dataQuality: packet.dataQuality,
    findings: [finding], conclusion: {
      verdict: "neutral", supportingFindingIds: finding.stance === "positive" ? [finding.id] : [],
      opposingFindingIds: [], limitationFindingIds: [], aiConfidence: null, investmentCertainty: null,
    }, citations: finding.fragments.map((fragment) => fragment.evidenceId), ...extra,
  };
}

async function audit(report: unknown, packet: AIResearchPacket) {
  const { auditResearchReport } = await import("../server/lib/aiResearchReportAuditor.js");
  return auditResearchReport(report, packet);
}

function errorCode(result: { errors: string[] }, expected: string): void {
  assert.ok(result.errors.includes(expected), `expected ${expected}; actual=${result.errors.join(",")}`);
  assert.ok(!result.errors.some((item) => item.startsWith("comparison_fragment_contract")), result.errors.join(","));
}

test("formal aggregator supports a two-day foreignNet comparison", async () => {
  const packet = await twoDayInstitutionalPacket();
  const result = await audit(candidate(packet, comparisonFinding(packet)), packet);
  assert.equal(result.mechanicalPassed, true);
  assert.equal(result.publicationReady, false);
  assert.equal(result.publishedReport, null);
  assert.equal(result.draft?.status, "mechanical-preview-only");
  assert.equal(result.draft?.claims[0].text,
    "外資買賣超由 -100股（2026-07-30）至 200股（2026-07-31），呈上升");
});

test("all comparison negatives use four fragments and return exact error codes", async () => {
  const base = await twoDayInstitutionalPacket();
  const identity = await audit(candidate(base, comparisonFinding(base, { previousMetric: "dealerNet" })), base);
  errorCode(identity, "comparison_measurement_identity_mismatch:institutional-comparison");

  const dimensionPacket = structuredClone(base);
  ev(dimensionPacket, "institutional.2026-07-30.foreignNet").unit = "%";
  const dimension = await audit(candidate(dimensionPacket, comparisonFinding(dimensionPacket)), dimensionPacket);
  errorCode(dimension, "comparison_dimension_mismatch:institutional-comparison");

  const unitPacket = structuredClone(base);
  ev(unitPacket, "institutional.2026-07-30.foreignNet").unit = "mystery_shares";
  const unit = await audit(candidate(unitPacket, comparisonFinding(unitPacket)), unitPacket);
  errorCode(unit, "comparison_unit_mismatch:institutional-comparison");

  const dateMismatch = await audit(candidate(base, comparisonFinding(base, {
    currentDateId: ev(base, "institutional.2026-07-30.date").id,
    previousDateId: ev(base, "institutional.2026-07-31.date").id,
  })), base);
  errorCode(dateMismatch, "comparison_date_mismatch:institutional-comparison");

  const futurePacket = structuredClone(base);
  const sourceId = ev(futurePacket, "institutional.2026-07-31.date").sourceId;
  futurePacket.evidence.push(
    { id: "ev:future-foreign", dataset: "stock_institutional", field: "institutional.2099-01-01.foreignNet",
      value: 300, unit: "shares", date: "2099-01-01", sourceId, estimated: false, available: true },
    { id: "ev:future-date", dataset: "stock_institutional", field: "institutional.2099-01-01.date",
      value: "2099-01-01", unit: "date", date: "2099-01-01", sourceId, estimated: false, available: true },
  );
  const futureFinding = comparisonFinding(futurePacket);
  futureFinding.fragments[0].evidenceId = "ev:future-foreign";
  futureFinding.fragments[2].evidenceId = "ev:future-date";
  const future = await audit(candidate(futurePacket, futureFinding), futurePacket);
  errorCode(future, "comparison_future_date:institutional-comparison");
});

test("auditor and renderer import one shared finding runtime validator", async () => {
  const root = path.resolve(import.meta.dirname, "..");
  const [auditor, renderer] = await Promise.all([
    readFile(path.join(root, "server/lib/aiResearchReportAuditor.ts"), "utf8"),
    readFile(path.join(root, "server/lib/aiResearchFindingRenderer.ts"), "utf8"),
  ]);
  assert.match(auditor, /validateResearchFindingRuntime/);
  assert.match(renderer, /validateResearchFindingRuntime/);
  assert.doesNotMatch(auditor, /function parseFindings|function parseFragments/);
});

test("direct renderer rejects empty unsafe and zero-width finding identifiers plus invalid stance", async () => {
  const packet = await twoDayInstitutionalPacket();
  const { renderResearchFinding } = await import("../server/lib/aiResearchFindingRenderer.js");
  for (const [finding, code] of [
    [{ ...marketFinding(packet), id: "" }, "finding_invalid_id"],
    [{ ...marketFinding(packet), stance: "BUY" }, "finding_invalid_stance"],
    [{ ...marketFinding(packet), id: "破\u200B產" }, "finding_invalid_id"],
  ] as const) {
    assert.throws(() => renderResearchFinding(finding as never, packet), new RegExp(code));
  }
});

test("prohibited scanner canonicalizes NFKC zero-width spacing punctuation and split segments", async () => {
  const packet = await twoDayInstitutionalPacket();
  for (const payload of ["舞\u200D弊", "保 證 獲 利", "必－漲", "穩\u200B賺", "零風險", ["破", "產"]]) {
    const report = candidate(packet, marketFinding(packet), { metadata: payload });
    const result = await audit(report, packet);
    assert.equal(result.mechanicalPassed, false);
    assert.ok(result.prohibitedClaims.length > 0, JSON.stringify(payload));
    assert.ok(result.errors.includes("prohibited_claims_present"), JSON.stringify(payload));
  }
  for (const payload of ["買 進", "目－標－價", "ＢＵＹ", "SELL", "持有"]) {
    const result = await audit(candidate(packet, marketFinding(packet), { metadata: payload }), packet);
    assert.deepEqual(result.prohibitedClaims, [], payload);
  }
});

test("candidate rejects generatedAt and succeeds only when model timestamp is absent", async () => {
  const packet = await twoDayInstitutionalPacket();
  const clean = await audit(candidate(packet, marketFinding(packet)), packet);
  assert.equal(clean.mechanicalPassed, true);
  const forged = await audit(candidate(packet, marketFinding(packet), { generatedAt: "2099-01-01T00:00:00.000Z" }), packet);
  assert.equal(forged.mechanicalPassed, false);
  assert.ok(forged.errors.includes("invalid_report_field:generatedAt"));
});

test("unpublished audit exposes only an explicit draft and no formal rendered output", async () => {
  const packet = await twoDayInstitutionalPacket();
  const result = await audit(candidate(packet, marketFinding(packet)), packet) as unknown as Record<string, unknown>;
  assert.equal(result.publicationReady, false);
  assert.equal(result.publishedReport, null);
  assert.equal(Object.hasOwn(result, "renderedClaims"), false);
  assert.equal(Object.hasOwn(result, "renderedConclusion"), false);
  assert.deepEqual(Object.keys(result.draft as object).sort(), ["claims", "conclusion", "status"].sort());

  const root = path.resolve(import.meta.dirname, "..");
  const [ui, route] = await Promise.all([
    readFile(path.join(root, "src/components/views/AIResearchView.tsx"), "utf8"),
    readFile(path.join(root, "server/routes/aiResearch.ts"), "utf8"),
  ]);
  assert.doesNotMatch(`${ui}\n${route}`, /renderedClaims|renderedConclusion|publicationReady\s*:\s*true/);
  assert.match(ui, /機械驗證預覽/);
  assert.match(route, /presentAIResearchReport/);
});

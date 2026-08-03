import assert from "node:assert/strict";
import test from "node:test";
import { ResearchContextAggregator } from "../server/lib/researchContext.js";
import type { ResearchContext, ResearchSource } from "../shared/researchContext.js";
import type { AIResearchPacket } from "../shared/aiResearch.js";
import { AI_RESEARCH_NON_CITABLE_PATHS } from "../shared/aiResearch.js";
import { createResearchContextAdapter } from "./helpers/research-context-fixtures.js";

type Evidence = {
  id: string;
  sourceId: string;
  dataset: string;
  field: string;
  value: number | string | boolean | null;
  unit: string;
  date: string | null;
  available: boolean;
};

type PacketModule = {
  buildResearchPacket(context: ResearchContext): AIResearchPacket;
};

const loadPacketModule = async (): Promise<PacketModule> =>
  import("../server/lib/aiResearchPacket.js") as Promise<PacketModule>;

async function fixtureContext(): Promise<ResearchContext> {
  return new ResearchContextAggregator(createResearchContextAdapter(), {
    clock: () => new Date("2026-08-02T03:04:05.000Z"),
    asOfDate: "2026-07-31",
  }).aggregate("2330");
}

function source(overrides: Partial<ResearchSource> & Pick<ResearchSource, "id" | "dataset">): ResearchSource {
  return {
    provider: "supabase", asOf: "2026-07-31", retrievedAt: "2026-08-02T03:04:05.000Z",
    rowCount: 1, estimated: false, status: "available", error: null, ...overrides,
  };
}

test("source registry is keyed by source ID and every evidence item resolves to available provenance", async () => {
  const { buildResearchPacket } = await loadPacketModule();
  const context = await fixtureContext();
  context.fundamentals.metrics = [{
    key: "eps", value: 0, available: true, unit: "TWD", period: "2026-Q2",
    sourceId: "finmind:financials",
  }];

  const packet = buildResearchPacket(context);
  assert.deepEqual(packet.sources.map((item) => item.id), context.sources.map((item) => item.id));
  assert.deepEqual(packet.evidence.map((item) => item.id), packet.evidence.map((item) => item.id).sort());
  assert.ok(packet.evidence.length > 0);
  for (const evidence of packet.evidence) {
    const registered = packet.sources.find((item) => item.id === evidence.sourceId);
    assert.equal(registered?.status, "available");
    assert.equal(registered?.dataset, evidence.dataset);
    assert.notEqual(evidence.date, undefined);
    assert.equal(typeof evidence.available, "boolean");
  }
});

test("evidence keeps zero and sourced null while excluding unavailable or error sources", async () => {
  const { buildResearchPacket } = await loadPacketModule();
  const context = await fixtureContext();
  context.sources.push(
    source({ id: "supabase:unavailable_metric", dataset: "unavailable_metric", status: "unavailable", rowCount: 0 }),
    source({ id: "supabase:error_metric", dataset: "error_metric", status: "error", rowCount: 0, error: "upstream failed" }),
  );
  context.fundamentals.metrics = [
    { key: "eps", value: 0, available: true, unit: "TWD", period: "2026-Q2", sourceId: "finmind:financials" },
    { key: "netIncome", value: null, available: false, unit: "TWD", period: null, sourceId: "finmind:financials" },
    { key: "revenue", value: 42, available: true, unit: "TWD", period: "2026-Q2", sourceId: "supabase:unavailable_metric" },
    { key: "cash", value: 99, available: true, unit: "TWD", period: "2026-Q2", sourceId: "supabase:error_metric" },
  ];

  const evidence = buildResearchPacket(context).evidence;
  assert.ok(evidence.some((item) => item.field === "fundamentals.metrics.eps" && item.value === 0 && item.available));
  assert.ok(evidence.some((item) => item.field === "market.price" && item.value === 0 && item.available));
  assert.ok(evidence.some((item) => item.field.includes("foreignNet") && item.value === 0 && item.available));
  assert.ok(evidence.some((item) => item.field === "fundamentals.metrics.netIncome" && item.value === null && !item.available));
  assert.equal(evidence.some((item) => item.sourceId === "supabase:unavailable_metric"), false);
  assert.equal(evidence.some((item) => item.sourceId === "supabase:error_metric"), false);
  assert.ok(evidence.some((item) => item.field === "tdcc.retailRatio" && item.value === null && !item.available));
});

test("unknown evidence sources and duplicate source IDs fail closed", async () => {
  const { buildResearchPacket } = await loadPacketModule();
  const unknown = await fixtureContext();
  unknown.fundamentals.metrics = [{
    key: "eps", value: 1, available: true, unit: "TWD", period: "2026-Q2",
    sourceId: "supabase:not_registered",
  }];
  assert.throws(() => buildResearchPacket(unknown), /research_evidence_source_not_found/);

  const duplicate = await fixtureContext();
  duplicate.sources.push(source({
    id: duplicate.sources[0].id,
    dataset: "conflicting_dataset",
  }));
  assert.throws(() => buildResearchPacket(duplicate), /duplicate_research_source/);
});

test("institutional dates are explicit evidence and upstream fake IDs cannot enter the registry", async () => {
  const { buildResearchPacket } = await loadPacketModule();
  const context = await fixtureContext();
  context.strategies.sr.details = {
    ...context.strategies.sr.details,
    evidenceId: "ev:attacker-controlled",
  };
  Object.assign(context.institutional.dailyFlows[0], { evidenceId: "ev:upstream-row" });
  const evidence = buildResearchPacket(context).evidence;
  assert.ok(evidence.some((item) => item.field === "institutional.2026-07-31.date"
    && item.value === "2026-07-31" && item.date === "2026-07-31"));
  assert.equal(evidence.some((item) => item.id === "ev:attacker-controlled" || item.id === "ev:upstream-row"), false);
});

test("duplicate facts use deterministic first-wins while conflicting evidence fails closed", async () => {
  const { buildResearchPacket } = await loadPacketModule();
  const duplicate = await fixtureContext();
  const metric = { key: "eps", value: 10, available: true, unit: "TWD", period: "2026-Q2", sourceId: "finmind:financials" };
  duplicate.fundamentals.metrics = [metric, { ...metric }];
  const packet = buildResearchPacket(duplicate);
  assert.equal(packet.evidence.filter((item) => item.field === "fundamentals.metrics.eps").length, 1);

  const collision = await fixtureContext();
  collision.fundamentals.metrics = [metric, { ...metric, value: 11 }];
  assert.throws(() => buildResearchPacket(collision), /research_evidence_collision/);
});

test("packet omits price history and every retained domain scalar has unique resolvable evidence", async () => {
  const { buildResearchPacket } = await loadPacketModule();
  const context = await fixtureContext();
  context.tdcc = {
    date: "2026-07-31", source: "tdcc", totalShares: 1000, whaleRatio: 52.3,
    retailRatio: null, totalPeople: 88, whaleShares: 600, whalePeople: 12,
  };
  context.tradeRisks = {
    highestLevel: "medium", dataAsOf: "2026-08-01", flags: [{
      risk_type: "attention", reason: "test", announced_date: "2026-07-29",
      start_date: "2026-07-30", source_updated_at: "2026-07-31",
    }],
  };
  context.strategies.sr.details = { lastClose: 2425, atr14: 0, ignoredNested: { fake: 1 } };
  const packet = buildResearchPacket(context);
  assert.equal("history" in packet.market, false);
  assert.equal(new Set(packet.evidence.map((item) => item.id)).size, packet.evidence.length);
  assert.ok(packet.evidence.every((item) => packet.sources.some((source) => source.id === item.sourceId)));
  assert.ok(packet.evidence.some((item) => item.field === "stockId" && item.value === packet.stockId));
  assert.ok(packet.evidence.some((item) => item.field === "asOf" && item.value === packet.asOf));
  assert.deepEqual(AI_RESEARCH_NON_CITABLE_PATHS, [
    "schemaVersion", "contextFingerprint", "dataQuality.*", "sources.*", "evidence.*",
    "fundamentals.status", "fundamentals.missing.*",
    "fundamentals.metrics.*.key", "fundamentals.metrics.*.available",
    "fundamentals.metrics.*.unit", "fundamentals.metrics.*.period", "fundamentals.metrics.*.sourceId",
    "strategies.*.strategy",
  ]);
  for (const field of ["date", "source", "totalShares", "whaleRatio", "retailRatio", "totalPeople", "whaleShares", "whalePeople"]) {
    assert.ok(packet.evidence.some((item) => item.field === `tdcc.${field}`), field);
  }
  const flagEvidence = packet.evidence.filter((item) => item.field.startsWith("tradeRisks.flags.0."));
  assert.ok(flagEvidence.length > 0);
  assert.ok(flagEvidence.every((item) => item.date === "2026-07-31"));
  assert.ok(flagEvidence.some((item) => item.field.endsWith("source_updated_at") && item.value === "2026-07-31"));
  for (const field of ["lastClose", "atr14"]) {
    assert.ok(packet.evidence.some((item) => item.field === `strategies.sr.details.${field}`));
  }
});

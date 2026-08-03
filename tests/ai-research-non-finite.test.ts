import assert from "node:assert/strict";
import test from "node:test";
import { ResearchContextAggregator } from "../server/lib/researchContext.js";
import type { ResearchContextAdapter } from "../server/lib/researchContext.js";
import type { ResearchContext } from "../shared/researchContext.js";
import type { AIResearchPacket, ResearchEvidence } from "../shared/aiResearch.js";
import { createResearchContextAdapter } from "./helpers/research-context-fixtures.js";

const options = {
  clock: () => new Date("2026-08-02T03:04:05.000Z"),
  asOfDate: "2026-07-31",
};

type FormalScenario = "institutional" | "market" | "financial" | "tdcc" | "strategy";

function scenarioAdapter(scenario: FormalScenario, value: number): ResearchContextAdapter {
  const adapter = createResearchContextAdapter();
  if (scenario === "institutional") {
    const original = adapter.readInstitutional;
    adapter.readInstitutional = async (stockId) => {
      const result = await original(stockId);
      result.data.dailyFlows[0].foreignNet = value;
      return result;
    };
  } else if (scenario === "market") {
    const original = adapter.readMarket;
    adapter.readMarket = async (stockId) => {
      const result = await original(stockId);
      result.data.price = value;
      return result;
    };
  } else if (scenario === "financial") {
    const original = adapter.readFundamentals;
    adapter.readFundamentals = async (stockId) => {
      const result = await original(stockId);
      result.data.metrics[0] = { ...result.data.metrics[0], value, available: true, sourceId: result.source.id };
      return result;
    };
  } else if (scenario === "tdcc") {
    const original = adapter.readTdcc;
    adapter.readTdcc = async (stockId) => {
      const result = await original(stockId);
      result.data.whaleRatio = value;
      return result;
    };
  } else {
    const original = adapter.runStrategy;
    adapter.runStrategy = async (stockId, strategy) => {
      const result = await original(stockId, strategy);
      if (strategy === "sr") result.details = { ...result.details, atr14: value };
      return result;
    };
  }
  return adapter;
}

async function context(adapter = createResearchContextAdapter()): Promise<ResearchContext> {
  return new ResearchContextAggregator(adapter, options).aggregate("2330");
}

async function build(adapter = createResearchContextAdapter()): Promise<AIResearchPacket> {
  const { buildResearchPacket } = await import("../server/lib/aiResearchPacket.js");
  return buildResearchPacket(await context(adapter));
}

function findEvidence(packet: AIResearchPacket, field: string): ResearchEvidence {
  const evidence = packet.evidence.find((item) => item.field === field);
  assert.ok(evidence, field);
  return evidence;
}

function comparisonFinding(packet: AIResearchPacket) {
  return { id: "institutional-comparison", kind: "evidence_comparison", stance: "neutral", fragments: [
    { evidenceId: findEvidence(packet, "institutional.2026-07-31.foreignNet").id, role: "current", format: "value_with_unit" },
    { evidenceId: findEvidence(packet, "institutional.2026-07-30.foreignNet").id, role: "previous", format: "value_with_unit" },
    { evidenceId: findEvidence(packet, "institutional.2026-07-31.date").id, role: "current_date", format: "date" },
    { evidenceId: findEvidence(packet, "institutional.2026-07-30.date").id, role: "previous_date", format: "date" },
  ] };
}

function report(packet: AIResearchPacket, finding: ReturnType<typeof comparisonFinding>) {
  return {
    schemaVersion: 1, stockId: packet.stockId, asOf: packet.asOf,
    contextFingerprint: packet.contextFingerprint, dataQuality: packet.dataQuality,
    findings: [finding], conclusion: {
      verdict: "neutral", supportingFindingIds: [], opposingFindingIds: [], limitationFindingIds: [],
      aiConfidence: null, investmentCertainty: null,
    }, citations: finding.fragments.map((fragment) => fragment.evidenceId),
  };
}

async function comparisonPacket(): Promise<AIResearchPacket> {
  const fixture = await context();
  fixture.institutional.dailyFlows.push({
    date: "2026-07-30", foreignNet: -100, trustNet: 10, dealerNet: 20, institutionalNet: -70,
  });
  const { buildResearchPacket } = await import("../server/lib/aiResearchPacket.js");
  return buildResearchPacket(fixture);
}

test("formal adapter path rejects non-finite institutional flows with exact paths", async () => {
  for (const [value, label] of [[NaN, "NaN"], [Infinity, "Infinity"], [-Infinity, "-Infinity"]] as const) {
    await assert.rejects(() => build(scenarioAdapter("institutional", value)),
      new RegExp(`research_packet_non_finite_number:institutional\\.2026-07-31\\.foreignNet`), label);
  }
});

test("formal adapter path rejects market financial TDCC and strategy non-finite scalars", async () => {
  for (const [scenario, value, path] of [
    ["market", NaN, "market.price"],
    ["financial", Infinity, "fundamentals.metrics.eps"],
    ["tdcc", NaN, "tdcc.whaleRatio"],
    ["strategy", Infinity, "strategies.sr.details.atr14"],
  ] as const) {
    await assert.rejects(() => build(scenarioAdapter(scenario, value)),
      new RegExp(`research_packet_non_finite_number:${path.replaceAll(".", "\\.")}`));
  }
});

test("manual packet comparison rejects non-finite current and previous without a directional draft", async () => {
  for (const [field, value] of [
    ["institutional.2026-07-31.foreignNet", NaN],
    ["institutional.2026-07-30.foreignNet", Infinity],
  ] as const) {
    const packet = structuredClone(await comparisonPacket());
    findEvidence(packet, field).value = value;
    const finding = comparisonFinding(packet);
    const { auditResearchReport } = await import("../server/lib/aiResearchReportAuditor.js");
    const result = auditResearchReport(report(packet, finding), packet);
    assert.equal(result.mechanicalPassed, false);
    assert.ok(result.errors.includes("comparison_numeric_value_required:institutional-comparison"), result.errors.join(","));
    assert.equal(result.draft, null);
    assert.doesNotMatch(JSON.stringify(result), /非數值|NaN|Infinity|上升|下降|持平/);
  }
});

test("direct renderer rejects non-finite fixed and comparison findings in handcrafted packets", async () => {
  const packet = structuredClone(await comparisonPacket());
  findEvidence(packet, "market.price").value = NaN;
  const finding = { id: "market", kind: "market_snapshot", stance: "neutral", fragments: [
    { evidenceId: findEvidence(packet, "market.price").id, role: "value", format: "value_with_unit" },
    { evidenceId: findEvidence(packet, "market.latestDate").id, role: "date", format: "date" },
  ] };
  const { renderResearchFinding } = await import("../server/lib/aiResearchFindingRenderer.js");
  assert.throws(() => renderResearchFinding(finding as never, packet),
    /finding_numeric_policy_violation:market:market\.price/);
  findEvidence(packet, "institutional.2026-07-31.foreignNet").value = -Infinity;
  assert.throws(() => renderResearchFinding(comparisonFinding(packet) as never, packet),
    /comparison_numeric_value_required:institutional-comparison/);
});

test("non-finite numbers cannot generate or collide with a null fingerprint", async () => {
  const { buildResearchPacket } = await import("../server/lib/aiResearchPacket.js");
  const nullable = await context();
  nullable.market.price = null;
  const first = buildResearchPacket(nullable).contextFingerprint;
  const second = buildResearchPacket(structuredClone(nullable)).contextFingerprint;
  assert.equal(first, second);
  assert.match(first, /^[a-f0-9]{64}$/);
  for (const value of [NaN, Infinity, -Infinity]) {
    const invalid = structuredClone(nullable);
    invalid.market.price = value;
    assert.throws(() => buildResearchPacket(invalid), /research_packet_non_finite_number:market\.price/);
  }
});

test("zero negative integers and valid decimals remain lossless", async () => {
  const fixture = await context();
  fixture.market.price = 0;
  fixture.institutional.dailyFlows[0].foreignNet = -7;
  fixture.tdcc.whaleRatio = 52.3;
  fixture.fundamentals.metrics[0] = {
    ...fixture.fundamentals.metrics[0], value: 1.25, available: true,
    sourceId: fixture.sources.find((source) => source.dataset === "financials")?.id ?? null,
  };
  const { buildResearchPacket } = await import("../server/lib/aiResearchPacket.js");
  const packet = buildResearchPacket(fixture);
  assert.equal(packet.market.price, 0);
  assert.equal(packet.institutional.dailyFlows[0].foreignNet, -7);
  assert.equal(packet.tdcc.whaleRatio, 52.3);
  assert.equal(packet.fundamentals.metrics[0].value, 1.25);
});

test("shares and count fields require safe integers while ratios permit finite decimals", async () => {
  await assert.rejects(() => build(scenarioAdapter("institutional", 1.5)),
    /research_packet_unsafe_integer:institutional\.2026-07-31\.foreignNet/);
  const tdcc = scenarioAdapter("tdcc", 52.345);
  assert.equal((await build(tdcc)).tdcc.whaleRatio, 52.345);
});

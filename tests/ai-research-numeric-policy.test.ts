import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { buildResearchPacket } from "../server/lib/aiResearchPacket.js";
import { ResearchContextAggregator } from "../server/lib/researchContext.js";
import type { ResearchContextAdapter } from "../server/lib/researchContext.js";
import type { ResearchContext } from "../shared/researchContext.js";
import type {
  AIResearchPacket,
  AIResearchReportCandidate,
  ResearchEvidence,
  StructuredResearchFinding,
} from "../shared/aiResearch.js";
import { createResearchContextAdapter } from "./helpers/research-context-fixtures.js";

const options = { clock: () => new Date("2026-08-02T03:04:05.000Z"), asOfDate: "2026-07-31" };

async function aggregate(adapter = createResearchContextAdapter()): Promise<ResearchContext> {
  return new ResearchContextAggregator(adapter, options).aggregate("2330");
}

function build(context: ResearchContext): AIResearchPacket {
  return buildResearchPacket(context);
}

function evidence(packet: AIResearchPacket, field: string): ResearchEvidence {
  const item = packet.evidence.find((candidate) => candidate.field === field);
  assert.ok(item, field);
  return item;
}

function financialAdapter(unit: string, value: number): ResearchContextAdapter {
  return financialMetricAdapter("households", unit, value);
}

function financialMetricAdapter(key: string, unit: string, value: number): ResearchContextAdapter {
  const adapter = createResearchContextAdapter();
  const original = adapter.readFundamentals;
  adapter.readFundamentals = async (stockId) => {
    const result = await original(stockId);
    result.data.metrics[0] = { key, value, available: true, unit,
      period: "2026-Q2", sourceId: result.source.id };
    return result;
  };
  return adapter;
}

function marketAdapter(value: number): ResearchContextAdapter {
  const adapter = createResearchContextAdapter();
  const original = adapter.readMarket;
  adapter.readMarket = async (stockId) => {
    const result = await original(stockId);
    result.data.price = value;
    return result;
  };
  return adapter;
}

function tdccAdapter(field: "whaleRatio" | "retailRatio", value: number): ResearchContextAdapter {
  const adapter = createResearchContextAdapter();
  const original = adapter.readTdcc;
  adapter.readTdcc = async (stockId) => {
    const result = await original(stockId);
    result.data[field] = value;
    return result;
  };
  return adapter;
}

function confidenceAdapter(value: number): ResearchContextAdapter {
  const adapter = createResearchContextAdapter();
  const original = adapter.runStrategy;
  adapter.runStrategy = async (stockId, strategy) => ({ ...(await original(stockId, strategy)), confidence: value });
  return adapter;
}

function tdccFinding(packet: AIResearchPacket, field: string, id = "tdcc-numeric"): StructuredResearchFinding {
  return { id, kind: "tdcc_concentration", stance: "neutral", fragments: [
    { evidenceId: evidence(packet, field).id, role: "value", format: "value_with_unit" },
    { evidenceId: evidence(packet, "tdcc.date").id, role: "date", format: "date" },
  ] };
}

function candidate(packet: AIResearchPacket, finding: ReturnType<typeof tdccFinding>): AIResearchReportCandidate {
  return { schemaVersion: 1, stockId: packet.stockId, asOf: packet.asOf,
    contextFingerprint: packet.contextFingerprint, dataQuality: packet.dataQuality,
    findings: [finding], conclusion: { verdict: "neutral", supportingFindingIds: [], opposingFindingIds: [],
      limitationFindingIds: [], aiConfidence: null, investmentCertainty: null },
    citations: finding.fragments.map((fragment) => fragment.evidenceId) };
}

async function assertManualRejected(unit: "股" | "人", field: "tdcc.totalShares" | "tdcc.totalPeople"): Promise<void> {
  const packet = structuredClone(await build(await aggregate()));
  const item = evidence(packet, field);
  item.value = 1.5;
  item.unit = unit;
  item.available = true;
  const finding = tdccFinding(packet, field);
  const [{ renderResearchFinding }, { auditResearchReport }] = await Promise.all([
    import("../server/lib/aiResearchFindingRenderer.js"), import("../server/lib/aiResearchReportAuditor.js"),
  ]);
  const error = new RegExp(`finding_numeric_policy_violation:tdcc-numeric:${field.replaceAll(".", "\\.")}`);
  assert.throws(() => renderResearchFinding(finding as never, packet), error);
  const result = auditResearchReport(candidate(packet, finding), packet);
  assert.equal(result.mechanicalPassed, false);
  assert.ok(result.errors.includes(`finding_numeric_policy_violation:tdcc-numeric:${field}`), result.errors.join(","));
  assert.equal(result.draft, null);
}

test("one unit registry rejects fractional Chinese shares and counts on formal and manual paths", async () => {
  for (const [key, unit] of [["shareholderAccounts", "戶"], ["shareholderPeople", "人"],
    ["sharesOutstanding", "股"]] as const) {
    await assert.rejects(() => aggregate(financialMetricAdapter(key, unit, 1.5)).then(build),
      new RegExp(`research_packet_unsafe_integer:fundamentals\\.metrics\\.${key}`));
  }
  await assertManualRejected("股", "tdcc.totalShares");
  await assertManualRejected("人", "tdcc.totalPeople");
});

test("signed and nonnegative integer policies reject only semantically invalid negatives", async () => {
  for (const [path, mutate] of [
    ["sources.0.rowCount", (value: ResearchContext) => { value.sources[0].rowCount = -1; }],
    ["tdcc.totalShares", (value: ResearchContext) => { value.tdcc.totalShares = -1; }],
    ["tdcc.totalPeople", (value: ResearchContext) => { value.tdcc.totalPeople = -2; }],
    ["tdcc.whaleShares", (value: ResearchContext) => { value.tdcc.whaleShares = -3; }],
    ["tdcc.whalePeople", (value: ResearchContext) => { value.tdcc.whalePeople = -4; }],
  ] as const) {
    const fixture = await aggregate();
    mutate(fixture);
    assert.throws(() => void build(fixture), new RegExp(`research_packet_negative_number:${path.replaceAll(".", "\\.")}`));
  }
  const signed = await aggregate();
  signed.sources[0].rowCount = 0;
  signed.tdcc.totalPeople = 0;
  signed.institutional.dailyFlows[0].foreignNet = -7;
  assert.equal((await build(signed)).institutional.dailyFlows[0].foreignNet, -7);
});

test("safe integer boundaries and TDCC cross-field constraints fail closed", async () => {
  const max = await aggregate();
  max.tdcc.totalShares = Number.MAX_SAFE_INTEGER;
  max.tdcc.whaleShares = Number.MAX_SAFE_INTEGER;
  assert.equal((await build(max)).tdcc.totalShares, Number.MAX_SAFE_INTEGER);

  const unsafe = await aggregate();
  unsafe.tdcc.totalShares = Number.MAX_SAFE_INTEGER + 1;
  assert.throws(() => void build(unsafe), /research_packet_unsafe_integer:tdcc\.totalShares/);

  for (const [field, expected] of [["whaleShares", "shares"], ["whalePeople", "people"]] as const) {
    const fixture = await aggregate();
    if (field === "whaleShares") { fixture.tdcc.totalShares = 10; fixture.tdcc.whaleShares = 11; }
    else { fixture.tdcc.totalPeople = 10; fixture.tdcc.whalePeople = 11; }
    assert.throws(() => void build(fixture), new RegExp(`research_packet_cross_field_violation:tdcc\\.whale${expected === "shares" ? "Shares" : "People"}_gt_total${expected === "shares" ? "Shares" : "People"}`));
  }
});

test("formal adapter range policies enforce TDCC ratios confidence and market price", async () => {
  for (const field of ["whaleRatio", "retailRatio"] as const) {
    for (const invalid of [-0.01, 100.01]) {
      await assert.rejects(() => aggregate(tdccAdapter(field, invalid)).then(build),
        new RegExp(`research_packet_number_out_of_range:tdcc\\.${field}`));
    }
    for (const valid of [0, 100]) assert.equal((await aggregate(tdccAdapter(field, valid)).then(build)).tdcc[field], valid);
  }
  for (const invalid of [-0.01, 1.01]) {
    await assert.rejects(() => aggregate(confidenceAdapter(invalid)).then(build),
      /research_packet_number_out_of_range:strategies\.sr\.confidence/);
  }
  for (const valid of [0, 1]) assert.equal((await aggregate(confidenceAdapter(valid)).then(build)).strategies.sr.confidence, valid);
  await assert.rejects(() => aggregate(marketAdapter(-0.01)).then(build),
    /research_packet_negative_number:market\.price/);
  assert.equal((await aggregate(marketAdapter(0)).then(build)).market.price, 0);
});

test("handcrafted out-of-range evidence is rejected by renderer and auditor", async () => {
  const packet = structuredClone(await build(await aggregate()));
  evidence(packet, "tdcc.whaleRatio").value = 100.01;
  const finding = tdccFinding(packet, "tdcc.whaleRatio", "tdcc-range");
  const [{ renderResearchFinding }, { auditResearchReport }] = await Promise.all([
    import("../server/lib/aiResearchFindingRenderer.js"), import("../server/lib/aiResearchReportAuditor.js"),
  ]);
  assert.throws(() => renderResearchFinding(finding as never, packet),
    /finding_numeric_policy_violation:tdcc-range:tdcc\.whaleRatio/);
  const result = auditResearchReport(candidate(packet, finding), packet);
  assert.ok(result.errors.includes("finding_numeric_policy_violation:tdcc-range:tdcc.whaleRatio"));
  assert.equal(result.draft, null);
});

test("negative zero is normalized before packet evidence rendering and fingerprinting", async () => {
  const negative = await aggregate();
  negative.market.price = -0;
  negative.institutional.dailyFlows[0].foreignNet = -0;
  negative.tdcc.whaleRatio = -0;
  const normalized = await build(negative);
  assert.equal(Object.is(normalized.market.price, -0), false);
  assert.equal(Object.is(normalized.institutional.dailyFlows[0].foreignNet, -0), false);
  assert.equal(Object.is(normalized.tdcc.whaleRatio, -0), false);
  assert.equal(Object.is(evidence(normalized, "market.price").value, -0), false);
  const positive = await aggregate();
  positive.market.price = 0;
  positive.institutional.dailyFlows[0].foreignNet = 0;
  positive.tdcc.whaleRatio = 0;
  assert.equal(normalized.contextFingerprint, (await build(positive)).contextFingerprint);

  const manual = structuredClone(normalized);
  evidence(manual, "tdcc.whaleRatio").value = -0;
  const { renderResearchFinding } = await import("../server/lib/aiResearchFindingRenderer.js");
  const rendered = renderResearchFinding(tdccFinding(manual, "tdcc.whaleRatio") as never, manual);
  assert.doesNotMatch(rendered.text, /為 -0|-0%/);
});

test("financial ratios and decimals keep domain semantics without a generic ratio clamp", async () => {
  for (const value of [-2.5, 150.25]) {
    const packet = await aggregate(financialMetricAdapter("roe", "%", value)).then(build);
    assert.equal(packet.fundamentals.metrics[0].value, value);
  }
});

test("unknown units and numeric fields without a contract fail closed", async () => {
  const numeric = await import("../server/lib/aiResearchNumericPolicy.js");
  for (const unit of ["widgets", "mystery_unit"]) {
    assert.throws(() => numeric.validateResearchNumber({
      path: "fundamentals.metrics.x", field: "fundamentals.metrics.x", unit, value: 1.5,
    }), new RegExp(`research_packet_unknown_unit:fundamentals\\.metrics\\.x:${unit}`));
  }
  assert.throws(() => numeric.validateResearchNumber({
    path: "manual.unknown", field: "manual.unknown", unit: "", value: 1.5,
  }), /research_packet_unknown_numeric_contract:manual\.unknown/);
});

test("numeric module exposes only validation and canonical normalization interfaces", async () => {
  const numeric = await import("../server/lib/aiResearchNumericPolicy.js");
  assert.deepEqual(Object.keys(numeric).sort(), ["normalizeCanonicalResearchNumber", "validateResearchNumber"]);
});

test("people accounts and count are distinct and render deterministic suffixes", async () => {
  const numeric = await import("../server/lib/aiResearchNumericPolicy.js");
  assert.equal(numeric.validateResearchNumber({ path: "tdcc.totalPeople", field: "tdcc.totalPeople",
    unit: "人", value: 10 }).dimension, "people");
  assert.equal(numeric.validateResearchNumber({ path: "fundamentals.metrics.households", field: "fundamentals.metrics.households",
    unit: "戶", value: 10 }).dimension, "accounts");
  assert.equal(numeric.validateResearchNumber({ path: "strategies.pattern.details.dataPoints",
    field: "strategies.pattern.details.dataPoints", unit: "count", value: 10 }).dimension, "count");

  const packet = structuredClone(await build(await aggregate()));
  evidence(packet, "tdcc.totalPeople").value = 10;
  evidence(packet, "tdcc.totalPeople").unit = "人";
  evidence(packet, "tdcc.totalPeople").available = true;
  const { renderResearchFinding } = await import("../server/lib/aiResearchFindingRenderer.js");
  assert.match(renderResearchFinding(tdccFinding(packet, "tdcc.totalPeople") as never, packet).text, /10人/);

  const accountsPacket = await aggregate(financialMetricAdapter("households", "戶", 10)).then(build);
  const financial = evidence(accountsPacket, "fundamentals.metrics.households");
  const finding = { id: "accounts", kind: "financial_metric", stance: "neutral", fragments: [
    { evidenceId: financial.id, role: "value", format: "value_with_unit" },
  ] };
  assert.match(renderResearchFinding(finding as never, accountsPacket).text, /10戶/);
});

test("every retained strategy numeric detail has an explicit field policy", async () => {
  for (const [strategy, field, value, code] of [
    ["chips", "whaleRatio", -999, "research_packet_number_out_of_range"],
    ["chips", "retailRatio", 101, "research_packet_number_out_of_range"],
    ["pattern", "confidence", 2, "research_packet_number_out_of_range"],
    ["sr", "lastClose", -1, "research_packet_negative_number"],
    ["ma", "previousClose", -1, "research_packet_negative_number"],
    ["pattern", "dataPoints", 1.5, "research_packet_unsafe_integer"],
    ["pattern", "atr14", -1, "research_packet_negative_number"],
    ["pattern", "volumeRatio", -1, "research_packet_negative_number"],
  ] as const) {
    const fixture = await aggregate();
    fixture.strategies[strategy].details[field] = value;
    assert.throws(() => build(fixture), new RegExp(`${code}:strategies\\.${strategy}\\.details\\.${field}`));
  }
});

test("formal financial producer units are allowlisted while unknown and empty units fail", async () => {
  for (const [key, unit, value] of [["eps", "TWD", 12.5], ["roe", "%", -25.5]] as const) {
    const packet = await aggregate(financialMetricAdapter(key, unit, value)).then(build);
    assert.equal(packet.fundamentals.metrics[0].value, value);
  }
  for (const unit of ["widgets", "mystery_unit", ""]) {
    await assert.rejects(() => aggregate(financialMetricAdapter("unknown", unit, 1.5)).then(build),
      unit ? new RegExp(`research_packet_unknown_unit:fundamentals\\.metrics\\.unknown:${unit}`)
        : /research_packet_unknown_numeric_contract:fundamentals\.metrics\.unknown/);
  }
});

test("candidate confidence uses the shared numeric policy including negative-zero normalization", async () => {
  const packet = await build(await aggregate());
  const finding = tdccFinding(packet, "tdcc.whaleRatio");
  const { auditResearchReport } = await import("../server/lib/aiResearchReportAuditor.js");
  for (const [field, error] of [["aiConfidence", "invalid_ai_confidence"],
    ["investmentCertainty", "invalid_investment_certainty"]] as const) {
    for (const invalid of [NaN, Infinity, -0.01, 1.01]) {
      const report = candidate(packet, finding);
      report.conclusion[field] = invalid;
      assert.ok(auditResearchReport(report, packet).errors.includes(error), `${field}:${invalid}`);
    }
    for (const valid of [-0, 0, 0.25, 1]) {
      const report = candidate(packet, finding);
      report.conclusion[field] = valid;
      assert.equal(auditResearchReport(report, packet).mechanicalPassed, true, `${field}:${valid}`);
    }
  }
  const numeric = await import("../server/lib/aiResearchNumericPolicy.js");
  assert.equal(Object.is(numeric.validateResearchNumber({ path: "report.conclusion.aiConfidence",
    field: "report.conclusion.aiConfidence", unit: "ratio", value: -0 }).value, -0), false);
});

test("manual evidence cannot bypass unknown or empty numeric contracts through renderer or auditor", async () => {
  for (const [field, unit, expected] of [["tdcc.totalShares", "widgets", "research_packet_unknown_unit"],
    ["manual.unknown", "", "research_packet_unknown_numeric_contract"]] as const) {
    const packet = structuredClone(await build(await aggregate()));
    const item = evidence(packet, "tdcc.totalShares");
    item.field = field; item.unit = unit; item.value = 1.5; item.available = true;
    const finding = { id: "manual-contract", kind: "tdcc_concentration", stance: "neutral", fragments: [
      { evidenceId: item.id, role: "value", format: "value_with_unit" },
      { evidenceId: evidence(packet, "tdcc.date").id, role: "date", format: "date" },
    ] };
    const [{ renderResearchFinding }, { auditResearchReport }] = await Promise.all([
      import("../server/lib/aiResearchFindingRenderer.js"), import("../server/lib/aiResearchReportAuditor.js"),
    ]);
    const code = `finding_numeric_policy_violation:manual-contract:${field}:${expected}`;
    assert.throws(() => renderResearchFinding(finding as never, packet), new RegExp(code.replaceAll(".", "\\.")));
    const audit = auditResearchReport(candidate(packet, finding as never), packet);
    assert.ok(audit.errors.includes(code), `${code} not in ${audit.errors.join(",")}`);
  }
});

test("research numeric primitives exist only in the numeric policy implementation", async () => {
  const root = path.resolve(import.meta.dirname, "..");
  const modules = ["aiResearchPacket.ts", "aiResearchFindingPolicy.ts", "aiResearchFindingRenderer.ts",
    "aiResearchReportAuditor.ts", "aiResearchRichness.ts", "aiResearchModelRequest.ts"];
  for (const file of modules) {
    const source = await readFile(path.join(root, "server/lib", file), "utf8");
    assert.doesNotMatch(source, /Number\.isFinite|Number\.isSafeInteger|Object\.is\([^\n]*-0/, file);
  }
  const numeric = await readFile(path.join(root, "server/lib/aiResearchNumericPolicy.ts"), "utf8");
  assert.match(numeric, /Number\.isFinite/);
  assert.match(numeric, /Number\.isSafeInteger/);
  assert.match(numeric, /Object\.is\([^\n]*-0/);
  assert.doesNotMatch(numeric, /\?\?\s*"finite"|\?\?\s*"number"/);
});

test("every TDCC count and institutional flow uses its explicit integer policy", async () => {
  const tdccFields = ["totalShares", "totalPeople", "whaleShares", "whalePeople"] as const;
  for (const field of tdccFields) {
    for (const invalid of [1.5, Number.MAX_SAFE_INTEGER + 1]) {
      const context = await aggregate();
      context.tdcc[field] = invalid;
      assert.throws(() => build(context), new RegExp(`research_packet_unsafe_integer:tdcc\\.${field}`));
    }
  }
  for (const invalid of [1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
    const context = await aggregate();
    context.institutional.dailyFlows[0].foreignNet = invalid;
    const code = Number.isFinite(invalid) ? "research_packet_unsafe_integer" : "research_packet_non_finite_number";
    assert.throws(() => build(context), new RegExp(`${code}:institutional\\.2026-07-31\\.foreignNet`));
  }
  const signed = await aggregate();
  signed.institutional.dailyFlows[0].foreignNet = -7;
  assert.equal(build(signed).institutional.dailyFlows[0].foreignNet, -7);
});

test("nulls and legal ratio confidence price and financial decimals remain exact", async () => {
  const nullable = await aggregate();
  nullable.tdcc.whaleRatio = null;
  nullable.tdcc.retailRatio = null;
  assert.equal(build(nullable).tdcc.whaleRatio, null);
  assert.equal(build(nullable).tdcc.retailRatio, null);
  assert.equal((await aggregate(tdccAdapter("whaleRatio", 52.3)).then(build)).tdcc.whaleRatio, 52.3);
  assert.equal((await aggregate(confidenceAdapter(0.375)).then(build)).strategies.sr.confidence, 0.375);
  assert.equal((await aggregate(marketAdapter(0)).then(build)).market.price, 0);
  assert.equal((await aggregate(financialMetricAdapter("eps", "TWD", -2.75)).then(build))
    .fundamentals.metrics[0].value, -2.75);
});

test("canonical unit registry normalizes aliases and rejects unknown blank or contradictory units", async () => {
  for (const [key, aliases, canonical] of [
    ["sharesOutstanding", ["股", "shares"], "shares"],
    ["shareholderPeople", ["人", "people"], "people"],
    ["shareholderAccounts", ["戶", "accounts"], "accounts"],
  ] as const) {
    for (const alias of aliases) {
      const packet = await aggregate(financialMetricAdapter(key, alias, 7)).then(build);
      assert.equal(packet.fundamentals.metrics[0].unit, canonical);
      assert.equal(evidence(packet, `fundamentals.metrics.${key}`).unit, canonical);
    }
    await assert.rejects(() => aggregate(financialMetricAdapter(key, canonical, 1.5)).then(build),
      new RegExp(`research_packet_unsafe_integer:fundamentals\\.metrics\\.${key}`));
  }
  await assert.rejects(() => aggregate(financialMetricAdapter("eps", "", 1.25)).then(build),
    /research_packet_unknown_numeric_contract:fundamentals\.metrics\.eps/);
  await assert.rejects(() => aggregate(financialMetricAdapter("eps", "mystery", 1.25)).then(build),
    /research_packet_unknown_unit:fundamentals\.metrics\.eps:mystery/);
  const { validateResearchNumber } = await import("../server/lib/aiResearchNumericPolicy.js");
  assert.throws(() => validateResearchNumber({
    path: "tdcc.totalPeople", field: "tdcc.totalPeople", unit: "shares", value: 1,
  }), /research_packet_numeric_unit_mismatch:tdcc\.totalPeople:shares/);
});

test("forged packet core numbers and relationships cannot bypass renderer or auditor", async () => {
  const [{ renderResearchFinding }, { auditResearchReport }] = await Promise.all([
    import("../server/lib/aiResearchFindingRenderer.js"), import("../server/lib/aiResearchReportAuditor.js"),
  ]);
  const base = await aggregate().then(build);
  for (const [mutate, code] of [
    [(packet: AIResearchPacket) => { packet.sources[0].rowCount = -1; },
      "research_packet_negative_number:sources.0.rowCount"],
    [(packet: AIResearchPacket) => { packet.tdcc.totalShares = 1; packet.tdcc.whaleShares = 2; },
      "research_packet_cross_field_violation:tdcc.whaleShares_gt_totalShares"],
    [(packet: AIResearchPacket) => { packet.tdcc.totalPeople = 1; packet.tdcc.whalePeople = 2; },
      "research_packet_cross_field_violation:tdcc.whalePeople_gt_totalPeople"],
  ] as const) {
    const packet = structuredClone(base);
    mutate(packet);
    const finding = tdccFinding(packet, "tdcc.whaleRatio", "forged-core");
    assert.throws(() => renderResearchFinding(finding as never, packet), new RegExp(code.replaceAll(".", "\\.")));
    const result = auditResearchReport(candidate(packet, finding), packet);
    assert.equal(result.mechanicalPassed, false);
    assert.ok(result.errors.includes(code), result.errors.join(","));
    assert.equal(result.draft, null);
  }
});

test("forged evidence unit fails through renderer and auditor numeric policy", async () => {
  const packet = structuredClone(await aggregate().then(build));
  evidence(packet, "tdcc.totalShares").unit = "mystery";
  const finding = tdccFinding(packet, "tdcc.totalShares", "forged-unit");
  const [{ renderResearchFinding }, { auditResearchReport }] = await Promise.all([
    import("../server/lib/aiResearchFindingRenderer.js"), import("../server/lib/aiResearchReportAuditor.js"),
  ]);
  assert.throws(() => renderResearchFinding(finding as never, packet),
    /finding_numeric_policy_violation:forged-unit:tdcc\.totalShares:research_packet_unknown_unit/);
  const result = auditResearchReport(candidate(packet, finding), packet);
  assert.ok(result.errors.includes(
    "finding_numeric_policy_violation:forged-unit:tdcc.totalShares:research_packet_unknown_unit"));
  assert.equal(result.draft, null);
});

test("ordinary numeric changes still alter the deterministic fingerprint", async () => {
  const first = await aggregate(marketAdapter(10)).then(build);
  const equivalent = await aggregate(marketAdapter(10)).then(build);
  const changed = await aggregate(marketAdapter(11)).then(build);
  assert.equal(first.contextFingerprint, equivalent.contextFingerprint);
  assert.notEqual(first.contextFingerprint, changed.contextFingerprint);
});

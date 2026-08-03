import { createHash } from "node:crypto";
import type { AIResearchPacket, ResearchEvidence } from "../../shared/aiResearch";
import type { ResearchContext, ResearchSource, StrategyId } from "../../shared/researchContext";
import { evaluateInformationRichness } from "./aiResearchRichness";
import {
  normalizeCanonicalResearchNumber,
  validateResearchNumber,
} from "./aiResearchNumericPolicy";

type Scalar = number | string | boolean | null;
const STRATEGIES: StrategyId[] = ["sr", "ma", "chips", "pattern"];
const RISK_FIELDS = ["risk_type", "risk_level", "reason", "restrictions", "announced_date", "start_date", "end_date", "source_updated_at", "source", "source_url", "is_active"] as const;
const STRATEGY_DETAIL_FIELDS: Record<StrategyId, ReadonlySet<string>> = {
  sr: new Set(["date", "lastClose", "atr14", "vwap", "poc", "shortResistance", "shortSupport", "longResistance", "longSupport", "swingHigh", "swingLow", "recentHigh", "recentLow"]),
  ma: new Set(["date", "lastClose", "previousClose", "bias", "maGapPercent", "arrangement", "biasLabel"]),
  chips: new Set(["date", "latestDate", "foreignConsecutive", "trustConsecutive", "foreignTotal", "trustTotal", "whaleRatio", "whaleChange", "totalPeople", "peopleChange", "retailRatio", "totalShares", "shareholdingSource", "shareholdingPartialFields"]),
  pattern: new Set(["date", "patternName", "patternDirection", "stage", "neckline", "target", "stopLoss", "confidence", "dataPoints", "breakoutDate", "distanceToNecklinePct", "atr14", "volumeRatio"]),
};

function normalizedNumber(path: string, value: number, unit?: string): number {
  return validateResearchNumber({ path, field: path, unit, value }).value;
}

function normalizedScalar(value: unknown, path: string): Scalar | undefined {
  if (typeof value === "number") return normalizedNumber(path, value);
  if (value === null || ["string", "boolean"].includes(typeof value)) return value as Scalar;
  return undefined;
}

function scalar(value: unknown, path: string): value is Scalar {
  if (typeof value === "number") normalizedNumber(path, value);
  return value === null || ["string", "number", "boolean"].includes(typeof value);
}

function pickScalars(row: Record<string, unknown>, fields: readonly string[], path: string): Record<string, Scalar> {
  return Object.fromEntries(fields.flatMap((field) => {
    const normalized = normalizedScalar(row[field], `${path}.${field}`);
    return normalized === undefined ? [] : [[field, normalized]];
  }));
}

function canonical(value: unknown, path = "research_packet"): string {
  if (typeof value === "number") {
    const field = path.replace(/^research_packet\./, "");
    return JSON.stringify(normalizeCanonicalResearchNumber(field, value));
  }
  if (Array.isArray(value)) return `[${value.map((item, index) => canonical(item, `${path}.${index}`)).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, nested]) => `${JSON.stringify(key)}:${canonical(nested, `${path}.${key}`)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function validateResearchPacketNumericPolicy(
  packet: AIResearchPacket | Omit<AIResearchPacket, "contextFingerprint">,
  includeEvidence = true,
): void {
  packet.sources.forEach((source, index) => normalizedNumber(`sources.${index}.rowCount`, source.rowCount, "count"));
  if (packet.market.price !== null) normalizedNumber("market.price", packet.market.price, "TWD");
  for (const metric of packet.fundamentals.metrics) {
    if (metric.value !== null) normalizedNumber(`fundamentals.metrics.${metric.key}`, metric.value, metric.unit);
  }
  for (const row of packet.institutional.dailyFlows) {
    for (const field of ["foreignNet", "trustNet", "dealerNet", "institutionalNet"] as const) {
      if (row[field] !== null) normalizedNumber(`institutional.${row.date}.${field}`, row[field], "shares");
    }
  }
  for (const [field, unit] of [["totalShares", "shares"], ["whaleRatio", "%"],
    ["retailRatio", "%"], ["totalPeople", "people"], ["whaleShares", "shares"],
    ["whalePeople", "people"]] as const) {
    const value = packet.tdcc[field];
    if (value !== null) normalizedNumber(`tdcc.${field}`, value, unit);
  }
  for (const id of STRATEGIES) {
    const strategy = packet.strategies[id];
    if (strategy.score !== null) normalizedNumber(`strategies.${id}.score`, strategy.score, "score");
    if (strategy.confidence !== null) normalizedNumber(`strategies.${id}.confidence`, strategy.confidence, "ratio");
    for (const [field, value] of Object.entries(strategy.details)) {
      if (typeof value === "number") normalizedNumber(`strategies.${id}.details.${field}`, value);
    }
  }
  if (includeEvidence) {
    for (const item of packet.evidence) {
      if (typeof item.value === "number") {
        validateResearchNumber({ path: item.field, field: item.field, unit: item.unit, value: item.value });
      }
    }
  }
  validateResearchNumber({ path: "tdcc", relationships: packet.tdcc });
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function normalizedDate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = value.match(/^(\d{4}-\d{2}-\d{2})(?:$|T)/);
  if (!match || Number.isNaN(Date.parse(`${match[1]}T00:00:00Z`))) return null;
  return match[1];
}

function stableRows<T>(rows: T[], key: (row: T) => string): T[] {
  const unique = new Map<string, T>();
  for (const row of rows) unique.set(canonical(row), row);
  return [...unique.values()].sort((left, right) => key(left).localeCompare(key(right))
    || canonical(left).localeCompare(canonical(right)));
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  }
  return value;
}

function cloneSources(sources: ResearchSource[]): ResearchSource[] {
  const seen = new Set<string>();
  return sources.map((source, index) => {
    if (seen.has(source.id)) throw new Error("duplicate_research_source");
    seen.add(source.id);
    return { id: source.id, dataset: source.dataset, provider: source.provider, asOf: source.asOf,
      retrievedAt: source.retrievedAt, rowCount: normalizedNumber(`sources.${index}.rowCount`, source.rowCount, "count"), estimated: source.estimated,
      status: source.status, error: source.error };
  });
}

function sourceFor(sources: ResearchSource[], dataset: string, requested?: string | null): ResearchSource | null {
  if (requested) {
    const found = sources.find((source) => source.id === requested);
    if (!found) throw new Error("research_evidence_source_not_found");
    return found.status === "available" ? found : null;
  }
  return sources.find((source) => source.dataset === dataset && source.status === "available") ?? null;
}

function evidenceId(item: Omit<ResearchEvidence, "id">): string {
  const identity = { dataset: item.dataset, field: item.field, date: item.date, sourceId: item.sourceId };
  return `ev:${createHash("sha256").update(canonical(identity)).digest("hex").slice(0, 20)}`;
}

function addEvidence(target: Map<string, ResearchEvidence>, source: ResearchSource | null, field: string,
  value: Scalar, unit: string, date: string | null): void {
  if (!source) return;
  const normalized = typeof value === "number"
    ? validateResearchNumber({ path: field, field, unit: unit || undefined, value }) : null;
  const item = { dataset: source.dataset, field, value: normalized?.value ?? value,
    unit: normalized?.canonicalUnit ?? unit, date, sourceId: source.id,
    estimated: source.estimated, available: value !== null };
  const evidence = { id: evidenceId(item), ...item };
  const existing = target.get(evidence.id);
  if (existing && canonical(existing) !== canonical(evidence)) throw new Error(`research_evidence_collision:${evidence.id}`);
  if (!existing) target.set(evidence.id, evidence);
}

function buildEvidence(packet: Omit<AIResearchPacket, "evidence" | "contextFingerprint">): ResearchEvidence[] {
  const evidence = new Map<string, ResearchEvidence>();
  const company = sourceFor(packet.sources, "stock_meta");
  const companyDate = company?.asOf ?? null;
  addEvidence(evidence, company, "stockId", packet.stockId, "stock_id", companyDate);
  addEvidence(evidence, company, "company.name", packet.company.name, "", companyDate);
  addEvidence(evidence, company, "company.market", packet.company.market, "", companyDate);
  addEvidence(evidence, company, "company.industry", packet.company.industry, "", companyDate);
  const market = sourceFor(packet.sources, "stock_price");
  addEvidence(evidence, market, "asOf", packet.asOf, "date", packet.asOf);
  addEvidence(evidence, market, "market.latestDate", packet.market.latestDate, "date", packet.market.latestDate);
  addEvidence(evidence, market, "market.price", packet.market.price, "TWD", packet.market.latestDate);
  for (const metric of packet.fundamentals.metrics) {
    addEvidence(evidence, sourceFor(packet.sources, "financials", metric.sourceId),
      `fundamentals.metrics.${metric.key}`, metric.value, metric.unit, metric.period);
  }
  const institutional = sourceFor(packet.sources, "stock_institutional");
  for (const row of packet.institutional.dailyFlows) {
    addEvidence(evidence, institutional, `institutional.${row.date}.date`, row.date, "date", row.date);
    for (const field of ["foreignNet", "trustNet", "dealerNet", "institutionalNet"] as const) {
      addEvidence(evidence, institutional, `institutional.${row.date}.${field}`, row[field], "shares", row.date);
    }
  }
  const tdcc = sourceFor(packet.sources, "tdcc_shareholding");
  for (const [field, unit] of [["date", "date"], ["source", "source"], ["totalShares", "shares"],
    ["whaleRatio", "%"], ["retailRatio", "%"], ["totalPeople", "people"],
    ["whaleShares", "shares"], ["whalePeople", "people"]] as const) {
    addEvidence(evidence, tdcc, `tdcc.${field}`, packet.tdcc[field], unit, packet.tdcc.date);
  }
  const risk = sourceFor(packet.sources, "stock_trade_risk");
  addEvidence(evidence, risk, "tradeRisks.highestLevel", packet.tradeRisks.highestLevel, "level", packet.tradeRisks.dataAsOf);
  addEvidence(evidence, risk, "tradeRisks.dataAsOf", packet.tradeRisks.dataAsOf, "date", packet.tradeRisks.dataAsOf);
  packet.tradeRisks.flags.forEach((flag, index) => {
    const picked = pickScalars(flag, RISK_FIELDS, `tradeRisks.flags.${index}`);
    for (const field of ["source_updated_at", "announced_date", "start_date", "end_date"] as const) {
      if (field in picked) picked[field] = normalizedDate(picked[field]);
    }
    const eventDate = [picked.source_updated_at, picked.announced_date, picked.start_date,
      packet.tradeRisks.dataAsOf].map(normalizedDate).find((value): value is string => value !== null) ?? null;
    for (const [field, value] of Object.entries(picked)) {
      addEvidence(evidence, risk, `tradeRisks.flags.${index}.${field}`, value,
        field.endsWith("date") || field === "source_updated_at" ? "date" : "", eventDate);
    }
  });
  for (const id of STRATEGIES) {
    const result = packet.strategies[id];
    const source = sourceFor(packet.sources, `strategy_${id}`);
    for (const [field, value, unit] of [["date", result.date, "date"], ["status", result.status, "status"],
      ["score", result.score, "score"], ["signal", result.signal, "signal"],
      ["confidence", result.confidence, "ratio"], ["summary", result.summary, "text"]] as const) {
      addEvidence(evidence, source, `strategies.${id}.${field}`, value, unit, result.date);
    }
    for (const [field, value] of Object.entries(result.details)) {
      if (STRATEGY_DETAIL_FIELDS[id].has(field) && scalar(value, `strategies.${id}.details.${field}`)) {
        addEvidence(evidence, source, `strategies.${id}.details.${field}`, value, "", result.date);
      }
    }
  }
  return [...evidence.values()].sort((left, right) => left.id.localeCompare(right.id));
}

function fingerprintInput(packet: Omit<AIResearchPacket, "contextFingerprint">) {
  return { ...packet, sources: packet.sources.map(({ retrievedAt: _retrievedAt, ...source }) => source)
    .sort((left, right) => left.id.localeCompare(right.id)) };
}

export function buildResearchPacket(context: ResearchContext): AIResearchPacket {
  const flows = stableRows(context.institutional.dailyFlows.map((row) => ({
    date: row.date,
    foreignNet: row.foreignNet === null ? null : normalizedNumber(`institutional.${row.date}.foreignNet`, row.foreignNet, "shares"),
    trustNet: row.trustNet === null ? null : normalizedNumber(`institutional.${row.date}.trustNet`, row.trustNet, "shares"),
    dealerNet: row.dealerNet === null ? null : normalizedNumber(`institutional.${row.date}.dealerNet`, row.dealerNet, "shares"),
    institutionalNet: row.institutionalNet === null ? null
      : normalizedNumber(`institutional.${row.date}.institutionalNet`, row.institutionalNet, "shares"),
  })), (row) => row.date);
  const riskFlags = stableRows(context.tradeRisks.flags.map((flag, index) => {
    const picked = pickScalars(flag, RISK_FIELDS, `tradeRisks.flags.${index}`);
    for (const field of ["source_updated_at", "announced_date", "start_date", "end_date"] as const) {
      if (field in picked) picked[field] = normalizedDate(picked[field]);
    }
    return picked;
  }),
    (flag) => [flag.source_updated_at, flag.announced_date, flag.start_date, flag.risk_type]
      .filter((value): value is string => typeof value === "string").join("|"));
  const metrics = stableRows(context.fundamentals.metrics.map((metric) => {
    const path = `fundamentals.metrics.${metric.key}`;
    const normalized = metric.value === null ? null : validateResearchNumber({
      path, field: path, unit: metric.unit, value: metric.value,
    });
    return { key: metric.key, value: normalized?.value ?? null,
      available: metric.available, unit: normalized?.canonicalUnit ?? metric.unit,
      period: metric.period, sourceId: metric.sourceId };
  }), (metric) => `${metric.key}|${metric.period ?? ""}|${metric.sourceId ?? ""}`);
  const base = {
    schemaVersion: 1 as const, stockId: context.stockId, asOf: context.asOf,
    company: { name: context.company.name, market: context.company.market, industry: context.company.industry },
    market: { latestDate: context.market.latestDate, price: context.market.price === null ? null
      : normalizedNumber("market.price", context.market.price, "TWD") },
    fundamentals: { status: context.fundamentals.status,
      metrics,
      missing: uniqueSorted(context.fundamentals.missing) },
    institutional: { dailyFlows: flows },
    tdcc: { date: context.tdcc.date, source: context.tdcc.source,
      totalShares: context.tdcc.totalShares === null ? null : normalizedNumber("tdcc.totalShares", context.tdcc.totalShares, "shares"),
      whaleRatio: context.tdcc.whaleRatio === null ? null : normalizedNumber("tdcc.whaleRatio", context.tdcc.whaleRatio, "%"),
      retailRatio: context.tdcc.retailRatio === null ? null : normalizedNumber("tdcc.retailRatio", context.tdcc.retailRatio, "%"),
      totalPeople: context.tdcc.totalPeople === null ? null : normalizedNumber("tdcc.totalPeople", context.tdcc.totalPeople, "people"),
      whaleShares: context.tdcc.whaleShares === null ? null : normalizedNumber("tdcc.whaleShares", context.tdcc.whaleShares, "shares"),
      whalePeople: context.tdcc.whalePeople === null ? null : normalizedNumber("tdcc.whalePeople", context.tdcc.whalePeople, "people") },
    tradeRisks: { highestLevel: context.tradeRisks.highestLevel,
      flags: riskFlags, dataAsOf: context.tradeRisks.dataAsOf },
    strategies: Object.fromEntries(STRATEGIES.map((id) => {
      const result = context.strategies[id];
      return [id, { strategy: id, status: result.status, date: result.date,
        score: result.score === null ? null : normalizedNumber(`strategies.${id}.score`, result.score, "score"),
        signal: result.signal, confidence: result.confidence === null ? null
          : normalizedNumber(`strategies.${id}.confidence`, result.confidence, "ratio"), summary: result.summary,
        details: pickScalars(result.details, [...STRATEGY_DETAIL_FIELDS[id]], `strategies.${id}.details`) }];
    })) as ResearchContext["strategies"],
    dataQuality: { status: context.quality.status, missingDatasets: uniqueSorted(context.quality.missingDatasets),
      staleDatasets: uniqueSorted(context.quality.staleDatasets), warnings: uniqueSorted(context.quality.warnings),
      informationRichness: "C" as const },
    sources: cloneSources(context.sources),
  };
  validateResearchNumber({ path: "tdcc", relationships: base.tdcc });
  const draft = { ...base, evidence: [] } as Omit<AIResearchPacket, "contextFingerprint">;
  draft.dataQuality.informationRichness = evaluateInformationRichness(draft as AIResearchPacket).grade;
  draft.evidence = buildEvidence(draft);
  validateResearchPacketNumericPolicy(draft);
  const contextFingerprint = createHash("sha256").update(canonical(fingerprintInput(draft))).digest("hex");
  return deepFreeze({ ...draft, contextFingerprint });
}

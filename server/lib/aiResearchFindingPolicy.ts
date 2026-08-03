import type {
  AIResearchPacket,
  EvidenceFragment,
  RenderedResearchClaim,
  ResearchEvidence,
  ResearchFindingKind,
  ResearchFindingStance,
  ResearchLimitationReasonCode,
  StructuredResearchFinding,
  StructuredResearchLimitation,
} from "../../shared/aiResearch";
import { validateResearchNumber } from "./aiResearchNumericPolicy";
import { validateResearchPacketNumericPolicy } from "./aiResearchPacket";

type ValueType = "number" | "label" | "date";
type Dimension = "currency" | "ratio" | "shares" | "people" | "accounts" | "count"
  | "score" | "label" | "date";
type ResolvedFragment = { fragment: EvidenceFragment; evidence: ResearchEvidence; dimension: Dimension };
type FragmentRule = {
  role: EvidenceFragment["role"];
  format: EvidenceFragment["format"];
  field: RegExp;
  valueType: ValueType;
  dimensions: readonly Dimension[];
};
type FindingPolicy = {
  datasets: readonly string[];
  variants: readonly (readonly FragmentRule[])[];
  allowEstimated: boolean;
  render: (finding: StructuredResearchFinding, fragments: ResolvedFragment[]) => string;
};

const rule = (role: FragmentRule["role"], format: FragmentRule["format"], field: RegExp,
  valueType: ValueType, dimensions: readonly Dimension[]): FragmentRule =>
  ({ role, format, field, valueType, dimensions });

const numberValue = (field: RegExp, dimensions: readonly Dimension[]) =>
  rule("value", "value_with_unit", field, "number", dimensions);
const dateValue = (field: RegExp) => rule("date", "date", field, "date", ["date"]);
const labelValue = (field: RegExp, roleName: FragmentRule["role"] = "subject") =>
  rule(roleName, "label", field, "label", ["label"]);

const FIELD_LABELS: Record<string, string> = {
  stockId: "股票代號", "company.name": "公司", "company.market": "市場", "company.industry": "產業",
  "market.price": "收盤價", "tdcc.whaleRatio": "千張大戶比率", "tdcc.retailRatio": "散戶比率",
  "tdcc.totalShares": "集保總股數", "tdcc.totalPeople": "集保總人數", "tdcc.whaleShares": "千張大戶股數",
  "tdcc.whalePeople": "千張大戶人數", "tradeRisks.highestLevel": "最高交易風險",
};

function fieldLabel(field: string): string {
  if (field.endsWith(".foreignNet")) return "外資買賣超";
  if (field.endsWith(".trustNet")) return "投信買賣超";
  if (field.endsWith(".dealerNet")) return "自營商買賣超";
  if (field.endsWith(".institutionalNet")) return "三大法人買賣超";
  return FIELD_LABELS[field] ?? field.split(".").at(-1) ?? field;
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("zh-TW", { maximumFractionDigits: 8 }).format(value);
}

function formatEvidence(item: ResearchEvidence, dimension: Dimension): string {
  if (typeof item.value !== "number") return String(item.value);
  const normalized = validateResearchNumber({
    path: item.field, field: item.field, unit: item.unit, value: item.value,
  });
  if (dimension === "ratio") {
    return `${formatNumber(normalized.displayValue)}%`;
  }
  const suffix: Partial<Record<Dimension, string>> = {
    currency: "元", shares: "股", people: "人", accounts: "戶", count: "", score: "分",
  };
  return `${formatNumber(normalized.value)}${suffix[dimension] ?? ""}`;
}

function renderSingle(_finding: StructuredResearchFinding, fragments: ResolvedFragment[]): string {
  const item = fragments[0];
  return `${fieldLabel(item.evidence.field)}：${formatEvidence(item.evidence, item.dimension)}`;
}

function renderDated(_finding: StructuredResearchFinding, fragments: ResolvedFragment[]): string {
  return `截至 ${String(fragments[1].evidence.value)}，${fieldLabel(fragments[0].evidence.field)}為 ${formatEvidence(fragments[0].evidence, fragments[0].dimension)}`;
}

const COMPANY_VARIANTS = ["stockId", "company.name", "company.market", "company.industry"]
  .map((field) => [labelValue(new RegExp(`^${field.replace(".", "\\.")}$`))] as const);
const TDCC_VARIANTS = [
  [numberValue(/^tdcc\.(?:whaleRatio|retailRatio)$/, ["ratio"]), dateValue(/^tdcc\.date$/)],
  [numberValue(/^tdcc\.(?:totalShares|whaleShares)$/, ["shares"]), dateValue(/^tdcc\.date$/)],
  [numberValue(/^tdcc\.(?:totalPeople|whalePeople)$/, ["people"]), dateValue(/^tdcc\.date$/)],
] as const;

export const RESEARCH_FINDING_POLICIES: Readonly<Record<Exclude<ResearchFindingKind,
  "evidence_comparison" | "limitation">, FindingPolicy>> = Object.freeze({
  company_fact: { datasets: ["stock_meta"], variants: COMPANY_VARIANTS, allowEstimated: false, render: renderSingle },
  market_snapshot: { datasets: ["stock_price"], variants: [[numberValue(/^market\.price$/, ["currency"]), dateValue(/^market\.latestDate$/)]],
    allowEstimated: false, render: renderDated },
  financial_metric: { datasets: ["financials", "TaiwanStockFinancialStatements", "TaiwanStockBalanceSheet",
    "TaiwanStockCashFlowsStatement", "TaiwanStockMonthRevenue", "TaiwanStockPER", "TaiwanStockDividend"],
    variants: [[numberValue(/^fundamentals\.metrics\.[A-Za-z0-9_.-]+$/,
    ["currency", "ratio", "shares", "people", "accounts", "count", "score"])]],
    allowEstimated: true, render: renderSingle },
  institutional_flow: { datasets: ["stock_institutional"], variants: [[numberValue(/^institutional\.\d{4}-\d{2}-\d{2}\.(?:foreignNet|trustNet|dealerNet|institutionalNet)$/,
    ["shares"]), dateValue(/^institutional\.\d{4}-\d{2}-\d{2}\.date$/)]], allowEstimated: false, render: renderDated },
  tdcc_concentration: { datasets: ["tdcc_shareholding"], variants: TDCC_VARIANTS, allowEstimated: false, render: renderDated },
  trade_risk: { datasets: ["stock_trade_risk"], variants: [[labelValue(/^tradeRisks\.highestLevel$/, "risk")]], allowEstimated: false, render: renderSingle },
  strategy_result: { datasets: ["strategy_sr", "strategy_ma", "strategy_chips", "strategy_pattern"],
    variants: [[labelValue(/^strategies\.(?:sr|ma|chips|pattern)\.signal$/),
    dateValue(/^strategies\.(?:sr|ma|chips|pattern)\.date$/)]], allowEstimated: false, render: renderDated },
});

export const RESEARCH_LIMITATION_REASON_CODES: ReadonlySet<ResearchLimitationReasonCode> = new Set([
  "missing_dataset", "stale_dataset", "unavailable_source", "insufficient_coverage",
]);

function isoDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

function dimension(item: ResearchEvidence): Dimension | null {
  const unit = item.unit.trim().toLowerCase();
  if (unit === "date") return "date";
  if (["", "stock_id", "level", "signal", "status", "source", "text"].includes(unit)) return "label";
  if (typeof item.value !== "number") return null;
  return validateResearchNumber({
    path: item.field, field: item.field, unit: item.unit, value: item.value,
  }).dimension;
}

function validateValue(ruleItem: FragmentRule, item: ResearchEvidence, asOf: string | null): Dimension {
  const itemDimension = dimension(item);
  if (!itemDimension || !ruleItem.dimensions.includes(itemDimension)) throw new Error(`finding_measurement_mismatch:${item.field}`);
  if (ruleItem.valueType === "number" && typeof item.value !== "number") {
    throw new Error(`finding_numeric_value_required:${item.field}`);
  }
  if (ruleItem.valueType === "label" && typeof item.value !== "string") {
    throw new Error(`finding_label_value_required:${item.field}`);
  }
  if (ruleItem.valueType === "date") {
    if (!isoDate(item.value) || item.unit !== "date" || item.date !== item.value) {
      throw new Error(`finding_iso_date_required:${item.field}`);
    }
    if (asOf && item.value > asOf) throw new Error(`finding_future_date:${item.field}`);
  }
  return itemDimension;
}

export function resolveResearchEvidenceRegistry(packet: AIResearchPacket): Map<string, ResearchEvidence> {
  const registry = new Map<string, ResearchEvidence>();
  for (const item of packet.evidence) {
    const existing = registry.get(item.id);
    if (existing) {
      if (JSON.stringify(existing) === JSON.stringify(item)) throw new Error(`duplicate_evidence_id:${item.id}`);
      throw new Error(`research_evidence_collision:${item.id}`);
    }
    registry.set(item.id, item);
  }
  return registry;
}

function resolveFragments(finding: StructuredResearchFinding, packet: AIResearchPacket): ResolvedFragment[] {
  const registry = resolveResearchEvidenceRegistry(packet);
  const sources = new Map<string, AIResearchPacket["sources"][number]>();
  for (const source of packet.sources) {
    if (sources.has(source.id)) throw new Error(`duplicate_research_source:${source.id}`);
    sources.set(source.id, source);
  }
  return finding.fragments.map((fragment) => {
    const item = registry.get(fragment.evidenceId);
    if (!item) throw new Error(`finding_evidence_not_found:${fragment.evidenceId}`);
    if (!item.available || item.value === null) throw new Error(`finding_evidence_unavailable:${fragment.evidenceId}`);
    if (sources.get(item.sourceId)?.status !== "available") throw new Error(`finding_source_unavailable:${item.sourceId}`);
    return { fragment, evidence: item, dimension: typeof item.value === "number" ? "label" : dimension(item) ?? "label" };
  });
}

function validateFixedPolicy(finding: StructuredResearchFinding, packet: AIResearchPacket,
  fragments: ResolvedFragment[]): { fragments: ResolvedFragment[]; text: string; estimated: boolean } {
  const policy = RESEARCH_FINDING_POLICIES[finding.kind as keyof typeof RESEARCH_FINDING_POLICIES];
  if (!policy) throw new Error(`finding_policy_missing:${finding.id}`);
  if (fragments.some((fragment) => !policy.datasets.includes(fragment.evidence.dataset))) {
    throw new Error(`finding_domain_mismatch:${finding.id}`);
  }
  for (const fragment of fragments) {
    if (typeof fragment.evidence.value === "number") {
      try {
        const validated = validateResearchNumber({ path: fragment.evidence.field,
          field: fragment.evidence.field, unit: fragment.evidence.unit, value: fragment.evidence.value });
        fragment.evidence = { ...fragment.evidence, value: validated.value,
          unit: validated.canonicalUnit };
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        const detail = message.startsWith("research_packet_unknown_unit:")
          ? ":research_packet_unknown_unit"
          : message.startsWith("research_packet_unknown_numeric_contract:")
            ? ":research_packet_unknown_numeric_contract" : "";
        throw new Error(`finding_numeric_policy_violation:${finding.id}:${fragment.evidence.field}${detail}`);
      }
    }
  }
  const variant = policy.variants.find((candidate) => candidate.length === fragments.length
    && candidate.every((ruleItem, index) => ruleItem.role === fragments[index].fragment.role
      && ruleItem.format === fragments[index].fragment.format
      && ruleItem.field.test(fragments[index].evidence.field)));
  if (!variant) throw new Error(`finding_policy_mismatch:${finding.id}`);
  fragments.forEach((fragment, index) => {
    fragment.dimension = validateValue(variant[index], fragment.evidence, packet.asOf);
  });
  if (!policy.allowEstimated && fragments.some((fragment) => fragment.evidence.estimated)) {
    throw new Error(`finding_estimated_not_allowed:${finding.id}`);
  }
  if (finding.kind === "strategy_result") {
    if (!finding.strategyId || fragments.some((fragment) => fragment.evidence.dataset !== `strategy_${finding.strategyId}`
      || !fragment.evidence.field.startsWith(`strategies.${finding.strategyId}.`))) {
      throw new Error(`finding_domain_mismatch:${finding.id}:strategy`);
    }
  }
  if (fragments.length === 2 && fragments[1].fragment.role === "date"
    && fragments[0].evidence.date !== fragments[1].evidence.value) {
    throw new Error(`finding_date_mismatch:${finding.id}`);
  }
  if (["institutional_flow", "strategy_result"].includes(finding.kind) && fragments.length === 2
    && fragments[0].evidence.field.replace(/\.[^.]+$/, ".date") !== fragments[1].evidence.field) {
    throw new Error(`finding_date_field_mismatch:${finding.id}`);
  }
  const estimated = fragments.some((fragment) => fragment.evidence.estimated);
  return { fragments, text: `${policy.render(finding, fragments)}${estimated ? "（估算）" : ""}`, estimated };
}

function comparisonDateField(value: ResearchEvidence, date: ResearchEvidence): boolean {
  if (value.dataset !== date.dataset) return false;
  if (value.dataset === "tdcc_shareholding") return date.field === "tdcc.date";
  if (value.dataset.startsWith("strategy_")) return date.field === value.field.replace(/\.[^.]+$/, ".date");
  if (value.dataset === "stock_institutional") return date.field === value.field.replace(/\.[^.]+$/, ".date");
  return false;
}

function comparisonMeasurementIdentity(item: ResearchEvidence): string | null {
  if (item.dataset === "stock_institutional") {
    const match = item.field.match(/^institutional\.\d{4}-\d{2}-\d{2}\.(foreignNet|trustNet|dealerNet|institutionalNet)$/);
    return match ? `${item.dataset}:${match[1]}` : null;
  }
  if (item.dataset === "tdcc_shareholding" && /^tdcc\.(?:whaleRatio|retailRatio|totalShares|totalPeople|whaleShares|whalePeople)$/.test(item.field)) {
    return `${item.dataset}:${item.field}`;
  }
  if (item.dataset.startsWith("strategy_") && /^strategies\.(?:sr|ma|chips|pattern)\.(?:score|confidence)$/.test(item.field)) {
    return `${item.dataset}:${item.field}`;
  }
  return null;
}

function comparisonDateValue(item: ResearchEvidence, asOf: string | null, findingId: string): string {
  if (!isoDate(item.value) || item.unit !== "date" || item.date !== item.value) {
    throw new Error(`comparison_date_mismatch:${findingId}`);
  }
  if (asOf && item.value > asOf) throw new Error(`comparison_future_date:${findingId}`);
  return item.value;
}

function validateComparison(finding: StructuredResearchFinding, packet: AIResearchPacket,
  fragments: ResolvedFragment[]): { fragments: ResolvedFragment[]; text: string; estimated: boolean } {
  const expected = [
    ["current", "value_with_unit"], ["previous", "value_with_unit"],
    ["current_date", "date"], ["previous_date", "date"],
  ] as const;
  if (fragments.length !== expected.length || fragments.some((item, index) =>
    item.fragment.role !== expected[index][0] || item.fragment.format !== expected[index][1])) {
    throw new Error(`comparison_fragment_contract:${finding.id}`);
  }
  const [current, previous, currentDate, previousDate] = fragments;
  const currentIdentity = comparisonMeasurementIdentity(current.evidence);
  const previousIdentity = comparisonMeasurementIdentity(previous.evidence);
  if (!currentIdentity || currentIdentity !== previousIdentity) {
    throw new Error(`comparison_measurement_identity_mismatch:${finding.id}`);
  }
  if (typeof current.evidence.value !== "number" || typeof previous.evidence.value !== "number") {
    throw new Error(`comparison_numeric_value_required:${finding.id}`);
  }
  try {
    const currentValue = validateResearchNumber({ path: current.evidence.field, field: current.evidence.field,
      unit: current.evidence.unit, value: current.evidence.value });
    const previousValue = validateResearchNumber({ path: previous.evidence.field, field: previous.evidence.field,
      unit: previous.evidence.unit, value: previous.evidence.value });
    current.evidence = { ...current.evidence, value: currentValue.value,
      unit: currentValue.canonicalUnit };
    previous.evidence = { ...previous.evidence, value: previousValue.value,
      unit: previousValue.canonicalUnit };
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message.startsWith("research_packet_numeric_unit_mismatch:")) {
      throw new Error(`comparison_dimension_mismatch:${finding.id}`);
    }
    if (message.startsWith("research_packet_unknown_unit:")) {
      throw new Error(`comparison_unit_mismatch:${finding.id}`);
    }
    throw new Error(`comparison_numeric_value_required:${finding.id}`);
  }
  const currentDimension = dimension(current.evidence);
  const previousDimension = dimension(previous.evidence);
  if (!currentDimension || !previousDimension || ["label", "date"].includes(currentDimension)
    || ["label", "date"].includes(previousDimension)) throw new Error(`comparison_unit_mismatch:${finding.id}`);
  if (currentDimension !== previousDimension) throw new Error(`comparison_dimension_mismatch:${finding.id}`);
  current.dimension = currentDimension;
  previous.dimension = previousDimension;
  const currentDateValue = comparisonDateValue(currentDate.evidence, packet.asOf, finding.id);
  const previousDateValue = comparisonDateValue(previousDate.evidence, packet.asOf, finding.id);
  currentDate.dimension = "date";
  previousDate.dimension = "date";
  if (!comparisonDateField(current.evidence, currentDate.evidence)
    || !comparisonDateField(previous.evidence, previousDate.evidence)
    || current.evidence.date !== currentDate.evidence.value || previous.evidence.date !== previousDate.evidence.value
    || currentDateValue <= previousDateValue) {
    throw new Error(`comparison_date_mismatch:${finding.id}`);
  }
  if (fragments.some((item) => item.evidence.estimated)) throw new Error(`finding_estimated_not_allowed:${finding.id}`);
  const currentNormalized = validateResearchNumber({ path: current.evidence.field,
    field: current.evidence.field, unit: current.evidence.unit,
    value: Number(current.evidence.value) }).displayValue;
  const previousNormalized = validateResearchNumber({ path: previous.evidence.field,
    field: previous.evidence.field, unit: previous.evidence.unit,
    value: Number(previous.evidence.value) }).displayValue;
  const direction = currentNormalized === previousNormalized ? "持平" : currentNormalized > previousNormalized ? "上升" : "下降";
  return { fragments, estimated: false,
    text: `${fieldLabel(current.evidence.field)}由 ${formatEvidence(previous.evidence, previous.dimension)}（${previousDate.evidence.value}）至 ${formatEvidence(current.evidence, current.dimension)}（${currentDate.evidence.value}），呈${direction}` };
}

const DATASET_LABELS: Record<string, string> = {
  stock_meta: "公司基本資料", financials: "財務資料", eps: "每股盈餘資料",
  TaiwanStockFinancialStatements: "財務報表", TaiwanStockBalanceSheet: "資產負債表",
  TaiwanStockCashFlowsStatement: "現金流量表", TaiwanStockMonthRevenue: "月營收資料",
  TaiwanStockPER: "估值資料", TaiwanStockDividend: "股利資料",
  stock_price: "行情資料", stock_institutional: "法人資料",
  tdcc_shareholding: "TDCC 資料", stock_trade_risk: "交易風險資料",
  strategy_sr: "支撐壓力策略", strategy_ma: "均線策略", strategy_chips: "籌碼策略",
  strategy_pattern: "型態策略",
};
const LIMITATION_TEXT: Record<ResearchLimitationReasonCode, string> = {
  missing_dataset: "目前缺少{dataset}", stale_dataset: "{dataset}已逾時",
  unavailable_source: "{dataset}來源目前不可用", insufficient_coverage: "{dataset}涵蓋不足",
};
const RUNTIME_FINDING_KEYS = new Set(["id", "kind", "stance", "strategyId", "fragments", "limitation"]);
const RUNTIME_FRAGMENT_KEYS = new Set(["evidenceId", "role", "format"]);
const RUNTIME_LIMITATION_KEYS = new Set(["datasetId", "reasonCode", "sourceId", "asOf"]);
const FINDING_KINDS = new Set<ResearchFindingKind>([
  "company_fact", "market_snapshot", "financial_metric", "institutional_flow",
  "tdcc_concentration", "trade_risk", "strategy_result", "evidence_comparison", "limitation",
]);
const FINDING_STANCES = new Set<ResearchFindingStance>(["positive", "neutral", "negative", "insufficient"]);
const FRAGMENT_ROLES = new Set(["subject", "value", "current", "previous", "date", "risk", "current_date", "previous_date"]);
const FRAGMENT_FORMATS = new Set(["value", "value_with_unit", "date", "label"]);
const STRATEGY_IDS = new Set(["sr", "ma", "chips", "pattern"]);

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function exactRuntimeKeys(item: Record<string, unknown>, allowed: Set<string>): boolean {
  return Object.keys(item).every((key) => allowed.has(key));
}

function parseRuntimeLimitation(value: unknown, findingId: string): StructuredResearchLimitation | undefined {
  if (value === undefined) return undefined;
  const item = record(value);
  if (!item || !exactRuntimeKeys(item, RUNTIME_LIMITATION_KEYS) || typeof item.datasetId !== "string"
    || typeof item.reasonCode !== "string" || !(item.sourceId === null || typeof item.sourceId === "string")
    || !(item.asOf === null || typeof item.asOf === "string")) {
    throw new Error(`invalid_limitation_contract:${findingId}`);
  }
  return { datasetId: item.datasetId, reasonCode: item.reasonCode as ResearchLimitationReasonCode,
    sourceId: item.sourceId, asOf: item.asOf };
}

function parseRuntimeFragments(value: unknown, findingId: string): EvidenceFragment[] {
  if (!Array.isArray(value)) throw new Error(`invalid_fragments:${findingId}`);
  const fragments = value.map((raw) => {
    const item = record(raw);
    if (!item || !exactRuntimeKeys(item, RUNTIME_FRAGMENT_KEYS) || typeof item.evidenceId !== "string"
      || !FRAGMENT_ROLES.has(String(item.role)) || !FRAGMENT_FORMATS.has(String(item.format))) {
      throw new Error(`invalid_fragment:${findingId}`);
    }
    return item as unknown as EvidenceFragment;
  });
  const evidenceIds = fragments.map((fragment) => fragment.evidenceId);
  const duplicate = evidenceIds.find((id, index) => evidenceIds.indexOf(id) !== index);
  if (duplicate) throw new Error(`duplicate_fragment_evidence:${findingId}:${duplicate}`);
  return fragments;
}

function parseRuntimeFinding(value: unknown): StructuredResearchFinding {
  const item = record(value);
  const unsafeId = typeof item?.id === "string" ? item.id : "";
  if (item && "text" in item) throw new Error(`raw_factual_text_forbidden:${unsafeId || "unknown"}`);
  if (!item || !exactRuntimeKeys(item, RUNTIME_FINDING_KEYS)) throw new Error(`invalid_finding_contract:${unsafeId || "unknown"}`);
  if (typeof item.id !== "string" || !/^[a-z][a-z0-9._:-]{0,63}$/.test(item.id)) {
    throw new Error(`finding_invalid_id:${unsafeId}`);
  }
  if (!FINDING_KINDS.has(item.kind as ResearchFindingKind)) throw new Error(`finding_invalid_kind:${item.id}`);
  if (!FINDING_STANCES.has(item.stance as ResearchFindingStance)) throw new Error(`finding_invalid_stance:${item.id}`);
  const fragments = parseRuntimeFragments(item.fragments, item.id);
  const limitation = parseRuntimeLimitation(item.limitation, item.id);
  if (item.kind === "strategy_result" && !STRATEGY_IDS.has(String(item.strategyId))) {
    throw new Error(`invalid_strategy_id:${item.id}`);
  }
  if (item.kind !== "strategy_result" && item.strategyId !== undefined) throw new Error(`unexpected_strategy_id:${item.id}`);
  if (item.kind === "limitation" && (!limitation || fragments.length !== 0)) throw new Error(`invalid_limitation_finding:${item.id}`);
  if (item.kind !== "limitation" && (limitation !== undefined || fragments.length === 0)) {
    throw new Error(`invalid_evidence_finding:${item.id}`);
  }
  return { id: item.id, kind: item.kind as ResearchFindingKind, stance: item.stance as ResearchFindingStance,
    ...(item.strategyId ? { strategyId: item.strategyId as StructuredResearchFinding["strategyId"] } : {}),
    fragments, ...(limitation ? { limitation } : {}) };
}

function validateLimitation(finding: StructuredResearchFinding, packet: AIResearchPacket) {
  const limitation = finding.limitation;
  if (!limitation || finding.fragments.length !== 0 || finding.stance !== "insufficient"
    || !RESEARCH_LIMITATION_REASON_CODES.has(limitation.reasonCode)
    || !Object.hasOwn(DATASET_LABELS, limitation.datasetId)) {
    throw new Error(`invalid_limitation_contract:${finding.id}`);
  }
  const missing = packet.dataQuality.missingDatasets.includes(limitation.datasetId);
  const stale = packet.dataQuality.staleDatasets.includes(limitation.datasetId);
  const source = limitation.sourceId === null ? null : packet.sources.find((item) => item.id === limitation.sourceId);
  const gapMatches = limitation.reasonCode === "missing_dataset" ? missing
    : limitation.reasonCode === "stale_dataset" ? stale
      : limitation.reasonCode === "unavailable_source" ? missing && source?.status !== "available"
        : (missing || stale) && source !== null;
  if (!gapMatches) throw new Error(`limitation_quality_mismatch:${finding.id}`);
  if (limitation.asOf !== null && (!isoDate(limitation.asOf) || Boolean(packet.asOf && limitation.asOf > packet.asOf))) {
    throw new Error(`invalid_limitation_date:${finding.id}`);
  }
  if (limitation.sourceId !== null) {
    if (!source || source.dataset !== limitation.datasetId || source.asOf !== limitation.asOf) {
      throw new Error(`invalid_limitation_source:${finding.id}`);
    }
  }
  if (["stale_dataset", "unavailable_source", "insufficient_coverage"].includes(limitation.reasonCode)
    && limitation.sourceId === null) throw new Error(`limitation_source_required:${finding.id}`);
  if (limitation.reasonCode === "missing_dataset" && limitation.sourceId === null && limitation.asOf !== null) {
    throw new Error(`invalid_limitation_date:${finding.id}`);
  }
  return { fragments: [] as ResolvedFragment[], estimated: false,
    text: LIMITATION_TEXT[limitation.reasonCode].replace("{dataset}", DATASET_LABELS[limitation.datasetId]) };
}

function applyResearchFindingPolicy(finding: StructuredResearchFinding, packet: AIResearchPacket) {
  const fragments = resolveFragments(finding, packet);
  if (finding.kind === "limitation") return validateLimitation(finding, packet);
  if (finding.limitation !== undefined) throw new Error(`unexpected_limitation:${finding.id}`);
  if (finding.kind === "evidence_comparison") return validateComparison(finding, packet, fragments);
  return validateFixedPolicy(finding, packet, fragments);
}

export interface ValidatedResearchFindingRuntime {
  finding: StructuredResearchFinding;
  renderedClaim: RenderedResearchClaim;
}

export function validateResearchFindingRuntime(value: unknown, packet: AIResearchPacket): ValidatedResearchFindingRuntime {
  // Core packet fields are validated here; referenced evidence is validated by the
  // same finding policy below so renderer and auditor return the stable finding code.
  validateResearchPacketNumericPolicy(packet, false);
  const finding = parseRuntimeFinding(value);
  const result = applyResearchFindingPolicy(finding, packet);
  return { finding, renderedClaim: {
    id: finding.id, kind: finding.kind, stance: finding.stance, text: result.text,
    evidenceIds: finding.fragments.map((fragment) => fragment.evidenceId),
    limitations: finding.kind === "limitation" ? [result.text] : [], estimated: result.estimated,
  } };
}

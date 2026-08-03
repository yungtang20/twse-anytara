export type ResearchNumericDimension =
  | "currency" | "shares" | "people" | "accounts" | "count" | "ratio" | "score";
export type ResearchNumericPolicy =
  | "signed_safe_integer" | "nonnegative_safe_integer" | "finite" | "nonnegative_finite" | "bounded";
type CanonicalUnit = "TWD" | "shares" | "people" | "accounts" | "count" | "%" | "ratio" | "score";
type UnitPolicy = Readonly<{ canonicalUnit: CanonicalUnit; dimension: ResearchNumericDimension;
  defaultPolicy: ResearchNumericPolicy; displayMultiplier: number }>;
type FieldPolicy = Readonly<{ field: RegExp; dimension?: ResearchNumericDimension;
  policy?: ResearchNumericPolicy; units?: readonly CanonicalUnit[]; defaultUnit?: CanonicalUnit;
  policyFromUnit?: boolean; min?: number; max?: number; rangeUnit?: "%" | "ratio" }>;

const UNIT_POLICIES: Readonly<Record<string, UnitPolicy>> = Object.freeze({
  TWD: { canonicalUnit: "TWD", dimension: "currency", defaultPolicy: "finite", displayMultiplier: 1 },
  NTD: { canonicalUnit: "TWD", dimension: "currency", defaultPolicy: "finite", displayMultiplier: 1 },
  元: { canonicalUnit: "TWD", dimension: "currency", defaultPolicy: "finite", displayMultiplier: 1 },
  shares: { canonicalUnit: "shares", dimension: "shares", defaultPolicy: "nonnegative_safe_integer", displayMultiplier: 1 },
  股: { canonicalUnit: "shares", dimension: "shares", defaultPolicy: "nonnegative_safe_integer", displayMultiplier: 1 },
  people: { canonicalUnit: "people", dimension: "people", defaultPolicy: "nonnegative_safe_integer", displayMultiplier: 1 },
  人: { canonicalUnit: "people", dimension: "people", defaultPolicy: "nonnegative_safe_integer", displayMultiplier: 1 },
  accounts: { canonicalUnit: "accounts", dimension: "accounts", defaultPolicy: "nonnegative_safe_integer", displayMultiplier: 1 },
  戶: { canonicalUnit: "accounts", dimension: "accounts", defaultPolicy: "nonnegative_safe_integer", displayMultiplier: 1 },
  count: { canonicalUnit: "count", dimension: "count", defaultPolicy: "nonnegative_safe_integer", displayMultiplier: 1 },
  "%": { canonicalUnit: "%", dimension: "ratio", defaultPolicy: "finite", displayMultiplier: 1 },
  percent: { canonicalUnit: "%", dimension: "ratio", defaultPolicy: "finite", displayMultiplier: 1 },
  ratio: { canonicalUnit: "ratio", dimension: "ratio", defaultPolicy: "finite", displayMultiplier: 100 },
  score: { canonicalUnit: "score", dimension: "score", defaultPolicy: "finite", displayMultiplier: 1 },
  分: { canonicalUnit: "score", dimension: "score", defaultPolicy: "finite", displayMultiplier: 1 },
});

const integer = (field: RegExp, dimension: ResearchNumericDimension, defaultUnit: CanonicalUnit,
  policy: ResearchNumericPolicy = "nonnegative_safe_integer"): FieldPolicy =>
  ({ field, dimension, defaultUnit, units: [defaultUnit], policy });
const finite = (field: RegExp, dimension: ResearchNumericDimension, defaultUnit: CanonicalUnit,
  policy: ResearchNumericPolicy = "finite"): FieldPolicy =>
  ({ field, dimension, defaultUnit, units: [defaultUnit], policy });
const bounded = (field: RegExp, defaultUnit: "%" | "ratio", min: number, max: number,
  rangeUnit: "%" | "ratio" = defaultUnit): FieldPolicy => ({ field, dimension: "ratio", policy: "bounded",
  units: ["%", "ratio"], defaultUnit, min, max, rangeUnit });

const FIELD_POLICIES: readonly FieldPolicy[] = Object.freeze([
  finite(/^market\.price$/, "currency", "TWD", "nonnegative_finite"),
  integer(/^institutional\.\d{4}-\d{2}-\d{2}\.(?:foreignNet|trustNet|dealerNet|institutionalNet)$/,
    "shares", "shares", "signed_safe_integer"),
  integer(/^tdcc\.(?:totalShares|whaleShares)$/, "shares", "shares"),
  integer(/^tdcc\.(?:totalPeople|whalePeople)$/, "people", "people"),
  bounded(/^tdcc\.(?:whaleRatio|retailRatio)$/, "%", 0, 100),
  bounded(/^(?:strategies\.(?:sr|ma|chips|pattern)\.confidence|report\.conclusion\.(?:aiConfidence|investmentCertainty))$/,
    "ratio", 0, 1),
  bounded(/^report\.recommendation\.confidence$/, "ratio", 0, 1),
  finite(/^report\.valuation\.scenarios\.(?:conservative|base|optimistic)\.multiple$/,
    "ratio", "ratio", "nonnegative_finite"),
  finite(/^report\.valuation\.scenarios\.(?:conservative|base|optimistic)\.targetPrice$/,
    "currency", "TWD", "nonnegative_finite"),
  finite(/^report\.valuation\.scenarios\.(?:conservative|base|optimistic)\.expectedReturnRatio$/,
    "ratio", "ratio"),
  finite(/^report\.valuation\.scenarios\.(?:conservative|base|optimistic)\.expectedReturnPercent$/,
    "ratio", "%"),
  finite(/^strategies\.(?:sr|ma|chips|pattern)\.score$/, "score", "score"),

  finite(/^strategies\.sr\.details\.(?:lastClose|atr14|vwap|poc|shortResistance|shortSupport|longResistance|longSupport|swingHigh|swingLow|recentHigh|recentLow)$/,
    "currency", "TWD", "nonnegative_finite"),
  finite(/^strategies\.ma\.details\.(?:lastClose|previousClose)$/, "currency", "TWD", "nonnegative_finite"),
  finite(/^strategies\.ma\.details\.(?:bias|maGapPercent)$/, "ratio", "%"),
  integer(/^strategies\.chips\.details\.(?:foreignTotal|trustTotal)$/, "shares", "shares", "signed_safe_integer"),
  integer(/^strategies\.chips\.details\.(?:foreignConsecutive|trustConsecutive|peopleChange)$/,
    "count", "count", "signed_safe_integer"),
  integer(/^strategies\.chips\.details\.totalShares$/, "shares", "shares"),
  integer(/^strategies\.chips\.details\.totalPeople$/, "people", "people"),
  bounded(/^strategies\.chips\.details\.(?:whaleRatio|retailRatio)$/, "%", 0, 100),
  finite(/^strategies\.chips\.details\.whaleChange$/, "ratio", "%"),
  finite(/^strategies\.pattern\.details\.(?:neckline|target|stopLoss|atr14)$/,
    "currency", "TWD", "nonnegative_finite"),
  bounded(/^strategies\.pattern\.details\.confidence$/, "ratio", 0, 1),
  integer(/^strategies\.pattern\.details\.dataPoints$/, "count", "count"),
  finite(/^strategies\.pattern\.details\.volumeRatio$/, "ratio", "ratio", "nonnegative_finite"),
  finite(/^strategies\.pattern\.details\.distanceToNecklinePct$/, "ratio", "%"),

  integer(/^sources\.\d+\.rowCount$/, "count", "count"),
  integer(/^fundamentals\.metrics\.sharesOutstanding$/, "shares", "shares"),
  integer(/^fundamentals\.metrics\.shareholderPeople$/, "people", "people"),
  integer(/^fundamentals\.metrics\.(?:shareholderAccounts|households)$/, "accounts", "accounts"),
  // Financial producers declare their semantic metric unit. The explicit
  // fundamentals namespace is the contract boundary; no key suffix inference.
  { field: /^fundamentals\.metrics\.[A-Za-z][A-Za-z0-9_]*$/, policyFromUnit: true,
    units: ["TWD", "%"] },
]);

export interface ResearchNumericInput { path: string; field: string; unit?: string; value: number }
export interface ResearchNumericRelationshipsInput {
  path: "tdcc";
  relationships: Readonly<{
    totalShares: number | null;
    whaleShares: number | null;
    totalPeople: number | null;
    whalePeople: number | null;
  }>;
}
export interface ValidatedResearchNumber { value: number; dimension: ResearchNumericDimension;
  policy: ResearchNumericPolicy; canonicalUnit: CanonicalUnit; displayValue: number }

function findFieldPolicy(field: string): FieldPolicy | undefined {
  return FIELD_POLICIES.find((entry) => entry.field.test(field));
}

function findUnitPolicy(unit: string): UnitPolicy | undefined {
  const trimmed = unit.trim();
  return UNIT_POLICIES[trimmed] ?? UNIT_POLICIES[trimmed.toLowerCase()] ?? UNIT_POLICIES[trimmed.toUpperCase()];
}

function comparableRangeValue(value: number, unit: CanonicalUnit, rangeUnit?: "%" | "ratio"): number {
  if (!rangeUnit || unit === rangeUnit) return value;
  if (unit === "ratio" && rangeUnit === "%") return value * 100;
  if (unit === "%" && rangeUnit === "ratio") return value / 100;
  return value;
}

function validateScalar(input: ResearchNumericInput): ValidatedResearchNumber {
  const value = normalizeCanonicalResearchNumber(input.path, input.value);
  const suppliedUnit = input.unit?.trim();
  if (suppliedUnit && !findUnitPolicy(suppliedUnit)) {
    throw new Error(`research_packet_unknown_unit:${input.path}:${suppliedUnit}`);
  }
  const fieldPolicy = findFieldPolicy(input.field);
  if (!fieldPolicy) throw new Error(`research_packet_unknown_numeric_contract:${input.path}`);
  if (suppliedUnit === "" && !fieldPolicy.defaultUnit) {
    throw new Error(`research_packet_unknown_numeric_contract:${input.path}`);
  }
  const unitPolicy = findUnitPolicy(suppliedUnit || fieldPolicy.defaultUnit || "");
  if (!unitPolicy) throw new Error(`research_packet_unknown_numeric_contract:${input.path}`);
  if (fieldPolicy.units && !fieldPolicy.units.includes(unitPolicy.canonicalUnit)) {
    throw new Error(`research_packet_numeric_unit_mismatch:${input.path}:${unitPolicy.canonicalUnit}`);
  }
  const policy = fieldPolicy.policyFromUnit ? unitPolicy.defaultPolicy : fieldPolicy.policy;
  const dimension = fieldPolicy.policyFromUnit ? unitPolicy.dimension : fieldPolicy.dimension;
  if (!policy || !dimension) throw new Error(`research_packet_unknown_numeric_contract:${input.path}`);
  if ((policy === "signed_safe_integer" || policy === "nonnegative_safe_integer") && !Number.isSafeInteger(value)) {
    throw new Error(`research_packet_unsafe_integer:${input.path}`);
  }
  if ((policy === "nonnegative_safe_integer" || policy === "nonnegative_finite") && value < 0) {
    throw new Error(`research_packet_negative_number:${input.path}`);
  }
  const ranged = comparableRangeValue(value, unitPolicy.canonicalUnit, fieldPolicy.rangeUnit);
  if (policy === "bounded" && (ranged < (fieldPolicy.min ?? Number.NEGATIVE_INFINITY)
    || ranged > (fieldPolicy.max ?? Number.POSITIVE_INFINITY))) {
    throw new Error(`research_packet_number_out_of_range:${input.path}`);
  }
  return { value, dimension, policy, canonicalUnit: unitPolicy.canonicalUnit,
    displayValue: dimension === "ratio" ? value * unitPolicy.displayMultiplier : value };
}

export function validateResearchNumber(input: ResearchNumericInput): ValidatedResearchNumber;
export function validateResearchNumber(input: ResearchNumericRelationshipsInput): void;
export function validateResearchNumber(
  input: ResearchNumericInput | ResearchNumericRelationshipsInput,
): ValidatedResearchNumber | void {
  if ("relationships" in input) {
    const { totalShares, whaleShares, totalPeople, whalePeople } = input.relationships;
    if (whaleShares !== null && totalShares !== null && whaleShares > totalShares) {
      throw new Error("research_packet_cross_field_violation:tdcc.whaleShares_gt_totalShares");
    }
    if (whalePeople !== null && totalPeople !== null && whalePeople > totalPeople) {
      throw new Error("research_packet_cross_field_violation:tdcc.whalePeople_gt_totalPeople");
    }
    return;
  }
  return validateScalar(input);
}

export function normalizeCanonicalResearchNumber(path: string, value: number): number {
  const normalized = Object.is(value, -0) ? 0 : value;
  if (!Number.isFinite(normalized)) throw new Error(`research_packet_non_finite_number:${path}`);
  return normalized;
}

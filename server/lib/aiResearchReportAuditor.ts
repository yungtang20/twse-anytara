import type {
  AIResearchPacket,
  AuditResult,
  RenderedResearchClaim,
  StructuredResearchConclusion,
  StructuredResearchFinding,
} from "../../shared/aiResearch";
import { isDeepStrictEqual } from "node:util";
import { resolveResearchEvidenceRegistry, validateResearchFindingRuntime } from "./aiResearchFindingPolicy";
import { evaluateInvestmentConclusion } from "./aiResearchInvestmentConclusion";
import { validateResearchNumber } from "./aiResearchNumericPolicy";

type UnknownRecord = Record<string, unknown>;
const CONCLUSION_KEYS = new Set([
  "verdict", "supportingFindingIds", "opposingFindingIds", "limitationFindingIds",
  "aiConfidence", "investmentCertainty",
]);
const REPORT_KEYS = new Set([
  "schemaVersion", "stockId", "asOf", "contextFingerprint", "dataQuality",
  "findings", "conclusion", "citations", "recommendation", "valuation",
]);
const PROHIBITED_CANONICAL = ["破產", "舞弊", "保證獲利", "必漲", "穩賺", "零風險"];

function record(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : null;
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function exactKeys(item: UnknownRecord, allowed: Set<string>): boolean {
  return Object.keys(item).every((key) => allowed.has(key));
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function normalizedConfidence(value: unknown, path: string): number | null | undefined {
  if (value === null) return null;
  if (typeof value !== "number") return undefined;
  try {
    return validateResearchNumber({ path, field: path, unit: "ratio", value }).value;
  } catch {
    return undefined;
  }
}

function stringLeaves(value: unknown, result: string[] = []): string[] {
  if (typeof value === "string") result.push(value);
  else if (Array.isArray(value)) value.forEach((item) => stringLeaves(item, result));
  else if (record(value)) Object.values(value as UnknownRecord).forEach((item) => stringLeaves(item, result));
  return result;
}

function canonicalText(value: string): string {
  return value.normalize("NFKC").replace(/[\p{Cc}\p{Cf}\p{Z}\p{P}\p{S}\s]/gu, "").toUpperCase();
}

function collectProhibited(value: unknown): string[] {
  const leaves = stringLeaves(value);
  const result = leaves.filter((leaf) => PROHIBITED_CANONICAL.some((token) => canonicalText(leaf).includes(token)));
  const joined = canonicalText(leaves.join(""));
  for (const token of PROHIBITED_CANONICAL) {
    if (joined.includes(token) && !result.some((leaf) => canonicalText(leaf).includes(token))) result.push(`canonical:${token}`);
  }
  return uniqueSorted(result);
}

function validateIdentity(candidate: UnknownRecord, packet: AIResearchPacket, errors: string[]): void {
  if (candidate.schemaVersion !== 1) errors.push("unsupported_schema_version");
  if (candidate.stockId !== packet.stockId) errors.push("stock_id_mismatch");
  if (candidate.asOf !== packet.asOf) errors.push("as_of_mismatch");
  if (candidate.contextFingerprint !== packet.contextFingerprint) errors.push("context_fingerprint_mismatch");
  if (!isDeepStrictEqual(candidate.dataQuality, packet.dataQuality)) errors.push("data_quality_mismatch");
}

function parseConclusion(value: unknown, errors: string[]): StructuredResearchConclusion | null {
  const item = record(value);
  if (item && "summary" in item) errors.push("raw_conclusion_summary_forbidden");
  if (!item || !exactKeys(item, CONCLUSION_KEYS)
    || !["positive", "neutral", "negative", "insufficient-data"].includes(String(item.verdict))
    || !stringArray(item.supportingFindingIds) || !stringArray(item.opposingFindingIds)
    || !stringArray(item.limitationFindingIds)) {
    errors.push("invalid_conclusion");
    return null;
  }
  const aiConfidence = normalizedConfidence(item.aiConfidence, "report.conclusion.aiConfidence");
  const investmentCertainty = normalizedConfidence(
    item.investmentCertainty, "report.conclusion.investmentCertainty",
  );
  if (aiConfidence === undefined) errors.push("invalid_ai_confidence");
  if (investmentCertainty === undefined) errors.push("invalid_investment_certainty");
  return { ...item, aiConfidence: aiConfidence ?? null,
    investmentCertainty: investmentCertainty ?? null } as unknown as StructuredResearchConclusion;
}

function validateFindings(value: unknown, packet: AIResearchPacket, errors: string[]) {
  const findings: StructuredResearchFinding[] = [];
  const renderedClaims: RenderedResearchClaim[] = [];
  const unsupportedFindingIds: string[] = [];
  if (!Array.isArray(value)) {
    errors.push("invalid_findings");
    return { findings, renderedClaims, unsupportedFindingIds };
  }
  for (const raw of value) {
    try {
      const validated = validateResearchFindingRuntime(raw, packet);
      findings.push(validated.finding);
      renderedClaims.push(validated.renderedClaim);
    } catch (error) {
      const id = typeof record(raw)?.id === "string" ? String(record(raw)?.id) : "unknown";
      unsupportedFindingIds.push(id);
      errors.push(error instanceof Error ? error.message : `finding_validation_failed:${id}`);
    }
  }
  const ids = findings.map((finding) => finding.id);
  for (const id of ids.filter((item, index) => ids.indexOf(item) !== index)) errors.push(`duplicate_finding_id:${id}`);
  return { findings, renderedClaims, unsupportedFindingIds };
}

function validateConclusionReferences(conclusion: StructuredResearchConclusion | null,
  findings: StructuredResearchFinding[], errors: string[]): void {
  if (!conclusion) return;
  const known = new Map(findings.map((finding) => [finding.id, finding]));
  const lists = [conclusion.supportingFindingIds, conclusion.opposingFindingIds, conclusion.limitationFindingIds];
  const all = lists.flat();
  for (const id of all.filter((item, index) => all.indexOf(item) !== index)) errors.push(`duplicate_conclusion_finding:${id}`);
  for (const id of all) if (!known.has(id)) errors.push(`unknown_conclusion_finding:${id}`);
  for (const id of conclusion.supportingFindingIds) {
    const expected = conclusion.verdict === "negative" ? "negative" : "positive";
    if (known.get(id)?.stance !== expected || known.get(id)?.kind === "limitation") errors.push(`invalid_supporting_stance:${id}`);
  }
  for (const id of conclusion.opposingFindingIds) {
    const expected = conclusion.verdict === "negative" ? "positive" : "negative";
    if (known.get(id)?.stance !== expected || known.get(id)?.kind === "limitation") errors.push(`invalid_opposing_stance:${id}`);
  }
  for (const id of conclusion.limitationFindingIds) {
    if (known.get(id)?.kind !== "limitation") errors.push(`invalid_conclusion_limitation:${id}`);
  }
  for (const finding of findings.filter((item) => item.kind === "limitation")) {
    if (!conclusion.limitationFindingIds.includes(finding.id)) errors.push(`unreferenced_limitation_finding:${finding.id}`);
  }
  if (["positive", "negative"].includes(conclusion.verdict)
    && conclusion.supportingFindingIds.length === 0) {
    errors.push("directional_conclusion_requires_support");
  }
  if (conclusion.verdict === "insufficient-data" && conclusion.limitationFindingIds.length === 0) {
    errors.push("insufficient_data_requires_limitation");
  }
}

function validateRichnessLimitations(packet: AIResearchPacket, conclusion: StructuredResearchConclusion | null,
  findings: StructuredResearchFinding[], errors: string[]): void {
  if (packet.dataQuality.informationRichness !== "C") return;
  if (conclusion?.verdict !== "insufficient-data") errors.push("richness_c_requires_insufficient_data_verdict");
  const referenced = new Set(conclusion?.limitationFindingIds ?? []);
  const hasGap = (dataset: string, reasonCode: "missing_dataset" | "stale_dataset") => findings.some((finding) =>
    finding.kind === "limitation" && referenced.has(finding.id)
    && finding.limitation?.datasetId === dataset && finding.limitation.reasonCode === reasonCode);
  for (const dataset of packet.dataQuality.missingDatasets) {
    if (!hasGap(dataset, "missing_dataset")) errors.push(`missing_published_limitation:${dataset}`);
  }
  for (const dataset of packet.dataQuality.staleDatasets) {
    if (!hasGap(dataset, "stale_dataset")) errors.push(`missing_published_limitation:${dataset}`);
  }
}

function renderConclusion(conclusion: StructuredResearchConclusion, rendered: RenderedResearchClaim[]): string {
  const verdictLabels = { positive: "正向候選", neutral: "中性候選", negative: "負向候選", "insufficient-data": "資料不足" };
  const byId = new Map(rendered.map((claim) => [claim.id, claim.text]));
  const renderList = (ids: string[]) => ids.map((id) => byId.get(id)).filter((text): text is string => Boolean(text)).join("；");
  const parts = [`結論狀態：${verdictLabels[conclusion.verdict]}`];
  const support = renderList(conclusion.supportingFindingIds);
  const opposition = renderList(conclusion.opposingFindingIds);
  const limitations = renderList(conclusion.limitationFindingIds);
  if (support) parts.push(`支持證據：${support}`);
  if (opposition) parts.push(`反方證據：${opposition}`);
  if (limitations) parts.push(`資料限制：${limitations}`);
  return `${parts.join("。")}。`;
}

function invalidResult(errors: string[], prohibitedClaims: string[] = []): AuditResult {
  return { mechanicalPassed: false, publicationReady: false, semanticGrounding: "unverified",
    citationCoverage: 0, invalidCitationIds: [], unsupportedFindingIds: [], prohibitedClaims,
    errors: uniqueSorted(errors), warnings: [], draft: null, publishedReport: null };
}

export function auditResearchReport(reportCandidate: unknown, packet: AIResearchPacket): AuditResult {
  const candidate = record(reportCandidate);
  if (!candidate) return invalidResult(["invalid_report_contract"]);
  const errors: string[] = [];
  const warnings: string[] = [];
  const prohibitedClaims = collectProhibited(candidate);
  if (prohibitedClaims.length > 0) errors.push("prohibited_claims_present");
  if ("audit" in candidate) errors.push("candidate_audit_forbidden");
  for (const key of Object.keys(candidate)) if (!REPORT_KEYS.has(key) && key !== "audit") errors.push(`invalid_report_field:${key}`);
  validateIdentity(candidate, packet, errors);

  const validation = validateFindings(candidate.findings, packet, errors);
  if (validation.findings.length === 0) errors.push("empty_findings");
  const conclusion = parseConclusion(candidate.conclusion, errors);
  if (conclusion && (conclusion.aiConfidence !== null || conclusion.investmentCertainty !== null)) {
    warnings.push("candidate_confidence_unverified");
  }
  validateConclusionReferences(conclusion, validation.findings, errors);
  validateRichnessLimitations(packet, conclusion, validation.findings, errors);

  let registry = new Map<string, AIResearchPacket["evidence"][number]>();
  try { registry = resolveResearchEvidenceRegistry(packet); }
  catch (error) { errors.push(error instanceof Error ? error.message : "research_evidence_registry_invalid"); }
  const sourceIds = new Set(packet.sources.filter((source) => source.status === "available").map((source) => source.id));
  const citations = stringArray(candidate.citations) ? candidate.citations : [];
  if (!stringArray(candidate.citations)) errors.push("invalid_citations");
  for (const id of citations.filter((item, index) => citations.indexOf(item) !== index)) errors.push(`duplicate_citation:${id}`);
  const fragmentIds = validation.findings.flatMap((finding) => finding.fragments.map((fragment) => fragment.evidenceId));
  if (JSON.stringify(uniqueSorted(citations)) !== JSON.stringify(uniqueSorted(fragmentIds))
    || citations.length !== uniqueSorted(fragmentIds).length) errors.push("citations_fragment_set_mismatch");
  const invalidCitationIds = [...citations, ...fragmentIds].filter((id) => {
    const item = registry.get(id);
    return !item || !item.available || !sourceIds.has(item.sourceId);
  });

  const factualCount = validation.findings.filter((finding) => finding.kind !== "limitation").length;
  const unsupportedFacts = validation.findings.filter((finding) => finding.kind !== "limitation"
    && validation.unsupportedFindingIds.includes(finding.id)).length;
  const citationCoverage = factualCount === 0 ? 0 : (factualCount - unsupportedFacts) / factualCount;
  if (citationCoverage !== 1) errors.push("citation_coverage_below_100_percent");
  const investment = "recommendation" in candidate || "valuation" in candidate
    ? evaluateInvestmentConclusion({ recommendation: candidate.recommendation, valuation: candidate.valuation },
      packet, validation.findings.map((finding, index) => ({ finding,
        renderedClaim: validation.renderedClaims[index] })), conclusion?.verdict)
    : { recommendation: null, valuation: null, errors: [] };
  errors.push(...investment.errors);
  const finalErrors = uniqueSorted(errors);
  const mechanicalPassed = finalErrors.length === 0 && invalidCitationIds.length === 0
    && validation.unsupportedFindingIds.length === 0;
  return {
    mechanicalPassed, publicationReady: false, semanticGrounding: "unverified", citationCoverage,
    invalidCitationIds: uniqueSorted(invalidCitationIds), unsupportedFindingIds: uniqueSorted(validation.unsupportedFindingIds),
    prohibitedClaims, errors: finalErrors, warnings: uniqueSorted(warnings), publishedReport: null,
    recommendation: mechanicalPassed ? investment.recommendation : null,
    valuation: mechanicalPassed ? investment.valuation : null,
    draft: mechanicalPassed && conclusion ? {
      status: "mechanical-preview-only", claims: validation.renderedClaims,
      conclusion: renderConclusion(conclusion, validation.renderedClaims),
    } : null,
  };
}

import type {
  AIResearchPacket,
  AIResearchReportCandidate,
  AuditResult,
  PublishedResearchReport,
  ResearchFindingStance,
  StructuredResearchFinding,
} from "../../shared/aiResearch";
import { validateResearchFindingRuntime, resolveResearchEvidenceRegistry } from "./aiResearchFindingPolicy";
import { auditResearchReport } from "./aiResearchReportAuditor";
import { deriveServerInvestmentVerdict } from "./aiResearchVerdictPolicy";

export interface ResearchPublicationGateOptions {
  clock: () => Date;
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function signStance(value: unknown): ResearchFindingStance | null {
  return typeof value !== "number" || !Number.isFinite(value) ? null
    : value > 0 ? "positive" : value < 0 ? "negative" : "neutral";
}

function comparisonStance(finding: StructuredResearchFinding,
  registry: Map<string, AIResearchPacket["evidence"][number]>): ResearchFindingStance | null {
  const current = finding.fragments.find((item) => item.role === "current");
  const previous = finding.fragments.find((item) => item.role === "previous");
  const currentEvidence = current ? registry.get(current.evidenceId) : null;
  const previousEvidence = previous ? registry.get(previous.evidenceId) : null;
  if (!currentEvidence || !previousEvidence
    || typeof currentEvidence.value !== "number" || typeof previousEvidence.value !== "number") return null;
  const institutionalIdentity = (field: string) => field.match(
    /^institutional\.\d{4}-\d{2}-\d{2}\.(foreignNet|trustNet|dealerNet|institutionalNet)$/,
  )?.[1] ?? null;
  const currentInstitutional = currentEvidence.dataset === "stock_institutional"
    ? institutionalIdentity(currentEvidence.field) : null;
  const previousInstitutional = previousEvidence.dataset === "stock_institutional"
    ? institutionalIdentity(previousEvidence.field) : null;
  if (currentInstitutional && currentInstitutional === previousInstitutional) {
    return signStance(currentEvidence.value - previousEvidence.value);
  }
  if (currentEvidence.field !== previousEvidence.field) return null;
  if (currentEvidence.field === "tdcc.whaleRatio") {
    return signStance(currentEvidence.value - previousEvidence.value);
  }
  if (currentEvidence.field === "tdcc.retailRatio") {
    return signStance(previousEvidence.value - currentEvidence.value);
  }
  return null;
}

function deriveStance(finding: StructuredResearchFinding,
  registry: Map<string, AIResearchPacket["evidence"][number]>): ResearchFindingStance | null {
  if (["company_fact", "market_snapshot", "financial_metric", "tdcc_concentration"].includes(finding.kind)) {
    return "neutral";
  }
  if (finding.kind === "limitation") return "insufficient";
  if (finding.kind === "evidence_comparison") return comparisonStance(finding, registry);
  const valueFragment = finding.fragments[0];
  const value = valueFragment ? registry.get(valueFragment.evidenceId)?.value : null;
  if (finding.kind === "institutional_flow") return signStance(value);
  if (finding.kind === "strategy_result") {
    return value === "BUY" ? "positive" : value === "SELL" ? "negative"
      : value === "HOLD" ? "neutral" : value === "UNKNOWN" ? "insufficient" : null;
  }
  if (finding.kind === "trade_risk") {
    return value === "none" ? "neutral"
      : ["medium", "high", "critical"].includes(String(value)) ? "negative" : null;
  }
  return null;
}

function findingDomain(finding: StructuredResearchFinding,
  registry: Map<string, AIResearchPacket["evidence"][number]>): string {
  if (["company_fact", "market_snapshot"].includes(finding.kind)) return "market";
  if (finding.kind === "financial_metric") return "financials";
  if (finding.kind === "institutional_flow") return "institutional";
  if (finding.kind === "tdcc_concentration") return "tdcc";
  if (finding.kind === "evidence_comparison") {
    const dataset = registry.get(finding.fragments[0]?.evidenceId ?? "")?.dataset;
    return dataset === "stock_institutional" ? "institutional"
      : dataset === "tdcc_shareholding" ? "tdcc" : "unverifiable";
  }
  if (finding.kind === "trade_risk") return "risk";
  if (finding.kind === "strategy_result") return "strategy";
  return "limitation";
}

function validateRecommendation(candidate: AIResearchReportCandidate, packet: AIResearchPacket, audit: AuditResult,
  derived: Map<string, ResearchFindingStance>, registry: Map<string, AIResearchPacket["evidence"][number]>,
  errors: string[]): "BUY" | "HOLD" | "SELL" | null {
  const recommendation = audit.recommendation;
  const valuation = audit.valuation;
  if (!recommendation) { errors.push("publication_recommendation_required"); return null; }
  if (!valuation) { errors.push("publication_valuation_required"); return null; }
  const baseReturn = valuation.scenarios.find((item) => item.name === "base")?.expectedReturnRatio;
  if (typeof baseReturn !== "number" || !Number.isFinite(baseReturn)) {
    errors.push("publication_base_return_unavailable"); return null;
  }
  const packetRisk = packet.tradeRisks.highestLevel !== "none";
  const expected = deriveServerInvestmentVerdict(baseReturn, candidate.findings, derived, registry);
  if (recommendation.verdict !== expected) {
    errors.push(`publication_recommendation_mismatch:${recommendation.verdict}:${expected}`);
  }
  const byId = new Map(candidate.findings.map((item) => [item.id, item]));
  const expectedSupport = recommendation.verdict === "SELL" ? "negative" : "positive";
  const supportDomains = new Set(recommendation.supportingFindingIds
    .filter((id) => derived.get(id) === expectedSupport).map((id) => byId.get(id)).filter(Boolean)
    .map((item) => findingDomain(item!, registry)));
  if (["BUY", "SELL"].includes(recommendation.verdict) && supportDomains.size < 2) {
    errors.push(`publication_recommendation_domain_coverage:${recommendation.verdict}`);
  }
  if (packetRisk && recommendation.riskFindingIds.length === 0) {
    errors.push("publication_recommendation_risk_findings_required");
  }
  for (const risk of candidate.findings.filter((item) => item.kind === "trade_risk"
    && derived.get(item.id) === "negative")) {
    if (!recommendation.riskFindingIds.includes(risk.id)) {
      errors.push(`publication_recommendation_risk_finding_missing:${risk.id}`);
    }
  }
  return expected;
}

function validateMaterialFreshness(candidate: AIResearchReportCandidate, packet: AIResearchPacket,
  registry: Map<string, AIResearchPacket["evidence"][number]>, errors: string[]): void {
  const stale = new Set(packet.dataQuality.staleDatasets);
  const material = new Set([
    ...(candidate.recommendation?.supportingFindingIds ?? []),
    ...(candidate.recommendation?.opposingFindingIds ?? []),
    ...(candidate.recommendation?.riskFindingIds ?? []),
  ]);
  for (const finding of candidate.findings.filter((item) => material.has(item.id))) {
    if (finding.fragments.some((fragment) => {
      const item = registry.get(fragment.evidenceId);
      return Boolean(item && (stale.has(item.dataset) || stale.has(item.sourceId)));
    })) errors.push(`publication_material_finding_stale:${finding.id}`);
  }
}

function validateCanonicalTradeRisk(candidate: AIResearchReportCandidate, packet: AIResearchPacket,
  registry: Map<string, AIResearchPacket["evidence"][number]>, derived: Map<string, ResearchFindingStance>,
  errors: string[]): void {
  const canonical = [...registry.values()].filter((item) => item.field === "tradeRisks.highestLevel");
  const evidence = canonical.length === 1 ? canonical[0] : null;
  if (!evidence || !evidence.available || evidence.value !== packet.tradeRisks.highestLevel) {
    errors.push("publication_trade_risk_evidence_mismatch");
    return;
  }
  const level = packet.tradeRisks.highestLevel;
  if (level === "none") return;
  const riskFinding = candidate.findings.find((finding) => finding.kind === "trade_risk"
    && finding.fragments.some((fragment) => fragment.evidenceId === evidence.id)
    && derived.get(finding.id) === "negative");
  if (!riskFinding) {
    errors.push(`publication_trade_risk_finding_required:${level}`);
    return;
  }
  if (!candidate.recommendation?.riskFindingIds.includes(riskFinding.id)) {
    errors.push(`publication_trade_risk_reference_required:${riskFinding.id}`);
  }
}

function buildServerConclusion(findings: StructuredResearchFinding[],
  claims: PublishedResearchReport["claims"], derived: Map<string, ResearchFindingStance>,
  verdict: "BUY" | "HOLD" | "SELL") {
  const ids = {
    supporting: findings.filter((item) => derived.get(item.id) === "positive").map((item) => item.id).sort(),
    opposing: findings.filter((item) => derived.get(item.id) === "negative").map((item) => item.id).sort(),
    limitations: findings.filter((item) => item.kind === "limitation").map((item) => item.id).sort(),
  };
  const labels = { BUY: "正向", HOLD: "中性", SELL: "負向" } as const;
  const byId = new Map(claims.map((claim) => [claim.id, claim.text]));
  const line = (label: string, values: string[]) => values.length === 0 ? ""
    : `${label}：${values.map((id) => `${id}：${byId.get(id) ?? ""}`).join("；")}`;
  const text = [`結論狀態：${labels[verdict]}`, line("支持證據", ids.supporting),
    line("反方證據", ids.opposing), line("資料限制", ids.limitations)].filter(Boolean).join("。");
  return { ids, text: `${text}。` };
}

function failClosed(audit: AuditResult, errors: string[]): AuditResult {
  return { ...audit, publicationReady: false, semanticGrounding: "unverified",
    publishedReport: null, errors: uniqueSorted([...audit.errors, ...errors]) };
}

function trustedTimestamp(clock: () => Date): string | null {
  try {
    const value = clock();
    return value instanceof Date && Number.isFinite(value.valueOf()) ? value.toISOString() : null;
  } catch {
    return null;
  }
}

export function gateResearchPublication(candidate: unknown, packet: AIResearchPacket,
  options: ResearchPublicationGateOptions): AuditResult {
  const audit = auditResearchReport(candidate, packet);
  if (!audit.mechanicalPassed || !audit.draft) return audit;
  const typedCandidate = candidate as AIResearchReportCandidate;
  const errors: string[] = [];
  let registry: Map<string, AIResearchPacket["evidence"][number]>;
  try { registry = resolveResearchEvidenceRegistry(packet); }
  catch { return failClosed(audit, ["publication_evidence_registry_invalid"]); }
  const derived = new Map<string, ResearchFindingStance>();
  const claims = typedCandidate.findings.map((finding) => {
    const validated = validateResearchFindingRuntime(finding, packet);
    const stance = deriveStance(validated.finding, registry);
    if (!stance) errors.push(`publication_stance_unverifiable:${finding.id}`);
    else {
      derived.set(finding.id, stance);
      if (finding.stance !== stance) errors.push(`publication_stance_mismatch:${finding.id}:${finding.stance}:${stance}`);
    }
    return { ...validated.renderedClaim, ...(stance ? { stance } : {}) };
  });
  validateMaterialFreshness(typedCandidate, packet, registry, errors);
  validateCanonicalTradeRisk(typedCandidate, packet, registry, derived, errors);
  const expectedVerdict = validateRecommendation(typedCandidate, packet, audit, derived, registry, errors);
  const riskLevel = packet.tradeRisks.highestLevel;
  if (["high", "critical"].includes(riskLevel) && audit.recommendation?.verdict === "BUY") {
    errors.push(`publication_recommendation_risk_veto:BUY:${riskLevel}`);
  }
  if (expectedVerdict) {
    const expectedConclusion = { BUY: "positive", HOLD: "neutral", SELL: "negative" } as const;
    if (typedCandidate.conclusion.verdict !== expectedConclusion[expectedVerdict]) {
      errors.push(`publication_conclusion_verdict_mismatch:${typedCandidate.conclusion.verdict}:${expectedConclusion[expectedVerdict]}`);
    }
  }
  if (errors.length > 0 || !audit.recommendation || !audit.valuation || !expectedVerdict) {
    return failClosed(audit, errors);
  }
  const generatedAt = trustedTimestamp(options.clock);
  if (!generatedAt) return failClosed(audit, ["publication_clock_invalid"]);
  const conclusion = buildServerConclusion(typedCandidate.findings, claims, derived, expectedVerdict);
  const publishedReport: PublishedResearchReport = {
    status: "formally-published", generatedAt, semanticGrounding: "server-grounded",
    claims, conclusion: conclusion.text, conclusionFindingIds: conclusion.ids,
    recommendation: { ...structuredClone(audit.recommendation), confidenceGrounding: "model-estimate-unverified" },
    valuation: { ...structuredClone(audit.valuation), assumptionGrounding: "model-selected-bounded-assumptions" },
    grounding: { facts: "server-grounded", calculations: "server-calculated",
      valuationMultiples: "model-selected-bounded-assumptions",
      recommendationConfidence: "model-estimate-unverified" },
  };
  return { ...audit, publicationReady: true, semanticGrounding: "server-grounded",
    draft: null, publishedReport };
}

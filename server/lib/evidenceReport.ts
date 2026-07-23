import type { EvidenceRef, StockSnapshot } from "./stockSnapshot";

export interface ReportClaim {
  text: string;
  evidenceIds: string[];
}

export interface EvidenceSummary {
  numericClaimLines: number;
  supportedClaimLines: number;
  coverage: number;
  invalidEvidenceIds: string[];
  redactedLines: number;
  warnings: string[];
}

export interface ValidatedReport {
  markdown: string;
  claims: ReportClaim[];
  evidence: Record<string, EvidenceRef>;
  summary: EvidenceSummary;
}

const CITATION = /\[\[([A-Za-z0-9:._-]+)\]\]/g;
// ponytail: Line-level detection is intentionally conservative and cheap. Its ceiling
// is prose that implies a quantity without a number; upgrade to a structured claim
// response contract before treating this as semantic fact checking.
const MATERIAL_NUMBER = /(?:\d[\d,.]*\s*(?:%|％|元|億|萬|倍|張|股)|(?:EPS|ROE|ROIC|PER|PBR|VaR|回撤|波動率|營收|淨利|現金流|股價|價格|殖利率|毛利率|負債比)[^\n]*?\d)/i;

function resolveCitation(id: string, snapshot: StockSnapshot): EvidenceRef | null {
  if (id.startsWith("metric:")) {
    const metric = snapshot.metrics[id.slice("metric:".length)];
    if (!metric) return null;
    return {
      id,
      dataset: "deterministic_metrics",
      date: metric.asOf,
      field: metric.id,
      value: metric.value,
      unit: metric.unit,
    };
  }
  if (snapshot.evidence[id]) return snapshot.evidence[id];

  const [dataset, date, ...fieldParts] = id.split(":");
  const field = fieldParts.join(":");
  const series = snapshot.series[dataset];
  if (!series || !date || !field) return null;
  const row = series.rows.find((candidate) => candidate.date === date && (candidate[field] != null || candidate.type === field));
  if (!row) return null;
  const rawValue = row[field] ?? row.value;
  if (typeof rawValue !== "number" && typeof rawValue !== "string") return null;
  return { id, dataset, date, field, value: rawValue, unit: "raw" };
}

function redactNumbers(line: string): string {
  return line.replace(/(?<![A-Za-z])[-+]?\d[\d,.]*(?:\s*(?:%|％|元|億|萬|倍|張|股))?/g, "[未驗證數值]");
}

export function validateEvidenceReport(markdown: string, snapshot: StockSnapshot): ValidatedReport {
  const claims: ReportClaim[] = [];
  const resolvedEvidence: Record<string, EvidenceRef> = {};
  const invalidEvidenceIds = new Set<string>();
  let numericClaimLines = 0;
  let supportedClaimLines = 0;
  let redactedLines = 0;

  const lines = markdown.split(/\r?\n/).map((line) => {
    const citationIds = [...line.matchAll(CITATION)].map((match) => match[1]);
    const material = MATERIAL_NUMBER.test(line.replace(CITATION, ""));
    if (material) numericClaimLines++;
    const validIds: string[] = [];
    for (const id of citationIds) {
      const evidence = resolveCitation(id, snapshot);
      if (evidence) {
        resolvedEvidence[id] = evidence;
        validIds.push(id);
      } else {
        invalidEvidenceIds.add(id);
      }
    }

    if (material && (validIds.length === 0 || validIds.length !== citationIds.length)) {
      redactedLines++;
      return `${redactNumbers(line.replace(CITATION, "")).trim()} ⚠️（原數值缺少可驗證證據）`;
    }
    if (material) {
      supportedClaimLines++;
      claims.push({ text: line.replace(CITATION, "").trim(), evidenceIds: validIds });
    }
    return line.replace(CITATION, (_match, id: string) => `〔${id}〕`);
  });

  const coverage = numericClaimLines === 0 ? 1 : supportedClaimLines / numericClaimLines;
  const warnings = [
    ...(redactedLines ? [`redacted_unsupported_numeric_lines:${redactedLines}`] : []),
    ...(invalidEvidenceIds.size ? [`invalid_evidence_ids:${invalidEvidenceIds.size}`] : []),
  ];
  lines.push(
    "",
    "---",
    "## 證據覆蓋",
    `- 可驗證數值陳述：${supportedClaimLines}/${numericClaimLines}`,
    `- 覆蓋率：${(coverage * 100).toFixed(0)}%`,
    ...Object.values(resolvedEvidence).map((item) => `- \`${item.id}\` → ${item.dataset} / ${item.date || "undated"} / ${item.field} = ${item.value} ${item.unit}`),
  );

  return {
    markdown: lines.join("\n"),
    claims,
    evidence: resolvedEvidence,
    summary: {
      numericClaimLines,
      supportedClaimLines,
      coverage,
      invalidEvidenceIds: [...invalidEvidenceIds],
      redactedLines,
      warnings,
    },
  };
}

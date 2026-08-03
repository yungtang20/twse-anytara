import "dotenv/config";
import { createAIResearchProduction } from "../server/lib/aiResearchProduction";

const stockId = process.argv[2]?.trim() ?? "";
if (!/^\d{4,6}$/.test(stockId)) {
  process.stdout.write(`${JSON.stringify({ success: false, error: "invalid_stock_id" })}\n`);
  process.exitCode = 2;
} else {
  const result = await createAIResearchProduction().orchestrator.research(stockId);
  const report = result.success ? result.publishedReport : null;
  const output = result.success
    ? { success: true, error: null, publicationReady: result.publicationReady,
      semanticGrounding: result.semanticGrounding, reportStatus: report?.status ?? null,
      recommendation: report ? { verdict: report.recommendation.verdict,
        label: report.recommendation.label, horizonMonths: report.recommendation.horizonMonths,
        confidence: report.recommendation.confidence } : null,
      valuation: report ? { method: report.valuation.method, asOf: report.valuation.asOf,
        currentPrice: report.valuation.currentPrice, metricValue: report.valuation.metric.value,
        scenarioCount: report.valuation.scenarios.length } : null,
      audit: { mechanicalPassed: result.audit.mechanicalPassed,
        citationCoverage: result.audit.citationCoverage, errorCount: result.audit.errors.length,
        warningCount: result.audit.warnings.length }, auditDiagnostics: null,
      providerMetadata: result.providerMetadata }
    : { success: false, error: result.error, auditDiagnostics: result.auditDiagnostics ?? null,
      providerMetadata: result.providerMetadata ?? [] };
  process.stdout.write(`${JSON.stringify(output)}\n`);
  if (!result.success) process.exitCode = 1;
}

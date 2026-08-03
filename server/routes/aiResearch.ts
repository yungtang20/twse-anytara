import { Router, type Request, type Response } from "express";
import type { ResearchContext } from "../../shared/researchContext";
import type { AIResearchRunResult } from "../lib/aiResearchOrchestrator";
import { createAIResearchProduction } from "../lib/aiResearchProduction";
import { presentAIResearchReport } from "../lib/aiResearchReportPresenter";
import { isLoopbackRequest } from "../lib/security";

interface ResearchAggregator {
  aggregate(stockId: string): Promise<ResearchContext | unknown>;
}

type HandlerRequest = Pick<Request, "params">;
interface HandlerResponse {
  status(code: number): HandlerResponse;
  json(body: unknown): unknown;
}

interface AIResearchRunner {
  research(stockId: string, options?: { signal?: AbortSignal }): Promise<AIResearchRunResult>;
}

type ReportRequest = Pick<Request, "params" | "socket" | "once" | "off">;
export interface AIResearchReportHandlerOptions {
  timeoutMs?: number;
  scheduleTimeout?: (callback: () => void, delayMs: number) => unknown;
  clearScheduledTimeout?: (handle: unknown) => void;
}

const REPORT_TIMEOUT_MS = 315_000;
const production = createAIResearchProduction();

function validStockId(stockId: string | undefined): stockId is string {
  return typeof stockId === "string" && /^\d{4,6}$/.test(stockId);
}

function contextError(error: unknown): { status: number; error: string } {
  if (error instanceof Error && error.message === "stock_not_eligible_for_research") {
    return { status: 422, error: "stock_not_eligible_for_research" };
  }
  return { status: 503, error: "research_context_unavailable" };
}

function reportStatus(error: Extract<AIResearchRunResult, { success: false }>["error"]): number {
  if (error === "ai_research_stock_not_eligible" || error === "ai_research_insufficient_data") return 422;
  if (error === "ai_research_context_unavailable" || error === "ai_research_provider_unavailable") return 503;
  if (error === "ai_research_provider_rate_limited") return 429;
  if (error === "ai_research_provider_timeout") return 504;
  if (error === "ai_research_provider_response_invalid" || error === "ai_research_model_output_invalid"
    || error === "ai_research_provider_rejected" || error === "ai_research_provider_server_error") return 502;
  if (error === "ai_research_aborted") return 499;
  return 500;
}

export function createAiResearchContextHandler(aggregator: ResearchAggregator) {
  return async (request: HandlerRequest, response: HandlerResponse): Promise<void> => {
    const stockId = request.params.stockId?.trim();
    if (!validStockId(stockId)) {
      response.status(400).json({ success: false, error: "invalid_stock_id" });
      return;
    }
    try {
      const data = await aggregator.aggregate(stockId);
      response.json({ success: true, data });
    } catch (error) {
      const failure = contextError(error);
      response.status(failure.status).json({ success: false, error: failure.error });
    }
  };
}

export function createAIResearchReportHandler(
  orchestrator: AIResearchRunner,
  options: AIResearchReportHandlerOptions = {},
) {
  const timeoutMs = options.timeoutMs ?? REPORT_TIMEOUT_MS;
  const schedule = options.scheduleTimeout ?? ((callback, delay) => globalThis.setTimeout(callback, delay));
  const clear = options.clearScheduledTimeout ?? ((handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>));
  return async (request: ReportRequest, response: HandlerResponse): Promise<void> => {
    if (!isLoopbackRequest(request as Request)) {
      response.status(403).json({ success: false, error: "ai_research_loopback_required" });
      return;
    }
    const stockId = request.params.stockId?.trim();
    if (!validStockId(stockId)) {
      response.status(400).json({ success: false, error: "invalid_stock_id" });
      return;
    }
    const controller = new AbortController();
    let timedOut = false;
    let finishTimeout = () => {};
    const timeoutResult = new Promise<null>((resolve) => { finishTimeout = () => resolve(null); });
    const onAborted = () => controller.abort();
    request.once("aborted", onAborted);
    const timer = schedule(() => {
      timedOut = true;
      controller.abort();
      finishTimeout();
    }, timeoutMs);
    try {
      const researchResult = orchestrator.research(stockId, { signal: controller.signal })
        .then((result) => ({ result }), (error: unknown) => ({ error }));
      const outcome = await Promise.race([researchResult, timeoutResult]);
      if (outcome === null || timedOut) {
        response.status(504).json({ success: false, error: "ai_research_timeout" });
      } else if ("error" in outcome) {
        response.status(500).json({ success: false, error: "ai_research_contract_error" });
      } else if (!outcome.result.success) {
        response.status(reportStatus(outcome.result.error)).json({ success: false, error: outcome.result.error });
      } else {
        response.json(presentAIResearchReport(outcome.result));
      }
    } catch {
      response.status(timedOut ? 504 : 500).json({ success: false,
        error: timedOut ? "ai_research_timeout" : "ai_research_contract_error" });
    } finally {
      clear(timer);
      request.off("aborted", onAborted);
    }
  };
}

export function createAiResearchRouter(
  aggregator: ResearchAggregator = production.contextAggregator,
  orchestrator: AIResearchRunner = production.orchestrator,
): Router {
  const router = Router();
  router.get("/api/ai-research/stocks/:stockId/context", createAiResearchContextHandler(aggregator));
  router.post("/api/ai-research/stocks/:stockId/report", createAIResearchReportHandler(orchestrator));
  return router;
}

export default createAiResearchRouter();

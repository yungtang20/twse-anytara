import { randomUUID } from "node:crypto";
import { Router, type Request, type Response } from "express";
import type { ResearchContext } from "../../shared/researchContext";
import type { AIProviderOverride, ResolvedAIProviderConnection } from "../../shared/aiProvider";
import { AIAbuseGuardError, createAIAbuseGuard } from "../lib/aiAbuseGuard";
import { AIProviderConnectionError, resolveAIProviderConnection } from "../lib/aiProviderConnection";
import { OpenAICompatibleTransportError, probeProviderConnection } from "../lib/openAICompatibleTransport";
import { PublicEndpointError } from "../lib/publicEndpoint";
import type { AIResearchRunResult } from "../lib/aiResearchOrchestrator";
import { createAIResearchProduction } from "../lib/aiResearchProduction";
import { presentAIResearchReport } from "../lib/aiResearchReportPresenter";

interface ResearchAggregator {
  aggregate(stockId: string): Promise<ResearchContext | unknown>;
}

type HandlerRequest = Pick<Request, "params">;
interface HandlerResponse {
  status(code: number): HandlerResponse;
  json(body: unknown): unknown;
}
interface ReportResponse extends HandlerResponse {
  setHeader(name: string, value: string): unknown;
  writableEnded?: boolean;
  once?(event: "close", listener: () => void): unknown;
  off?(event: "close", listener: () => void): unknown;
}

interface AIResearchRunner {
  research(stockId: string, options?: {
    signal?: AbortSignal;
    connection?: ResolvedAIProviderConnection;
  }): Promise<AIResearchRunResult>;
}

interface RequestGuard {
  acquire(input: { clientId: string; usesSharedProvider: boolean }): () => void;
}

type ReportRequest = Pick<Request, "params" | "socket" | "ip" | "body" | "once" | "off">;
export interface AIResearchReportHandlerOptions {
  timeoutMs?: number;
  scheduleTimeout?: (callback: () => void, delayMs: number) => unknown;
  clearScheduledTimeout?: (handle: unknown) => void;
  resolveConnection?: (input: AIProviderOverride | undefined) => ResolvedAIProviderConnection;
  guard?: RequestGuard;
  correlationId?: () => string;
}

interface AIProviderTestHandlerOptions {
  resolveConnection?: (input: AIProviderOverride | undefined) => ResolvedAIProviderConnection;
  guard?: RequestGuard;
  probe?: (connection: ResolvedAIProviderConnection, options: { signal?: AbortSignal }) =>
    Promise<{ ok: true; modelCount: number }>;
  correlationId?: () => string;
  log?: (event: {
    event: "ai_provider_transport_error";
    correlationId: string;
    error: string;
    networkCode: string;
  }) => void;
}

const REPORT_TIMEOUT_MS = 900_000;
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

function providerInput(body: unknown): AIProviderOverride | undefined {
  if (body === undefined) return undefined;
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new AIProviderConnectionError("provider_input_invalid");
  }
  return (body as { provider?: AIProviderOverride }).provider;
}

function providerError(error: unknown): { status: number; error: string } | null {
  if (!(error instanceof AIProviderConnectionError)) return null;
  if (error.code === "default_key_not_configured" || error.code === "max_output_tokens_invalid") {
    return { status: 503, error: error.code };
  }
  return { status: 400, error: error.code };
}

function guardError(error: unknown): { status: number; error: string } | null {
  if (!(error instanceof AIAbuseGuardError)) return null;
  if (error.code === "ai_guard_config_invalid") return { status: 503, error: error.code };
  if (error.code === "ai_client_invalid") return { status: 400, error: error.code };
  return { status: 429, error: error.code };
}

function probeError(error: unknown, connection: ResolvedAIProviderConnection): { status: number; error: string } {
  if (error instanceof PublicEndpointError) {
    return { status: connection.source === "visitor" ? 400 : 503, error: error.code };
  }
  if (error instanceof OpenAICompatibleTransportError) {
    if (error.code === "provider_rate_limited") return { status: 429, error: error.code };
    if (error.code === "provider_timeout") return { status: 504, error: error.code };
    if (error.code === "provider_rejected" || error.code === "provider_server_error"
      || error.code === "provider_redirect_forbidden" || error.code === "provider_invalid_json"
      || error.code === "provider_response_too_large") return { status: 502, error: error.code };
    if (error.code === "provider_aborted") return { status: 499, error: error.code };
    return { status: 503, error: error.code };
  }
  return { status: 500, error: "ai_provider_test_failed" };
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
  const resolveConnection = options.resolveConnection ?? ((input) => resolveAIProviderConnection(input));
  const guard = options.guard ?? createAIAbuseGuard();
  const correlationId = options.correlationId ?? randomUUID;
  return async (request: ReportRequest, response: ReportResponse): Promise<void> => {
    response.setHeader("X-Correlation-Id", correlationId());
    const stockId = request.params.stockId?.trim();
    if (!validStockId(stockId)) {
      response.status(400).json({ success: false, error: "invalid_stock_id" });
      return;
    }
    let connection: ResolvedAIProviderConnection;
    let release: (() => void) | undefined;
    try {
      connection = resolveConnection(providerInput(request.body));
      release = guard.acquire({
        clientId: request.ip || request.socket.remoteAddress || "",
        usesSharedProvider: connection.source === "default",
      });
    } catch (error) {
      const failure = providerError(error) ?? guardError(error);
      response.status(failure?.status ?? 500).json({ success: false,
        error: failure?.error ?? "ai_research_contract_error" });
      return;
    }
    const controller = new AbortController();
    let timedOut = false;
    let responseClosed = false;
    let finishTimeout = () => {};
    const timeoutResult = new Promise<null>((resolve) => { finishTimeout = () => resolve(null); });
    const onAborted = () => controller.abort();
    const onResponseClosed = () => {
      if (!response.writableEnded) {
        responseClosed = true;
        controller.abort();
      }
    };
    request.once("aborted", onAborted);
    response.once?.("close", onResponseClosed);
    const timer = schedule(() => {
      timedOut = true;
      controller.abort();
      finishTimeout();
    }, timeoutMs);
    try {
      const researchResult = orchestrator.research(stockId, { signal: controller.signal, connection })
        .then((result) => ({ result }), (error: unknown) => ({ error }));
      const outcome = await Promise.race([researchResult, timeoutResult]);
      if (responseClosed) {
        return;
      } else if (outcome === null || timedOut) {
        response.status(504).json({ success: false, error: "ai_research_timeout" });
      } else if ("error" in outcome) {
        response.status(500).json({ success: false, error: "ai_research_contract_error" });
      } else if (!outcome.result.success) {
        response.status(reportStatus(outcome.result.error)).json({ success: false, error: outcome.result.error });
      } else {
        response.json(presentAIResearchReport(outcome.result));
      }
    } catch {
      if (responseClosed) return;
      response.status(timedOut ? 504 : 500).json({ success: false,
        error: timedOut ? "ai_research_timeout" : "ai_research_contract_error" });
    } finally {
      clear(timer);
      request.off("aborted", onAborted);
      response.off?.("close", onResponseClosed);
      release?.();
    }
  };
}

export function createAIProviderTestHandler(options: AIProviderTestHandlerOptions = {}) {
  const resolveConnection = options.resolveConnection ?? ((input) => resolveAIProviderConnection(input));
  const guard = options.guard ?? createAIAbuseGuard();
  const probe = options.probe ?? probeProviderConnection;
  const correlationId = options.correlationId ?? randomUUID;
  const log = options.log ?? ((event) => console.warn(JSON.stringify(event)));
  return async (request: ReportRequest, response: ReportResponse): Promise<void> => {
    const requestCorrelationId = correlationId();
    response.setHeader("X-Correlation-Id", requestCorrelationId);
    let connection: ResolvedAIProviderConnection;
    let release: (() => void) | undefined;
    try {
      connection = resolveConnection(providerInput(request.body));
      release = guard.acquire({
        clientId: request.ip || request.socket.remoteAddress || "",
        usesSharedProvider: connection.source === "default",
      });
    } catch (error) {
      const failure = providerError(error) ?? guardError(error);
      response.status(failure?.status ?? 500).json({ success: false,
        error: failure?.error ?? "ai_provider_test_failed" });
      return;
    }

    const controller = new AbortController();
    let responseClosed = false;
    const onAborted = () => controller.abort();
    const onResponseClosed = () => {
      if (!response.writableEnded) {
        responseClosed = true;
        controller.abort();
      }
    };
    request.once("aborted", onAborted);
    response.once?.("close", onResponseClosed);
    try {
      const result = await probe(connection, { signal: controller.signal });
      if (responseClosed) return;
      response.json({ success: true, modelCount: result.modelCount });
    } catch (error) {
      if (responseClosed) return;
      if (error instanceof OpenAICompatibleTransportError && error.networkCode) {
        log({
          event: "ai_provider_transport_error",
          correlationId: requestCorrelationId,
          error: error.code,
          networkCode: error.networkCode,
        });
      }
      const failure = probeError(error, connection);
      response.status(failure.status).json({ success: false, error: failure.error });
    } finally {
      request.off("aborted", onAborted);
      response.off?.("close", onResponseClosed);
      release?.();
    }
  };
}

export function createAiResearchRouter(
  aggregator: ResearchAggregator = production.contextAggregator,
  orchestrator: AIResearchRunner = production.orchestrator,
): Router {
  const router = Router();
  const guard = createAIAbuseGuard();
  router.get("/api/ai-research/stocks/:stockId/context", createAiResearchContextHandler(aggregator));
  router.post("/api/ai-research/stocks/:stockId/report", createAIResearchReportHandler(orchestrator, { guard }));
  router.post("/api/ai-provider/test", createAIProviderTestHandler({ guard }));
  return router;
}

export default createAiResearchRouter();

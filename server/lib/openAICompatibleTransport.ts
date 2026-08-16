import { request as httpsRequest, type RequestOptions } from "node:https";
import type { ClientRequest, IncomingMessage } from "node:http";
import type { ResolvedAIProviderConnection } from "../../shared/aiProvider";
import {
  resolvePublicHttpsEndpoint,
  type ResolvedPublicEndpoint,
} from "./publicEndpoint";

type TransportErrorCode = "provider_aborted" | "provider_timeout" | "provider_network"
  | "provider_redirect_forbidden" | "provider_rejected" | "provider_rate_limited"
  | "provider_server_error" | "provider_invalid_json" | "provider_response_too_large";

export class OpenAICompatibleTransportError extends Error {
  constructor(readonly code: TransportErrorCode) {
    super(code);
    this.name = "OpenAICompatibleTransportError";
  }
}

export type TransportRequest = (
  options: RequestOptions,
  callback: (response: IncomingMessage) => void,
) => ClientRequest;

interface TransportOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  maxResponseBytes?: number;
  request?: TransportRequest;
  resolveEndpoint?: (baseUrl: string) => Promise<ResolvedPublicEndpoint>;
}

const DEFAULT_TIMEOUT_MS = 900_000;
const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

function statusError(status: number): TransportErrorCode | null {
  if (status >= 300 && status < 400) return "provider_redirect_forbidden";
  if (status === 429) return "provider_rate_limited";
  if (status >= 500) return "provider_server_error";
  if (status < 200 || status >= 300) return "provider_rejected";
  return null;
}

async function resolveEndpointWithinBudget(
  connection: ResolvedAIProviderConnection,
  options: TransportOptions,
  timeoutMs: number,
  startedAt: number,
): Promise<ResolvedPublicEndpoint> {
  if (options.signal?.aborted) throw new OpenAICompatibleTransportError("provider_aborted");
  const resolver = options.resolveEndpoint ?? resolvePublicHttpsEndpoint;
  const remainingMs = timeoutMs - (Date.now() - startedAt);
  if (remainingMs <= 0) throw new OpenAICompatibleTransportError("provider_timeout");
  return await new Promise<ResolvedPublicEndpoint>((resolve, reject) => {
    let settled = false;
    const finish = (error?: unknown, value?: ResolvedPublicEndpoint) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve(value as ResolvedPublicEndpoint);
    };
    const onAbort = () => finish(new OpenAICompatibleTransportError("provider_aborted"));
    const timer = setTimeout(
      () => finish(new OpenAICompatibleTransportError("provider_timeout")),
      remainingMs,
    );
    options.signal?.addEventListener("abort", onAbort, { once: true });
    resolver(connection.baseUrl).then(
      (endpoint) => finish(undefined, endpoint),
      (error: unknown) => finish(error),
    );
  });
}

async function requestJson(
  connection: ResolvedAIProviderConnection,
  method: "GET" | "POST",
  target: "models" | "chat",
  body: unknown,
  options: TransportOptions,
): Promise<unknown> {
  const startedAt = Date.now();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const endpoint = await resolveEndpointWithinBudget(connection, options, timeoutMs, startedAt);
  if (options.signal?.aborted) throw new OpenAICompatibleTransportError("provider_aborted");
  const remainingTimeoutMs = timeoutMs - (Date.now() - startedAt);
  if (remainingTimeoutMs <= 0) throw new OpenAICompatibleTransportError("provider_timeout");
  const url = new URL(target === "models" ? endpoint.modelsUrl : endpoint.chatCompletionsUrl);
  const encodedBody = method === "POST" ? JSON.stringify(body) : "";
  const request = options.request ?? httpsRequest;
  const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;

  return await new Promise<unknown>((resolve, reject) => {
    let settled = false;
    let size = 0;
    const chunks: Buffer[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    let req: ClientRequest;
    const finish = (error?: OpenAICompatibleTransportError, value?: unknown) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve(value);
    };
    const onAbort = () => {
      const error = new OpenAICompatibleTransportError("provider_aborted");
      req.destroy(error);
      finish(error);
    };

    const requestOptions: RequestOptions = {
      protocol: "https:",
      hostname: endpoint.servername,
      port: 443,
      method,
      path: `${url.pathname}${url.search}`,
      servername: endpoint.servername,
      rejectUnauthorized: true,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${connection.apiKey}`,
        ...(method === "POST" ? {
          "Content-Type": "application/json",
          "Content-Length": String(Buffer.byteLength(encodedBody)),
        } : {}),
      },
      lookup: ((_hostname: string, _lookupOptions: unknown,
        callback: (error: NodeJS.ErrnoException | null, address: string, family: 4 | 6) => void) => {
        callback(null, endpoint.address, endpoint.family);
      }) as RequestOptions["lookup"],
    };

    req = request(requestOptions, (response) => {
      response.on("data", (chunk: Buffer | string) => {
        if (settled) return;
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += buffer.length;
        if (size > maxResponseBytes) {
          const error = new OpenAICompatibleTransportError("provider_response_too_large");
          req.destroy(error);
          finish(error);
          return;
        }
        chunks.push(buffer);
      });
      response.once("end", () => {
        if (settled) return;
        const responseError = statusError(response.statusCode ?? 0);
        if (responseError) {
          finish(new OpenAICompatibleTransportError(responseError));
          return;
        }
        try {
          finish(undefined, JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown);
        } catch {
          finish(new OpenAICompatibleTransportError("provider_invalid_json"));
        }
      });
    });
    req.once("error", (error) => {
      if (settled) return;
      finish(error instanceof OpenAICompatibleTransportError
        ? error : new OpenAICompatibleTransportError("provider_network"));
    });
    options.signal?.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => {
      const error = new OpenAICompatibleTransportError("provider_timeout");
      req.destroy(error);
      finish(error);
    }, remainingTimeoutMs);
    if (method === "POST") req.write(encodedBody);
    req.end();
  });
}

export async function postChatCompletion(
  connection: ResolvedAIProviderConnection,
  payload: unknown,
  options: TransportOptions = {},
): Promise<unknown> {
  return requestJson(connection, "POST", "chat", payload, options);
}

export async function probeProviderConnection(
  connection: ResolvedAIProviderConnection,
  options: TransportOptions = {},
): Promise<{ ok: true; modelCount: number }> {
  const response = await requestJson(connection, "GET", "models", undefined, options);
  if (typeof response !== "object" || response === null || !("data" in response)
    || !Array.isArray(response.data)) {
    throw new OpenAICompatibleTransportError("provider_invalid_json");
  }
  return { ok: true, modelCount: response.data.length };
}

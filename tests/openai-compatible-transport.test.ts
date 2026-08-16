import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { ClientRequest, IncomingMessage } from "node:http";
import type { RequestOptions } from "node:https";
import test from "node:test";
import type { ResolvedAIProviderConnection } from "../shared/aiProvider";
import {
  OpenAICompatibleTransportError,
  postChatCompletion,
  probeProviderConnection,
  type TransportRequest,
} from "../server/lib/openAICompatibleTransport";
import type { ResolvedPublicEndpoint } from "../server/lib/publicEndpoint";

const connection: ResolvedAIProviderConnection = {
  source: "default",
  apiKey: "secret-key",
  baseUrl: "https://api.example.com/v1",
  model: "auto",
  maxOutputTokens: 65_536,
  privacyAccepted: true,
};

const endpoint: ResolvedPublicEndpoint = {
  baseUrl: "https://api.example.com/v1",
  chatCompletionsUrl: "https://api.example.com/v1/chat/completions",
  modelsUrl: "https://api.example.com/v1/models",
  address: "1.1.1.1",
  family: 4,
  servername: "api.example.com",
};

interface ScriptedRequest {
  request: TransportRequest;
  options: RequestOptions[];
  bodies: string[];
}

function scriptedRequest(statusCode: number, body: string): ScriptedRequest {
  const options: RequestOptions[] = [];
  const bodies: string[] = [];
  const request: TransportRequest = (requestOptions, callback) => {
    options.push(requestOptions);
    const req = new EventEmitter() as ClientRequest;
    req.write = ((chunk: unknown) => { bodies.push(String(chunk)); return true; }) as ClientRequest["write"];
    req.end = (() => {
      queueMicrotask(() => {
        const response = new EventEmitter() as IncomingMessage;
        response.statusCode = statusCode;
        callback(response);
        response.emit("data", Buffer.from(body));
        response.emit("end");
      });
      return req;
    }) as ClientRequest["end"];
    req.destroy = ((error?: Error) => {
      if (error) queueMicrotask(() => req.emit("error", error));
      return req;
    }) as ClientRequest["destroy"];
    return req;
  };
  return { request, options, bodies };
}

async function errorCode(run: () => Promise<unknown>): Promise<string | null> {
  try {
    await run();
    return null;
  } catch (error) {
    return error instanceof OpenAICompatibleTransportError ? error.code : "unexpected_error";
  }
}

test("chat transport pins validated DNS and keeps TLS verification enabled", async () => {
  const scripted = scriptedRequest(200, JSON.stringify({ choices: [] }));
  const result = await postChatCompletion(connection, { model: "auto", messages: [] }, {
    request: scripted.request,
    resolveEndpoint: async () => endpoint,
  });
  assert.deepEqual(result, { choices: [] });
  assert.equal(scripted.options[0].method, "POST");
  assert.equal(scripted.options[0].hostname, "api.example.com");
  assert.equal(scripted.options[0].path, "/v1/chat/completions");
  assert.equal(scripted.options[0].rejectUnauthorized, true);
  assert.equal((scripted.options[0].headers as Record<string, string>).Authorization,
    "Bearer secret-key");
  assert.equal(JSON.parse(scripted.bodies[0]).model, "auto");

  const lookup = scripted.options[0].lookup;
  assert.equal(typeof lookup, "function");
  const pinned = await new Promise<{ address: string; family: number }>((resolve, reject) => {
    (lookup as unknown as (hostname: string, options: unknown,
      callback: (error: Error | null, address: string, family: number) => void) => void)(
      "ignored.example", {}, (error: Error | null, address: string, family: number) => {
      if (error) reject(error);
      else resolve({ address, family });
      });
  });
  assert.deepEqual(pinned, { address: "1.1.1.1", family: 4 });
});

test("transport rejects redirects and oversized responses without leaking secrets", async () => {
  const redirect = scriptedRequest(302, "redirect");
  assert.equal(await errorCode(() => postChatCompletion(connection, {}, {
    request: redirect.request,
    resolveEndpoint: async () => endpoint,
  })), "provider_redirect_forbidden");

  const oversized = scriptedRequest(200, "x".repeat(33));
  assert.equal(await errorCode(() => postChatCompletion(connection, {}, {
    request: oversized.request,
    resolveEndpoint: async () => endpoint,
    maxResponseBytes: 32,
  })), "provider_response_too_large");
});

test("provider probe returns only the sanitized model count", async () => {
  const scripted = scriptedRequest(200, JSON.stringify({ data: [{ id: "auto" }] }));
  assert.deepEqual(await probeProviderConnection(connection, {
    request: scripted.request,
    resolveEndpoint: async () => endpoint,
  }), { ok: true, modelCount: 1 });
  assert.equal(scripted.options[0].method, "GET");
  assert.equal(scripted.options[0].path, "/v1/models");
  assert.equal(scripted.bodies.length, 0);
});

test("transport classifies provider status and invalid JSON with stable codes", async () => {
  for (const [status, code] of [[401, "provider_rejected"], [429, "provider_rate_limited"],
    [503, "provider_server_error"]] as const) {
    const scripted = scriptedRequest(status, "upstream secret body");
    assert.equal(await errorCode(() => postChatCompletion(connection, {}, {
      request: scripted.request,
      resolveEndpoint: async () => endpoint,
    })), code);
  }
  const invalid = scriptedRequest(200, "not-json");
  assert.equal(await errorCode(() => postChatCompletion(connection, {}, {
    request: invalid.request,
    resolveEndpoint: async () => endpoint,
  })), "provider_invalid_json");
});

test("network failures retain only a safe machine-readable cause code", async () => {
  const request: TransportRequest = () => {
    const req = new EventEmitter() as ClientRequest;
    req.write = (() => true) as ClientRequest["write"];
    req.end = (() => {
      queueMicrotask(() => req.emit("error", Object.assign(new Error("socket detail"), {
        code: "ECONNRESET",
      })));
      return req;
    }) as ClientRequest["end"];
    req.destroy = (() => req) as ClientRequest["destroy"];
    return req;
  };
  await assert.rejects(() => probeProviderConnection(connection, {
    request,
    resolveEndpoint: async () => endpoint,
  }), (error: unknown) => error instanceof OpenAICompatibleTransportError
    && error.code === "provider_network"
    && error.networkCode === "ECONNRESET"
    && !JSON.stringify(error).includes("socket detail"));
});

test("abort and total timeout cover DNS resolution before any credential-bearing request", async () => {
  let resolveDns: ((value: ResolvedPublicEndpoint) => void) | undefined;
  let requestCalls = 0;
  const request: TransportRequest = () => {
    requestCalls += 1;
    throw new Error("request must not start after cancellation");
  };
  const controller = new AbortController();
  const aborted = errorCode(() => postChatCompletion(connection, {}, {
    signal: controller.signal,
    timeoutMs: 1_000,
    request,
    resolveEndpoint: () => new Promise((resolve) => { resolveDns = resolve; }),
  }));
  controller.abort();
  resolveDns?.(endpoint);
  assert.equal(await aborted, "provider_aborted");
  assert.equal(requestCalls, 0);

  const timedOut = errorCode(() => postChatCompletion(connection, {}, {
    timeoutMs: 5,
    request,
    resolveEndpoint: () => new Promise(() => {}),
  }));
  assert.equal(await timedOut, "provider_timeout");
  assert.equal(requestCalls, 0);
});

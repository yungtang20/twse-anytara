import assert from "node:assert/strict";
import test from "node:test";
import {
  PublicEndpointError,
  resolvePublicHttpsEndpoint,
  type EndpointLookup,
} from "../server/lib/publicEndpoint";

const publicLookup: EndpointLookup = async () => [{ address: "1.1.1.1", family: 4 }];

async function errorCode(run: () => Promise<unknown>): Promise<string | null> {
  try {
    await run();
    return null;
  } catch (error) {
    return error instanceof PublicEndpointError ? error.code : "unexpected_error";
  }
}

test("normalizes only root or v1 OpenAI-compatible HTTPS base URLs", async () => {
  assert.deepEqual(await resolvePublicHttpsEndpoint("https://example.com", publicLookup), {
    baseUrl: "https://example.com/v1",
    chatCompletionsUrl: "https://example.com/v1/chat/completions",
    modelsUrl: "https://example.com/v1/models",
    address: "1.1.1.1",
    family: 4,
    servername: "example.com",
  });
  assert.equal((await resolvePublicHttpsEndpoint("https://example.com/v1/", publicLookup)).baseUrl,
    "https://example.com/v1");
  assert.equal(await errorCode(() => resolvePublicHttpsEndpoint(
    "https://example.com/arbitrary", publicLookup)), "provider_url_path_forbidden");
});

test("rejects unsafe URL syntax before DNS", async () => {
  for (const url of [
    "http://example.com/v1",
    "https://user:pass@example.com/v1",
    "https://example.com:8443/v1",
    "https://example.com/v1?key=value",
    "https://example.com/v1#fragment",
    "https://127.0.0.1/v1",
    "https://[::1]/v1",
    "https://localhost/v1",
    "https://service.local/v1",
  ]) {
    assert.notEqual(await errorCode(() => resolvePublicHttpsEndpoint(url, publicLookup)), null, url);
  }
});

test("rejects every destination when DNS contains a forbidden address", async () => {
  const mixedLookup: EndpointLookup = async () => [
    { address: "1.1.1.1", family: 4 },
    { address: "127.0.0.1", family: 4 },
  ];
  assert.equal(await errorCode(() => resolvePublicHttpsEndpoint(
    "https://example.com/v1", mixedLookup)), "provider_dns_forbidden");
});

test("rejects private reserved mapped and empty DNS answers", async () => {
  const forbidden = [
    { address: "10.0.0.1", family: 4 as const },
    { address: "169.254.169.254", family: 4 as const },
    { address: "192.168.1.1", family: 4 as const },
    { address: "::1", family: 6 as const },
    { address: "fd00::1", family: 6 as const },
    { address: "fe80::1", family: 6 as const },
    { address: "::ffff:127.0.0.1", family: 6 as const },
    { address: "64:ff9b::7f00:1", family: 6 as const },
  ];
  for (const answer of forbidden) {
    assert.equal(await errorCode(() => resolvePublicHttpsEndpoint(
      "https://example.com/v1", async () => [answer])), "provider_dns_forbidden", answer.address);
  }
  assert.equal(await errorCode(() => resolvePublicHttpsEndpoint(
    "https://example.com/v1", async () => [])), "provider_dns_empty");
});

test("prefers a public IPv4 address after every DNS answer passes validation", async () => {
  const result = await resolvePublicHttpsEndpoint("https://example.com/v1", async () => [
    { address: "2606:4700:4700::1111", family: 6 },
    { address: "1.0.0.1", family: 4 },
  ]);
  assert.equal(result.address, "1.0.0.1");
  assert.equal(result.family, 4);
});

import { lookup as dnsLookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

export type EndpointLookup = (
  hostname: string,
) => Promise<Array<{ address: string; family: 4 | 6 }>>;

type PublicEndpointErrorCode = "provider_url_invalid" | "provider_url_scheme_forbidden"
  | "provider_url_credentials_forbidden" | "provider_url_port_forbidden"
  | "provider_url_query_forbidden" | "provider_url_host_forbidden"
  | "provider_url_path_forbidden" | "provider_dns_empty" | "provider_dns_forbidden";

export class PublicEndpointError extends Error {
  constructor(readonly code: PublicEndpointErrorCode) {
    super(code);
    this.name = "PublicEndpointError";
  }
}

export interface ResolvedPublicEndpoint {
  baseUrl: string;
  chatCompletionsUrl: string;
  modelsUrl: string;
  address: string;
  family: 4 | 6;
  servername: string;
}

const forbiddenIpv4Addresses = new BlockList();
const forbiddenIpv6Addresses = new BlockList();

for (const [network, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
  ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) {
  forbiddenIpv4Addresses.addSubnet(network, prefix, "ipv4");
}

for (const [network, prefix] of [
  ["::", 128], ["::1", 128], ["::ffff:0:0", 96], ["64:ff9b::", 96],
  ["100::", 64], ["2001::", 32], ["2001:db8::", 32], ["2002::", 16],
  ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8],
] as const) {
  forbiddenIpv6Addresses.addSubnet(network, prefix, "ipv6");
}

const defaultLookup: EndpointLookup = async (hostname) => {
  const answers = await dnsLookup(hostname, { all: true, verbatim: true });
  return answers.flatMap((answer) => answer.family === 4 || answer.family === 6
    ? [{ address: answer.address, family: answer.family }]
    : []);
};

function normalizedHostname(url: URL): string {
  const hostname = url.hostname.toLowerCase();
  return hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1) : hostname;
}

function isForbiddenAddress(address: string, family: 4 | 6): boolean {
  if (isIP(address) !== family) return true;
  return family === 4
    ? forbiddenIpv4Addresses.check(address, "ipv4")
    : forbiddenIpv6Addresses.check(address, "ipv6");
}

export async function resolvePublicHttpsEndpoint(
  value: string,
  lookup: EndpointLookup = defaultLookup,
): Promise<ResolvedPublicEndpoint> {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new PublicEndpointError("provider_url_invalid");
  }
  if (url.protocol !== "https:") throw new PublicEndpointError("provider_url_scheme_forbidden");
  if (url.username || url.password) throw new PublicEndpointError("provider_url_credentials_forbidden");
  if (url.port && url.port !== "443") throw new PublicEndpointError("provider_url_port_forbidden");
  if (url.search || url.hash) throw new PublicEndpointError("provider_url_query_forbidden");

  const hostname = normalizedHostname(url);
  if (!hostname || isIP(hostname) !== 0 || hostname === "localhost" || hostname.endsWith(".local")) {
    throw new PublicEndpointError("provider_url_host_forbidden");
  }
  const pathname = url.pathname.replace(/\/+$/, "") || "/";
  if (pathname !== "/" && pathname !== "/v1") {
    throw new PublicEndpointError("provider_url_path_forbidden");
  }

  let answers: Array<{ address: string; family: 4 | 6 }>;
  try {
    answers = await lookup(hostname);
  } catch {
    throw new PublicEndpointError("provider_dns_empty");
  }
  if (answers.length === 0) throw new PublicEndpointError("provider_dns_empty");
  if (answers.some((answer) => isForbiddenAddress(answer.address, answer.family))) {
    throw new PublicEndpointError("provider_dns_forbidden");
  }

  const baseUrl = `${url.origin}/v1`;
  return {
    baseUrl,
    chatCompletionsUrl: `${baseUrl}/chat/completions`,
    modelsUrl: `${baseUrl}/models`,
    address: answers[0].address,
    family: answers[0].family,
    servername: hostname,
  };
}

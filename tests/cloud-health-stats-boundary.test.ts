import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);

type ApiResponse = { status: number; body: Record<string, unknown> };
type ProbeResult = {
  responses: Record<string, ApiResponse>;
  outboundFetches: number;
  healthProbe?: {
    pathname: string;
    searchParams: Record<string, string>;
    method: string;
    apikey: string | null;
    authorization: string | null;
  };
  sqliteUnchanged: boolean;
  sqliteSidecars: string[];
};

type Scenario =
  | "unconfigured"
  | "reachable"
  | "unauthorized"
  | "forbidden"
  | "no-content"
  | "timeout"
  | "stats-failed";

async function runProbe(scenario: Scenario): Promise<ProbeResult> {
  const sandbox = await mkdtemp(path.join(os.tmpdir(), `trinity-health-${scenario}-`));
  try {
    const helper = path.resolve("tests/helpers/cloud-health-stats-probe.ts");
    const { stdout } = await execFileAsync(
      process.execPath,
      ["--import", "tsx", helper, sandbox, scenario],
      {
        cwd: process.cwd(),
        env: { ...process.env },
        timeout: 15_000,
        windowsHide: true,
      },
    );
    return JSON.parse(stdout.trim().split(/\r?\n/).at(-1) || "") as ProbeResult;
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
}

function assertExplicit503(response: ApiResponse, label: string): void {
  assert.equal(response.status, 503, `${label} must return HTTP 503`);
  assert.equal(response.body.success, false);
  assert.equal(typeof response.body.error, "string");
  assert.ok(String(response.body.error).trim(), `${label} must explain the failure`);
}

test("cloud health fails closed when Supabase is not configured without touching SQLite", async () => {
  const result = await runProbe("unconfigured");
  assertExplicit503(result.responses.health, "unconfigured cloud health");
  assert.equal(result.outboundFetches, 0, "unconfigured health must not attempt network access");
  assert.equal(result.sqliteUnchanged, true);
  assert.deepEqual(result.sqliteSidecars, []);
});

test("cloud health reports success when the configured Supabase REST endpoint is reachable", async () => {
  const result = await runProbe("reachable");
  assert.equal(result.responses.health.status, 200);
  assert.equal(result.responses.health.body.success, true);
  assert.equal(result.responses.health.body.sqlite, false);
  assert.equal(result.outboundFetches, 1, "health must perform exactly one reachability probe");
  assert.deepEqual(result.healthProbe, {
    pathname: "/rest/v1/stock_meta",
    searchParams: { select: "stock_id", limit: "1" },
    method: "GET",
    apikey: "stub-anon-key",
    authorization: "Bearer stub-anon-key",
  });
  assert.equal(result.sqliteUnchanged, true);
  assert.deepEqual(result.sqliteSidecars, []);
});

for (const scenario of ["unauthorized", "forbidden", "no-content", "timeout"] as const) {
  test(`cloud health returns HTTP 503 for ${scenario} Supabase probe`, async () => {
    const result = await runProbe(scenario);
    assertExplicit503(result.responses.health, `${scenario} cloud health`);
    assert.equal(result.outboundFetches, 1);
    assert.equal(result.sqliteUnchanged, true);
    assert.deepEqual(result.sqliteSidecars, []);
  });
}

test("TWSE and OTC stats return HTTP 503 when every source fails", async () => {
  const result = await runProbe("stats-failed");
  assertExplicit503(result.responses.twse, "TWSE stats");
  assertExplicit503(result.responses.otc, "OTC stats");
  assert.equal(result.sqliteUnchanged, true);
  assert.deepEqual(result.sqliteSidecars, []);
});

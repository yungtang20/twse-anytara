import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const PROBE_TIMEOUT_MS = 30_000;

type ApiResponse = { status: number; body: Record<string, unknown> };
type ProbeResult = {
  responses: Record<string, ApiResponse>;
  outboundFetches: number;
  sqliteUnchanged: boolean;
  sqliteSidecars: string[];
};

function runProbe(helper: string, sandbox: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", helper, sandbox], {
      cwd: process.cwd(),
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, PROBE_TIMEOUT_MS);

    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      const errorOutput = Buffer.concat(stderr).toString("utf8");
      if (timedOut) {
        reject(new Error(`cloud API probe exceeded ${PROBE_TIMEOUT_MS}ms and exited via ${signal ?? code}\n${errorOutput}`));
      } else if (code !== 0) {
        reject(new Error(`cloud API probe exited with ${code ?? signal}\n${errorOutput}`));
      } else {
        resolve(Buffer.concat(stdout).toString("utf8"));
      }
    });
  });
}

function assertExplicitCloudError(response: ApiResponse, label: string): void {
  assert.equal(response.status, 503, `${label} must fail closed when Supabase is not configured`);
  assert.deepEqual(
    Object.keys(response.body).sort(),
    ["error", "success"],
    `${label} must not return fallback data or data-quality metadata`,
  );
  assert.equal(response.body.success, false);
  assert.equal(typeof response.body.error, "string");
  assert.ok(String(response.body.error).trim(), `${label} must explain that cloud data is unavailable`);
  assert.doesNotMatch(JSON.stringify(response.body), /sqlite|LOCAL_SQLITE_BAIT|mock/i);
}

test("cloud APIs fail closed without touching SQLite, Yahoo, or local trade-risk fallback", async () => {
  const sandbox = await mkdtemp(path.join(os.tmpdir(), "trinity-cloud-api-"));
  try {
    const helper = path.resolve("tests/helpers/cloud-api-probe.ts");
    const stdout = await runProbe(helper, sandbox);
    const result = JSON.parse(stdout.trim().split(/\r?\n/).at(-1) || "") as ProbeResult;

    assert.equal(result.outboundFetches, 0, "GET APIs must not download Yahoo or call any external network fallback");
    assert.equal(result.sqliteUnchanged, true, "GET APIs must not write or migrate the temporary SQLite bait database");
    assert.deepEqual(result.sqliteSidecars, [], "GET APIs must not open SQLite in a mode that creates WAL/SHM files");

    const failures: string[] = [];
    for (const [name, label] of [
      ["history", "GET history"],
      ["quote", "GET quote"],
      ["stockRisk", "GET stock trade-risk"],
      ["marketRisk", "GET market trade-risk"],
      ["riskStatus", "GET trade-risk status"],
    ] as const) {
      try { assertExplicitCloudError(result.responses[name], label); }
      catch (error) { failures.push(error instanceof Error ? error.message : String(error)); }
    }
    assert.deepEqual(failures, [], failures.join("\n"));
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

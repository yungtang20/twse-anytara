import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const root = process.cwd();

function run(script: string, args: string[] = [], extraEnv: Record<string, string> = {}) {
  return spawnSync(process.execPath, [path.join(root, "node_modules", "tsx", "dist", "cli.mjs"), script, ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, SUPABASE_PROJECT_REF: "approved-ref", ...extraEnv },
  });
}

test("destructive maintenance scripts default to a network-free dry run", () => {
  for (const script of ["scripts/emergency_prune.ts", "scripts/run_vacuum.ts"]) {
    const result = run(script);
    assert.equal(result.status, 0, `${script}: ${result.stderr}`);
    assert.match(result.stdout, /DRY RUN/);
    assert.doesNotMatch(result.stdout + result.stderr, /ECONN|fetch failed|DATABASE_URL is not set/);
  }
});

test("execution requires both the flag and exact environment project reference", () => {
  for (const script of ["scripts/emergency_prune.ts", "scripts/run_vacuum.ts"]) {
    const missing = run(script, ["--execute"]);
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /project-ref/i);
    const mismatch = run(script, ["--execute", "--project-ref", "wrong-ref"]);
    assert.notEqual(mismatch.status, 0);
    assert.match(mismatch.stderr, /project ref mismatch/i);
  }
});

test("vacuum keeps TLS verification and both scripts fail the process on operation errors", () => {
  const vacuum = readFileSync(path.join(root, "scripts/run_vacuum.ts"), "utf8");
  const prune = readFileSync(path.join(root, "scripts/emergency_prune.ts"), "utf8");
  assert.doesNotMatch(vacuum, /rejectUnauthorized\s*:\s*false/);
  assert.match(vacuum, /process\.exitCode\s*=\s*1/);
  assert.match(prune, /process\.exitCode\s*=\s*1/);
  assert.match(prune, /if\s*\(error\)/);
});

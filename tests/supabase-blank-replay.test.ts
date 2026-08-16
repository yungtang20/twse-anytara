import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const directory = path.join(process.cwd(), "supabase", "migrations");
const files = readdirSync(directory).filter((file) => file.endsWith(".sql")).sort();
const migrations = files.map((file) => ({ file, sql: readFileSync(path.join(directory, file), "utf8") }));
const chain = migrations.map(({ file, sql }) => `-- ${file}\n${sql}`).join("\n");

test("static migration preflight creates every prerequisite before its first ALTER", () => {
  const creates = [...chain.matchAll(/create table if not exists public\.([a-z_]+)/gi)]
    .map((match) => ({ table: match[1], index: match.index ?? -1 }));
  for (const table of ["stock_price", "stock_meta", "stock_institutional", "tdcc_shareholding",
    "dividend_events", "trading_calendar", "stock_dataset_cache", "sync_runs",
    "stock_trade_risk", "trade_risk_sync_status", "stock_margin"]) {
    const create = creates.find((entry) => entry.table === table);
    assert.ok(create, `missing CREATE TABLE for ${table}`);
    const firstAlter = chain.search(new RegExp(`alter table public\\.${table}\\b`, "i"));
    assert.ok(firstAlter < 0 || create.index < firstAlter, `${table} is altered before it is created`);
  }
});

test("every canonical public table has RLS and explicit least-privilege grants", () => {
  const tables = new Set([...chain.matchAll(/create table if not exists public\.([a-z_]+)/gi)]
    .map((match) => match[1]));
  for (const table of tables) {
    assert.match(chain, new RegExp(`alter table public\\.${table} enable row level security`, "i"),
      `${table} must enable RLS`);
    assert.match(chain, new RegExp(`revoke all on table[\\s\\S]{0,700}public\\.${table}[\\s\\S]{0,700}from anon, authenticated`, "i"),
      `${table} must revoke browser writes`);
    assert.match(chain, new RegExp(`grant all on table[\\s\\S]{0,700}public\\.${table}[\\s\\S]{0,700}to service_role`, "i"),
      `${table} must grant server ownership`);
  }
});

test("new integrity constraints are additive idempotent and privileged functions pin search_path", () => {
  const latest = migrations.find(({ file }) => file === "20260815014954_add_stock_margin_and_integrity_contracts.sql");
  assert.ok(latest);
  assert.match(latest.sql, /do \$integrity\$/i);
  const constraintNames = [...latest.sql.matchAll(/add constraint ([a-z_]+)/gi)].map((match) => match[1]);
  assert.ok(constraintNames.length >= 10);
  for (const name of constraintNames) {
    assert.match(latest.sql, new RegExp(`not exists[\\s\\S]{0,180}${name}`, "i"),
      `${name} must be guarded for replay`);
  }
  for (const match of chain.matchAll(/security definer/gi)) {
    assert.match(chain.slice(match.index, match.index + 180), /set search_path\s*=\s*''/i,
      "SECURITY DEFINER must pin an empty search_path");
  }
});

test("Supabase security verification is catalog-only and registered as an npm command", () => {
  const verifierPath = path.join(process.cwd(), "scripts", "verifySupabaseSecurity.ts");
  assert.ok(readdirSync(path.dirname(verifierPath)).includes(path.basename(verifierPath)));
  const source = readFileSync(verifierPath, "utf8");
  assert.match(source, /pg_class/);
  assert.match(source, /role_table_grants/);
  assert.match(source, /pg_policies/);
  assert.match(source, /pg_constraint/);
  assert.match(source, /pg_get_constraintdef/);
  assert.match(source, /has_function_privilege/);
  assert.match(source, /aclexplode/);
  assert.match(source, /EXPECTED_POLICIES/);
  assert.match(source, /REQUIRED_FUNCTIONS/);
  assert.match(source, /begin read only/i);
  assert.doesNotMatch(source, /\b(insert|update|delete|truncate|drop|alter|create)\b\s+(?:table|into|from|public\.)/i);
  const pkg = JSON.parse(readFileSync(path.join(process.cwd(), "package.json"), "utf8")) as {
    scripts?: Record<string, string>;
  };
  assert.equal(pkg.scripts?.["verify:supabase-security"], "tsx scripts/verifySupabaseSecurity.ts");
});

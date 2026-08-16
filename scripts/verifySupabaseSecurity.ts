import pg from "pg";

const REQUIRED_TABLES = [
  "stock_price", "stock_meta", "stock_institutional", "tdcc_shareholding", "dividend_events",
  "trading_calendar", "stock_dataset_cache", "sync_runs", "stock_trade_risk",
  "trade_risk_sync_status", "stock_margin",
] as const;
const PUBLIC_READ_TABLES = new Set([
  "stock_price", "stock_meta", "stock_institutional", "tdcc_shareholding", "dividend_events",
  "trading_calendar", "stock_trade_risk", "trade_risk_sync_status", "stock_margin",
]);
const EXPECTED_POLICIES: Record<string, string> = {
  stock_price: "stock_price_public_read",
  stock_meta: "stock_meta_public_read",
  stock_institutional: "stock_institutional_public_read",
  tdcc_shareholding: "tdcc_shareholding_public_read",
  dividend_events: "dividend_events_public_read",
  trading_calendar: "trading_calendar_public_read",
  stock_trade_risk: "stock_trade_risk_public_read",
  trade_risk_sync_status: "trade_risk_sync_status_public_read",
  stock_margin: "stock_margin_public_read",
};
const REQUIRED_CONSTRAINTS = [
  { name: "stock_price_iso_date_check", table: "stock_price", type: "c", definition: "date ~" },
  { name: "stock_price_numeric_domain_check", table: "stock_price", type: "c", definition: "high >= low" },
  { name: "stock_institutional_iso_date_check", table: "stock_institutional", type: "c", definition: "date ~" },
  { name: "tdcc_shareholding_iso_date_check", table: "tdcc_shareholding", type: "c", definition: "date ~" },
  { name: "tdcc_shareholding_numeric_domain_check", table: "tdcc_shareholding", type: "c", definition: "whale_ratio" },
  { name: "dividend_events_iso_date_check", table: "dividend_events", type: "c", definition: "date ~" },
  { name: "dividend_events_numeric_domain_check", table: "dividend_events", type: "c", definition: "cash_dividend" },
  { name: "trading_calendar_iso_date_check", table: "trading_calendar", type: "c", definition: "date ~" },
  { name: "stock_trade_risk_date_range_check", table: "stock_trade_risk", type: "c", definition: "end_date >= start_date" },
  { name: "trade_risk_sync_status_counts_check", table: "trade_risk_sync_status", type: "c", definition: "active <= cloud_total" },
  { name: "stock_price_stock_meta_fk", table: "stock_price", type: "f", definition: "references stock_meta(stock_id)" },
  { name: "stock_institutional_stock_meta_fk", table: "stock_institutional", type: "f", definition: "references stock_meta(stock_id)" },
  { name: "tdcc_shareholding_stock_meta_fk", table: "tdcc_shareholding", type: "f", definition: "references stock_meta(stock_id)" },
  { name: "dividend_events_stock_meta_fk", table: "dividend_events", type: "f", definition: "references stock_meta(stock_id)" },
  { name: "stock_dataset_cache_stock_meta_fk", table: "stock_dataset_cache", type: "f", definition: "references stock_meta(stock_id)" },
  { name: "stock_trade_risk_stock_meta_fk", table: "stock_trade_risk", type: "f", definition: "references stock_meta(stock_id)" },
  { name: "stock_margin_stock_meta_fk", table: "stock_margin", type: "f", definition: "references stock_meta(stock_id)" },
] as const;
const REQUIRED_FUNCTIONS = [
  "stock_price_histories", "stock_institutional_histories", "tdcc_shareholding_histories",
] as const;

function connection(): { connectionString: string; local: boolean } {
  const local = process.argv.includes("--local");
  const production = process.argv.includes("--production");
  if (local === production) throw new Error("choose exactly one of --local or --production");
  if (local) return {
    connectionString: process.env.LOCAL_DATABASE_URL || "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
    local: true,
  };
  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) throw new Error("DATABASE_URL is required for --production");
  return { connectionString, local: false };
}

async function run(): Promise<void> {
  const target = connection();
  const client = new pg.Client({ connectionString: target.connectionString,
    ssl: target.local ? false : { rejectUnauthorized: true } });
  await client.connect();
  const failures: string[] = [];
  try {
    await client.query("begin read only");
    const tables = await client.query<{ relname: string; relrowsecurity: boolean }>(`
      select c.relname, c.relrowsecurity
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r' and c.relname = any($1::text[])
    `, [REQUIRED_TABLES]);
    const byName = new Map(tables.rows.map((row) => [row.relname, row]));
    for (const table of REQUIRED_TABLES) {
      if (!byName.has(table)) failures.push(`missing_table:${table}`);
      else if (!byName.get(table)?.relrowsecurity) failures.push(`rls_disabled:${table}`);
    }

    const grants = await client.query<{ table_name: string; grantee: string; privilege_type: string }>(`
      select table_name, grantee, privilege_type
      from information_schema.role_table_grants
      where table_schema = 'public' and table_name = any($1::text[])
        and grantee = any($2::text[])
    `, [REQUIRED_TABLES, ["anon", "authenticated", "service_role"]]);
    for (const table of REQUIRED_TABLES) {
      const entries = grants.rows.filter((row) => row.table_name === table);
      for (const role of ["anon", "authenticated"]) {
        const privileges = entries.filter((row) => row.grantee === role).map((row) => row.privilege_type);
        if (privileges.some((item) => item !== "SELECT")) failures.push(`browser_write_grant:${table}:${role}`);
        if (PUBLIC_READ_TABLES.has(table) && !privileges.includes("SELECT")) {
          failures.push(`browser_read_missing:${table}:${role}`);
        }
      }
      const servicePrivileges = entries.filter((row) => row.grantee === "service_role")
        .map((row) => row.privilege_type);
      for (const privilege of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
        if (!servicePrivileges.includes(privilege)) failures.push(`service_grant_missing:${table}:${privilege}`);
      }
    }

    const policies = await client.query<{
      tablename: string; policyname: string; cmd: string; roles: string[]; qual: string | null;
    }>(`
      select tablename, policyname, cmd, roles::text[] as roles, qual
      from pg_policies
      where schemaname = 'public' and tablename = any($1::text[])
    `, [REQUIRED_TABLES]);
    for (const [table, policyName] of Object.entries(EXPECTED_POLICIES)) {
      const policy = policies.rows.find((row) => row.tablename === table && row.policyname === policyName);
      if (!policy) {
        failures.push(`missing_read_policy:${table}:${policyName}`);
        continue;
      }
      if (policy.cmd !== "SELECT") failures.push(`read_policy_command:${table}:${policy.cmd}`);
      for (const role of ["anon", "authenticated"]) {
        if (!policy.roles.includes(role)) failures.push(`read_policy_role_missing:${table}:${role}`);
      }
      if ((policy.qual ?? "").replace(/[()\s]/g, "") !== "true") {
        failures.push(`read_policy_not_unconditional:${table}`);
      }
    }

    const constraints = await client.query<{
      conname: string; table_name: string; contype: string; convalidated: boolean; definition: string;
    }>(`
      select con.conname, cls.relname as table_name, con.contype, con.convalidated,
        pg_get_constraintdef(con.oid, true) as definition
      from pg_constraint con
      join pg_class cls on cls.oid = con.conrelid
      join pg_namespace n on n.oid = cls.relnamespace
      where n.nspname = 'public' and con.conname = any($1::text[])
    `, [REQUIRED_CONSTRAINTS.map((item) => item.name)]);
    for (const expected of REQUIRED_CONSTRAINTS) {
      const constraint = constraints.rows.find((row) => row.conname === expected.name);
      if (!constraint) {
        failures.push(`missing_constraint:${expected.name}`);
        continue;
      }
      if (constraint.table_name !== expected.table || constraint.contype !== expected.type) {
        failures.push(`constraint_identity_mismatch:${expected.name}`);
      }
      const normalizedDefinition = constraint.definition.toLowerCase().replace(/public\./g, "");
      if (!normalizedDefinition.includes(expected.definition)) {
        failures.push(`constraint_definition_mismatch:${expected.name}`);
      }
    }

    const functions = await client.query<{
      proname: string; signature: string; prosecdef: boolean; proconfig: string[] | null;
      anon_execute: boolean; authenticated_execute: boolean; service_execute: boolean; public_execute: boolean;
    }>(`
      select p.proname, p.oid::regprocedure::text as signature, p.prosecdef, p.proconfig,
        has_function_privilege('anon', p.oid, 'EXECUTE') as anon_execute,
        has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated_execute,
        has_function_privilege('service_role', p.oid, 'EXECUTE') as service_execute,
        exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
          where acl.grantee = 0 and acl.privilege_type = 'EXECUTE') as public_execute
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = any($1::text[])
    `, [REQUIRED_FUNCTIONS]);
    for (const name of REQUIRED_FUNCTIONS) {
      const fn = functions.rows.find((row) => row.proname === name);
      if (!fn) {
        failures.push(`missing_function:${name}`);
        continue;
      }
      if (fn.prosecdef) failures.push(`unexpected_security_definer:${name}`);
      if (!fn.anon_execute || !fn.authenticated_execute || !fn.service_execute || fn.public_execute) {
        failures.push(`function_execute_grant_mismatch:${name}`);
      }
      if (!(fn.proconfig ?? []).some((value) => value.startsWith("search_path="))) {
        failures.push(`function_search_path_missing:${name}`);
      }
    }

    const unsafeFunctions = await client.query<{ proname: string }>(`
      select p.proname
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.prosecdef
        and not coalesce(p.proconfig, array[]::text[]) @> array['search_path=""']::text[]
    `);
    for (const row of unsafeFunctions.rows) failures.push(`unsafe_definer_search_path:${row.proname}`);
    await client.query("rollback");
  } catch (error) {
    try { await client.query("rollback"); } catch { /* connection may already be unavailable */ }
    throw error;
  } finally {
    await client.end();
  }

  if (failures.length > 0) throw new Error(`supabase_security_verification_failed:${failures.join(",")}`);
  console.log(JSON.stringify({ success: true, mode: target.local ? "local" : "production",
    tables: REQUIRED_TABLES.length, policies: Object.keys(EXPECTED_POLICIES).length,
    constraints: REQUIRED_CONSTRAINTS.length, functions: REQUIRED_FUNCTIONS.length }));
}

run().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "supabase_security_verification_failed");
  process.exitCode = 1;
});

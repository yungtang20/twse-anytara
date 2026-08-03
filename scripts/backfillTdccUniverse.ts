// Disabled intentionally: the historical TDCC queue must never be derived from
// Supabase metadata. The only supported command is the local-first script,
// which uses the canonical SQLite stock_meta universe.
throw new Error(
  "TDCC cloud-universe backfill is disabled; use npm run backfill:tdcc only after manual approval",
);

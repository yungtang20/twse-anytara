# TRINITY Production Readiness and Default AI Design

Date: 2026-08-16
Status: user-approved design, implementation plan ready
Repository: `D:\twse\twse-anytara`
Deployment target: existing Render service `twse-app`

## 1. Goals

- Make the current application suitable for controlled production deployment.
- Publish curated project changes to `yungtang20/twse-anytara` and replace the existing Render service source while retaining its service identity and URL.
- Keep Supabase as the production data authority; persistent SQLite remains forbidden in cloud mode.
- Let every visitor use AI explanation without creating an account or entering an administrator credential.
- Provide a server-side default HCNSEC connection when the visitor leaves AI connection fields blank.
- Let a visitor override the default by entering a personal OpenAI-compatible Base URL and API key.

## 2. Explicit boundaries

- No administrator account or login flow will be introduced for AI explanation.
- No service credential may be committed to Git, embedded in the browser bundle, returned by an API, written to Supabase, or logged.
- The default HCNSEC credential is deployment configuration and must be injected into Render as a secret environment variable.
- Supabase work is limited to approved non-destructive migrations, RLS, grants, constraints, and validation. No delete, prune, sync, refetch, or backfill is authorized.
- `D:\twse\twstock` is outside scope.
- Diagnostic and downloaded artifacts such as `_poc_*`, `_goodinfo_*`, and `_check_schema.ts` remain local and are excluded from Git publication.

## 3. Runtime architecture

```text
Browser
  -> Render Express API
      -> Supabase / official market-data providers
      -> AI provider proxy
          -> default HCNSEC connection, or
          -> visitor-supplied OpenAI-compatible connection
```

The React application and Express API are served by the existing Render Docker service. A multi-stage image builds the application with development tooling, then runs it as the unprivileged `node` user with production dependencies only. Production starts in cloud mode and binds to `0.0.0.0`. The production process must not initialize or open a persistent SQLite database.

## 4. AI connection resolution

The client exposes an AI connection panel without an administrator-token field.

| Visitor input | Effective provider |
|---|---|
| Base URL blank, API key blank | Server-side HCNSEC default |
| Base URL blank, API key supplied | HCNSEC with the visitor's API key |
| Base URL supplied, API key supplied | Visitor's OpenAI-compatible provider |
| Base URL supplied, API key blank | Reject with a clear validation message; never send the shared HCNSEC key to a custom origin |

Default HCNSEC configuration:

- Base URL: `https://api.hcnsec.cn/v1`
- Chat endpoint: `/chat/completions`
- Default model: `auto`
- Default maximum output tokens: `65536`
- Secret environment variable: `HCNSEC_API_KEY`
- Optional non-secret environment variables: `HCNSEC_BASE_URL`, `HCNSEC_MODEL`, `HCNSEC_MAX_OUTPUT_TOKENS`

The credential supplied by the user for deployment must be configured only in Render's secret environment. The design document, commits, tests, and logs use placeholders and must never contain the credential value.

## 5. Visitor-supplied credentials

- Personal API keys and Base URLs are optional.
- The UI stores a visitor's override only in `sessionStorage`; closing the browser session removes it.
- A request carries the visitor's override to the same-origin Express API over HTTPS.
- The server uses the credential only for that request and does not persist or log it.
- Error telemetry must redact authorization headers, provider keys, query strings, and request bodies that can contain confidential prompts.
- A visitor can clear the override and immediately return to the free default connection.

## 6. Custom Base URL safety

Because a server-side proxy to an arbitrary URL creates SSRF risk, a custom Base URL must pass all of these checks:

- HTTPS only.
- No embedded username or password, fragment, or query string.
- No IP-literal host.
- No localhost, `.local`, private, loopback, link-local, multicast, reserved, or cloud metadata destination.
- Resolve DNS immediately before the outbound connection and reject every forbidden resolved address.
- Do not follow redirects.
- Use an allowlisted port, initially 443 only.
- Apply strict connection, response, and total timeouts plus response-size limits.
- Normalize to one OpenAI-compatible `/v1/chat/completions` endpoint without accepting arbitrary paths.

The server-side HCNSEC fallback may be selected only when the normalized destination is exactly the configured HCNSEC origin.

## 7. AI user experience

The AI explanation view must work immediately with no setup. Its default state says that the free public AI connection is active. Advanced settings let the visitor:

- enter a personal API key;
- enter an OpenAI-compatible Base URL;
- select or enter a model;
- test the connection;
- clear the override and restore the default connection.

The UI must never display, prefill, inspect, or imply knowledge of the server-side shared key. Connection-test responses return only a success state and sanitized provider/model metadata.

Before first HCNSEC use, show a concise privacy notice and require acknowledgement. The notice explains that the third-party provider states it can retain request time, IP, device data, request content, and response content for at least 180 days, and warns against sending personal, confidential, authentication, or unpublished business information.

## 8. AI execution and publication safety

- Existing AI research auditing and publication gates remain authoritative.
- Switching credentials or providers must not bypass evidence requirements, audit findings, or publication readiness checks.
- Provider output is untrusted input. It must be validated, bounded, and handled as data rather than executable instructions.
- Public provider errors are mapped to stable application error codes with a correlation ID; raw upstream bodies and secrets are not returned.
- A provider response with `finish_reason=length` is truncated and must never enter the report audit/publication path as a complete candidate.
- The application must clearly label generated explanations as AI output rather than verified investment advice.

## 9. Abuse controls

Anonymous default AI access requires protection of the shared connection:

- IP-based bounded rate limiting for AI endpoints, with trusted-proxy handling explicitly configured for Render.
- Concurrency limit, request-body limit, prompt-length limit, a default HCNSEC output ceiling of 65,536 tokens, and upstream timeout.
- A conservative daily allowance for the shared default provider, configurable through environment variables.
- Visitor-supplied credentials still receive transport and abuse limits, but do not consume the shared-provider allowance.
- Health checks are exempt from AI rate limits.
- No automatic retry storm; retry behavior is bounded and only applies to transient failures.

## 10. Broader production remediation

- Update existing npm dependencies and lockfile to remove known production high/critical vulnerabilities without unrelated major upgrades.
- Add real ESLint and focused Vitest/React Testing Library/jsdom coverage.
- Harden public API error handling, request correlation, rate limiting, origin/host behavior, and dangerous maintenance scripts.
- Maintenance scripts default to dry-run and require an explicit execute flag plus environment/project confirmation; TLS verification remains enabled and failures return nonzero status.
- Make canonical Supabase migrations replayable on a blank database and verify RLS, grants, constraints, and security-definer behavior.
- Retain current frontend request-cancellation and stale-state protections and test the affected UI behavior.

## 11. Verification gates

Before publication or deployment, run and record:

- dependency audit with zero known production high/critical findings;
- `npm run typecheck`;
- real lint command;
- canonical `npm test`;
- focused frontend behavior tests;
- `npm run test:eval`;
- `npm run build`;
- production-start smoke test;
- blank Supabase migration replay and database security checks;
- secret scan proving the HCNSEC credential is absent from tracked files and built browser assets.

An unexecuted check is reported as `未驗證`, never as failed or passed.

## 12. GitHub and Render cutover

1. Implement and verify locally using curated file scope.
2. Commit intentionally and open a pull request against `main`.
3. Require green CI before merge.
4. Snapshot the current Render service repository, branch, build/start commands, environment variable names, health path, and deploy identifier.
5. Apply only approved additive Supabase changes and verify them.
6. Configure the default AI credential as a Render secret; never expose its value in logs or documentation.
7. Repoint the existing `twse-app` service to `yungtang20/twse-anytara`, preserving the existing service and public URL.
8. Deploy and smoke-test health, static assets, market APIs, default AI, visitor BYOK, secret non-disclosure, and the no-SQLite cloud boundary.
9. Restore controlled automatic deployment after acceptance.

## 13. Rollback

- Preserve the previous Render repository/configuration and deploy identifier before cutover.
- If runtime or smoke verification fails, restore the prior repository/configuration or redeploy the prior known-good deploy.
- Do not perform a destructive database rollback. Additive Supabase changes remain unless a separately reviewed forward migration is approved.
- Revoke or rotate the shared HCNSEC key independently if abuse or disclosure is suspected.

## 14. Acceptance criteria

The work is complete only when:

- a visitor can request AI explanation with every AI field blank;
- a visitor can override the default with a personal compatible provider;
- a custom URL without a personal key cannot receive the server-side shared key;
- no administrator account or administrator credential is required for AI explanation;
- the shared credential is absent from Git, browser assets, API responses, logs, and Supabase;
- AI audit/publication gates still apply;
- required local and CI checks pass;
- approved Supabase verification succeeds;
- the existing Render URL serves the new repository and passes production smoke checks;
- rollback evidence is recorded.

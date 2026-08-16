# TRINITY Production Readiness and Default AI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship TRINITY on the existing Render `twse-app` service with anonymous default HCNSEC AI, optional visitor BYOK overrides, hardened production boundaries, verified Supabase migrations, and a reversible GitHub/Render cutover.

**Architecture:** React stores optional visitor AI overrides in `sessionStorage` and sends them only with an AI report request. Express resolves each request to either the server-side HCNSEC secret or a visitor-supplied OpenAI-compatible connection, pins outbound DNS to a validated public address, applies anonymous abuse controls, and feeds the response through the existing model audit and publication gate. Supabase remains the cloud authority; GitHub and Render publication happens only after local, CI, database, and secret-disclosure gates pass.

**Tech Stack:** Node.js 24+, TypeScript, React 19, Express 4, Vite 6, Supabase/Postgres, Node `https`/`dns`/`net`, ESLint, Vitest, React Testing Library, jsdom, GitHub Actions, Render.

## Global Constraints

- No administrator account or administrator credential is required for AI explanation.
- Empty Base URL and API key select server-side HCNSEC at `https://api.hcnsec.cn/v1`, endpoint `/chat/completions`, model `auto`.
- Default HCNSEC requests use `max_tokens: 65536`; `finish_reason=length` is a truncation failure, never a complete report.
- A custom Base URL without a visitor API key is rejected; the shared HCNSEC key is never sent to a custom origin.
- The shared key exists only as Render secret `HCNSEC_API_KEY`; it is absent from Git, browser bundles, API responses, logs, Supabase, fixtures, and documentation.
- Visitor overrides live only in `sessionStorage` and are never persisted server-side.
- Custom destinations are HTTPS port 443, public DNS/IP only, pinned for the connection, and never redirected.
- Existing AI report auditing and publication gates remain mandatory.
- Production market data remains Supabase/cloud-only; persistent SQLite is forbidden outside OS-temporary test mode.
- Supabase changes are additive and non-destructive; no delete, prune, sync, refetch, or backfill is authorized.
- Preserve unrelated user changes and exclude `_poc_*`, `_goodinfo_*`, `_check_schema.ts`, downloaded, diagnostic, and temporary artifacts from Git.
- An unexecuted check is reported as `未驗證`, never as passed or failed.

---

## File Structure

- `shared/aiProvider.ts`: request-safe visitor override and resolved provider types.
- `server/lib/aiProviderConnection.ts`: input normalization, HCNSEC fallback selection, environment validation, and privacy acknowledgement.
- `server/lib/publicEndpoint.ts`: public-IP classification and DNS resolution used by outbound provider calls.
- `server/lib/openAICompatibleTransport.ts`: pinned HTTPS POST transport with timeout and response-size limits.
- `server/lib/aiResearchRouterAdapter.ts`: converts the existing research request to the resolved provider transport.
- `server/lib/aiResearchModelGateway.ts`, `server/lib/aiResearchModelRunner.ts`, `server/lib/aiResearchOrchestrator.ts`: thread per-request provider context through the existing audited pipeline.
- `server/lib/aiAbuseGuard.ts`: bounded in-memory IP, daily shared-provider, and concurrency controls.
- `server/routes/aiResearch.ts`: public AI report request parsing, privacy enforcement, abuse controls, sanitized errors, and correlation ID.
- `src/lib/aiProviderSettings.ts`: `sessionStorage` load/save/clear and request serialization.
- `src/lib/api.ts`: sends optional AI provider override with report requests.
- `src/components/views/SettingsView.tsx`: local AI override UI; removes administrator-token/server-secret editing.
- `src/components/views/AIResearchView.tsx`: default-free-provider status, privacy acknowledgement, and connection guidance.
- `tests/ai-provider-connection.test.ts`, `tests/openai-compatible-transport.test.ts`, `tests/ai-abuse-guard.test.ts`: server unit tests.
- `tests/ai-research-report-route.test.ts`, `tests/ai-research-router-adapter.test.ts`, `tests/ai-research-model-runner.test.ts`: audited pipeline regression tests.
- `src/**/*.test.tsx`, `vitest.config.ts`, `tests/setup-dom.ts`: focused browser behavior tests.
- `eslint.config.js`, `package.json`, `package-lock.json`, `.github/workflows/ci.yml`: real lint/test and supply-chain gates.
- `scripts/emergency_prune.ts`, `scripts/run_vacuum.ts`: fail-closed maintenance behavior.
- `supabase/migrations/*.sql`: blank-replayable additive schema, RLS, grants, and constraints.
- `.env.example`, `README.md`, `.gitignore`, `render.yaml`: deployment contract and tracked design/plan documents.

---

### Task 1: Freeze Baseline and Curated Scope

**Files:**
- Inspect: all currently modified and untracked paths
- Inspect: terminal evidence for status, diff statistics, and tracked scope

**Interfaces:**
- Consumes: current dirty worktree and approved include/exclude rules.
- Produces: an immutable local inventory used before every commit; no source mutation.

- [ ] **Step 1: Capture the current worktree without staging**

Run:

```powershell
git status --short --untracked-files=all
git diff --stat
git ls-files
```

Expected: commands exit `0`; Git index remains unchanged.

- [ ] **Step 2: Record the decisive starting checks**

Run:

```powershell
npm run typecheck
npm test
npm run test:eval
npm run build
npm audit --omit=dev --json
```

Expected: record each actual exit code; audit findings are baseline evidence, not silently reclassified.

- [ ] **Step 3: Confirm no shared credential is already tracked**

Run a secret scanner against tracked files using only the key prefix pattern, with findings redacted in output:

```powershell
$hits = git grep -Il -E 'sk-[A-Za-z0-9]{20,}' -- .
if ($hits) { $hits; exit 1 }
```

Expected: exit `0` and no paths.

### Task 2: Define Provider Contracts and Fallback Resolution

**Files:**
- Create: `shared/aiProvider.ts`
- Create: `server/lib/aiProviderConnection.ts`
- Test: `tests/ai-provider-connection.test.ts`

**Interfaces:**
- Produces: `AIProviderOverride`, `ResolvedAIProviderConnection`, `AIProviderConnectionError`, and `resolveAIProviderConnection(input, env)`.
- Consumed by: Tasks 3, 4, 5, and 7.

- [ ] **Step 1: Write failing resolution tests**

Add cases asserting these exact outcomes:

```ts
assert.deepEqual(resolveAIProviderConnection({ privacyAccepted: true }, {
  HCNSEC_API_KEY: "server-key",
}), {
  source: "default",
  apiKey: "server-key",
  baseUrl: "https://api.hcnsec.cn/v1",
  model: "auto",
  privacyAccepted: true,
});
assert.equal(captureCode(() => resolveAIProviderConnection({
  baseUrl: "https://example.com/v1", privacyAccepted: true,
}, { HCNSEC_API_KEY: "server-key" })), "custom_key_required");
assert.equal(captureCode(() => resolveAIProviderConnection({}, {
  HCNSEC_API_KEY: "server-key",
})), "hcnsec_privacy_ack_required");
```

- [ ] **Step 2: Run the test and observe the missing-module failure**

Run: `npx tsx --test tests/ai-provider-connection.test.ts`

Expected: FAIL because `shared/aiProvider.ts` and resolver do not exist.

- [ ] **Step 3: Add exact shared contracts**

Implement:

```ts
export interface AIProviderOverride {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  privacyAccepted?: boolean;
}

export interface ResolvedAIProviderConnection {
  source: "default" | "visitor";
  apiKey: string;
  baseUrl: string;
  model: string;
  privacyAccepted: boolean;
}
```

Implement `resolveAIProviderConnection` with maximum lengths of 2048 for Base URL, 4096 for key, and 128 for model. Blank URL resolves to HCNSEC. A supplied custom URL requires a supplied visitor key. HCNSEC use requires `privacyAccepted === true`. Environment values are `HCNSEC_API_KEY`, `HCNSEC_BASE_URL`, `HCNSEC_MODEL`, and `HCNSEC_MAX_OUTPUT_TOKENS`, defaulting to the approved URL, model, and 65,536-token ceiling.

- [ ] **Step 4: Run the resolver tests**

Run: `npx tsx --test tests/ai-provider-connection.test.ts`

Expected: PASS for default, visitor HCNSEC, custom provider, missing shared key, missing custom key, control characters, length limits, and privacy acknowledgement.

- [ ] **Step 5: Commit the contract slice**

```powershell
git add -- shared/aiProvider.ts server/lib/aiProviderConnection.ts tests/ai-provider-connection.test.ts
git commit -m "feat: define safe AI provider resolution"
```

### Task 3: Validate and Pin Public HTTPS Destinations

**Files:**
- Create: `server/lib/publicEndpoint.ts`
- Create: `server/lib/openAICompatibleTransport.ts`
- Test: `tests/public-endpoint.test.ts`
- Test: `tests/openai-compatible-transport.test.ts`

**Interfaces:**
- Produces: `resolvePublicHttpsEndpoint(baseUrl, lookupFn)`, `postChatCompletion(connection, payload, options)`, and `probeProviderConnection(connection, options)`.
- Consumes: `ResolvedAIProviderConnection` from Task 2.

- [ ] **Step 1: Write failing URL and address tests**

Cover exact rejection codes for HTTP, credentials in URL, query/fragment, non-443 port, IP literal, localhost, `.local`, unsupported path, private IPv4, loopback IPv6, link-local IPv6, mixed public/private DNS answers, and empty DNS answers. Accept only root or `/v1`, normalized to `/v1/chat/completions`.

```ts
assert.equal(await captureAsyncCode(() => resolvePublicHttpsEndpoint(
  "https://example.test/v1", async () => [
    { address: "203.0.113.10", family: 4 },
    { address: "127.0.0.1", family: 4 },
  ],
)), "provider_dns_forbidden");
```

- [ ] **Step 2: Run and confirm failure**

Run: `npx tsx --test tests/public-endpoint.test.ts tests/openai-compatible-transport.test.ts`

Expected: FAIL because the modules do not exist.

- [ ] **Step 3: Implement endpoint normalization and address classification**

Use `node:dns/promises.lookup` with `{ all: true, verbatim: true }`, `node:net.isIP`, and a `BlockList` containing RFC1918, loopback, link-local, carrier-grade NAT, documentation, multicast, unique-local IPv6, and IPv4-mapped forbidden ranges. Reject the destination if any DNS answer is forbidden. Return:

```ts
export interface ResolvedPublicEndpoint {
  endpoint: URL;
  address: string;
  family: 4 | 6;
  servername: string;
}
```

- [ ] **Step 4: Implement a pinned no-redirect HTTPS transport**

Use `node:https.request` with `rejectUnauthorized: true`, `servername`, `Host`, `method: "POST"`, and a custom `lookup` callback that returns only the validated address/family. Set the Bearer authorization header from `connection.apiKey` and `Content-Type: application/json`. Enforce a 300-second total timeout, 2 MiB maximum response, status classification, JSON parsing, and caller abort. Do not emit the URL query, request body, API key, or raw provider body in errors. Implement `probeProviderConnection` as a pinned `GET /v1/models` request that returns only `{ ok: true, modelCount: number }`.

- [ ] **Step 5: Pass endpoint and transport tests**

Run: `npx tsx --test tests/public-endpoint.test.ts tests/openai-compatible-transport.test.ts`

Expected: PASS, including proof that redirects are rejected and the injected lookup returns the validated address.

- [ ] **Step 6: Commit the outbound boundary**

```powershell
git add -- server/lib/publicEndpoint.ts server/lib/openAICompatibleTransport.ts tests/public-endpoint.test.ts tests/openai-compatible-transport.test.ts
git commit -m "feat: pin safe OpenAI compatible connections"
```

### Task 4: Thread Per-Request Provider Context Through the Audited Pipeline

**Files:**
- Modify: `server/lib/aiResearchModelGateway.ts`
- Modify: `server/lib/aiResearchRouterAdapter.ts`
- Modify: `server/lib/aiResearchModelRunner.ts`
- Modify: `server/lib/aiResearchOrchestrator.ts`
- Modify: `server/lib/aiResearchProduction.ts`
- Test: `tests/ai-research-router-adapter.test.ts`
- Test: `tests/ai-research-model-gateway.test.ts`
- Test: `tests/ai-research-model-runner.test.ts`
- Test: `tests/ai-research-orchestrator.test.ts`

**Interfaces:**
- Consumes: `ResolvedAIProviderConnection` and `postChatCompletion`.
- Produces: `generateCandidate(request, { signal, connection })` and `research(stockId, { signal, connection })` without weakening audit/publication behavior.

- [ ] **Step 1: Write failing provider-threading tests**

Assert that a visitor connection reaches the adapter, provider metadata returns only `provider`, `model`, duration, and token counts, and neither API key nor Base URL appears in the result. Re-run existing two-attempt correction and publication-gate tests unchanged.

- [ ] **Step 2: Run focused tests and confirm type/runtime failure**

Run:

```powershell
npx tsx --test tests/ai-research-router-adapter.test.ts tests/ai-research-model-runner.test.ts tests/ai-research-orchestrator.test.ts
```

Expected: FAIL because the gateway options do not yet accept `connection`.

- [ ] **Step 3: Extend the gateway option contract**

Change the gateway signature to:

```ts
generateCandidate(
  request: AIResearchModelRequest,
  options: { signal?: AbortSignal; connection: ResolvedAIProviderConnection },
): Promise<AIResearchModelGatewayResult>;
```

Use provider metadata values `hcnsec`, `custom`, and `fake`; never include connection objects in metadata.

- [ ] **Step 4: Replace fixed SDK configuration with the pinned transport**

Build the same system/user messages, `response_format: { type: "json_object" }`, `stream: false`, and `max_tokens: 65536` for the default HCNSEC connection. Validate optional `HCNSEC_MAX_OUTPUT_TOKENS` as an integer from 16,384 through 65,536. Use `connection.model`, parse `choices[0].message.content`, map `finish_reason=length` to a stable `truncated` gateway error before JSON audit, and preserve the existing error taxonomy.

- [ ] **Step 5: Pass connection through runner and orchestrator**

Extend `AIResearchModelRunnerContract.generateAudited` and `AIResearchOrchestrator.research` options with the required resolved connection. Keep the existing `gateResearchPublication` call around the hydrated selection as the only successful publication path. Update every direct gateway, runner, and orchestrator test call to supply a fixture connection.

- [ ] **Step 6: Run focused and boundary tests**

Run:

```powershell
npx tsx --test tests/ai-research-model-gateway.test.ts tests/ai-research-router-adapter.test.ts tests/ai-research-model-runner.test.ts tests/ai-research-orchestrator.test.ts tests/ai-research-publication-gate.test.ts tests/ai-research-auditor.test.ts
```

Expected: PASS; existing audit and correction semantics remain intact.

- [ ] **Step 7: Commit the audited provider integration**

```powershell
git add -- server/lib/aiResearchModelGateway.ts server/lib/aiResearchRouterAdapter.ts server/lib/aiResearchModelRunner.ts server/lib/aiResearchOrchestrator.ts server/lib/aiResearchProduction.ts tests/ai-research-model-gateway.test.ts tests/ai-research-router-adapter.test.ts tests/ai-research-model-runner.test.ts tests/ai-research-orchestrator.test.ts
git commit -m "feat: support per-request audited AI providers"
```

### Task 5: Add Anonymous Abuse Controls

**Files:**
- Create: `server/lib/aiAbuseGuard.ts`
- Test: `tests/ai-abuse-guard.test.ts`
- Modify: `server.ts`

**Interfaces:**
- Produces: `AIAbuseGuard.acquire({ clientId, usesSharedProvider, nowMs })` returning a release callback or a stable rejection code.
- Consumed by: Task 6 report route.

- [ ] **Step 1: Write failing guard tests**

Test a 10-request/10-minute per-client window, configurable shared daily allowance, configurable global concurrency, release after success/failure, UTC-day rollover, bounded map cleanup, and `x-forwarded-for` trust only when Express `trust proxy` is set to one Render hop.

- [ ] **Step 2: Run and confirm missing-module failure**

Run: `npx tsx --test tests/ai-abuse-guard.test.ts`

Expected: FAIL because the guard does not exist.

- [ ] **Step 3: Implement bounded in-memory counters**

Read and validate:

```text
AI_RATE_LIMIT_REQUESTS=10
AI_RATE_LIMIT_WINDOW_MS=600000
AI_SHARED_DAILY_LIMIT=100
AI_MAX_CONCURRENCY=2
```

Invalid, non-integer, negative, or unreasonably large values fail startup rather than disabling protection. Return stable codes `ai_rate_limited`, `ai_shared_daily_limit`, and `ai_concurrency_limit`.

- [ ] **Step 4: Configure Render proxy handling**

In production set `app.set("trust proxy", 1)` before route mounting. In test mode leave proxy trust disabled unless a test explicitly enables it.

- [ ] **Step 5: Run tests and commit**

```powershell
npx tsx --test tests/ai-abuse-guard.test.ts
git add -- server/lib/aiAbuseGuard.ts tests/ai-abuse-guard.test.ts server.ts
git commit -m "feat: bound anonymous AI usage"
```

Expected: test exits `0`; commit contains no unrelated server changes.

### Task 6: Make the AI Report Route Public Without Making Admin APIs Public

**Files:**
- Modify: `server/routes/aiResearch.ts`
- Test: `tests/ai-research-report-route.test.ts`
- Test: `tests/admin-security.test.ts`

**Interfaces:**
- Consumes: provider resolver, abuse guard, and orchestrator provider options.
- Produces: anonymous `POST /api/ai-research/stocks/:stockId/report`, `POST /api/ai-provider/test`, and response header `X-Correlation-Id`.

- [ ] **Step 1: Replace route expectations with failing public-flow tests**

Add assertions for:

```ts
await requestReport({ provider: { privacyAccepted: true } }, 200);
await requestReport({ provider: {
  baseUrl: "https://example.com/v1",
  apiKey: "visitor-key",
  model: "model-a",
  privacyAccepted: true,
} }, 200);
await requestReport({ provider: {
  baseUrl: "https://example.com/v1",
  privacyAccepted: true,
} }, 400, "custom_key_required");
```

Also assert that report output and serialized errors contain neither test key nor custom Base URL. Add connection-probe cases asserting that `/api/ai-provider/test` uses the same resolver, privacy gate, SSRF checks, and abuse guard, and returns only `{ success: true, modelCount }` plus a correlation ID.

- [ ] **Step 2: Run focused route tests**

Run: `npx tsx --test tests/ai-research-report-route.test.ts tests/admin-security.test.ts`

Expected: FAIL because report access still requires loopback/admin authorization.

- [ ] **Step 3: Remove admin checks only from the AI report route**

Delete `isLoopbackRequest` and `authorizeAdminRequest` use from the report handler. Keep `/api/settings`, cleanup, diagnostics, and other administrative routes behind `requireAdminRequest`. Parse only the `provider` object from the JSON body and reject unknown/oversized types through the resolver.

- [ ] **Step 4: Integrate guard and sanitized errors**

Resolve the connection before acquiring the guard. Use `request.ip` as the client ID, set/generate a correlation ID, release concurrency in `finally`, and map connection/guard failures to stable 400/429/503 responses. Add `/api/ai-provider/test` beside the report route and call `probeProviderConnection`; return only success, sanitized model count, and correlation ID. Never attach the request body or upstream error to the response or console.

- [ ] **Step 5: Run route and security regression tests**

Run:

```powershell
npx tsx --test tests/ai-research-report-route.test.ts tests/admin-security.test.ts tests/cloud-api-boundary.test.ts tests/ai-research-publication-gate.test.ts
```

Expected: PASS; anonymous AI works while administrative settings remain protected.

- [ ] **Step 6: Commit the route slice**

```powershell
git add -- server/routes/aiResearch.ts tests/ai-research-report-route.test.ts tests/admin-security.test.ts
git commit -m "feat: expose guarded anonymous AI research"
```

### Task 7: Build the Session-Only AI Settings Experience

**Files:**
- Create: `src/lib/aiProviderSettings.ts`
- Create: `src/lib/aiProviderSettings.test.ts`
- Modify: `src/lib/api.ts`
- Modify: `src/components/views/SettingsView.tsx`
- Modify: `src/components/views/AIResearchView.tsx`
- Create: `src/components/views/SettingsView.test.tsx`
- Create: `src/components/views/AIResearchView.test.tsx`

**Interfaces:**
- Consumes: `AIProviderOverride` request contract.
- Produces: `loadAIProviderOverride`, `saveAIProviderOverride`, `clearAIProviderOverride`, and `runAIResearch(stockId, signal, provider)`.

- [ ] **Step 1: Write failing storage and component tests**

Verify these user-visible behaviors:

- initial state says `免費 AI 已啟用` and contains no admin-token field;
- no API fields are required to submit after HCNSEC privacy acknowledgement;
- personal Base URL/key/model save only under `trinity.aiProviderOverride` in `sessionStorage`;
- clearing restores default mode;
- custom URL with blank key shows `自訂 Base URL 必須填入自己的 API Key`;
- the server-side shared key never appears in DOM, storage, or fetch body;
- the acknowledgement is stored as `trinity.hcnsecPrivacyAccepted=true` in `sessionStorage`.

- [ ] **Step 2: Install approved test/lint development dependencies**

Run:

```powershell
npm install --save-dev eslint @eslint/js typescript-eslint eslint-plugin-react-hooks vitest @testing-library/react @testing-library/jest-dom jsdom
```

Expected: `package.json` and `package-lock.json` change; no production dependency is added by this command.

- [ ] **Step 3: Run component tests and confirm failure**

Run: `npx vitest run src/lib/aiProviderSettings.test.ts src/components/views/SettingsView.test.tsx src/components/views/AIResearchView.test.tsx`

Expected: FAIL because storage helpers and new UI do not exist.

- [ ] **Step 4: Implement session-only storage helpers**

Use only these storage keys and never fall back to `localStorage`:

```ts
export const AI_PROVIDER_STORAGE_KEY = "trinity.aiProviderOverride";
export const HCNSEC_PRIVACY_STORAGE_KEY = "trinity.hcnsecPrivacyAccepted";
```

On malformed stored JSON, remove the entry and return an empty override. Do not store blank API keys or the default provider's server-side values.

- [ ] **Step 5: Replace the Settings view**

Remove administrator token, FinMind server-key editing, `.env` save text, and calls to `/api/settings`. Add password-masked API key, Base URL, model, connection mode/status, save-for-session, clear, and test-connection controls. The default mode explains that the free HCNSEC API is used when fields are blank.

- [ ] **Step 6: Add privacy acknowledgement and request serialization**

Before the first effective HCNSEC report request, require acknowledgement of the 180-day third-party retention notice. Pass this request shape:

```ts
body: JSON.stringify({
  provider: {
    ...loadAIProviderOverride(),
    privacyAccepted: readHcnsecPrivacyAccepted(),
  },
})
```

Do not add `X-Trinity-Admin-Token` to AI requests.

- [ ] **Step 7: Pass browser tests**

Run: `npx vitest run src/lib/aiProviderSettings.test.ts src/components/views/SettingsView.test.tsx src/components/views/AIResearchView.test.tsx`

Expected: PASS with no console errors and no state leakage between tests.

- [ ] **Step 8: Commit the visitor experience**

```powershell
git add -- src/lib/aiProviderSettings.ts src/lib/aiProviderSettings.test.ts src/lib/api.ts src/components/views/SettingsView.tsx src/components/views/SettingsView.test.tsx src/components/views/AIResearchView.tsx src/components/views/AIResearchView.test.tsx
git commit -m "feat: add default AI and session-only BYOK"
```

### Task 8: Add Real Lint and Canonical Test Registration

**Files:**
- Create: `eslint.config.js`
- Create: `vitest.config.ts`
- Create: `tests/setup-dom.ts`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `tests/test-suite-registration.test.ts`
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Produces: `npm run lint`, `npm run test:ui`, and canonical CI gates.

- [ ] **Step 1: Write failing script-registration assertions**

Require `package.json` scripts to contain:

```json
{
  "lint": "eslint . --max-warnings=0",
  "test:ui": "vitest run"
}
```

Require canonical `npm test` to register the four new server test files and CI to execute `npm run lint` plus `npm run test:ui`.

- [ ] **Step 2: Run the registration test**

Run: `npx tsx --test tests/test-suite-registration.test.ts`

Expected: FAIL because scripts and CI are not registered.

- [ ] **Step 3: Create explicit ESLint and Vitest configurations**

Lint TypeScript/TSX, enable React Hooks recommended rules, ignore `dist`, `build`, `coverage`, `.tmp`, downloaded artifacts, and generated files, and set zero warnings. Configure Vitest with jsdom only for `src/**/*.test.tsx`, the DOM setup file, restored mocks, and cleared storage between tests.

- [ ] **Step 4: Update scripts and CI**

Add new server tests to `npm test`, add `test:ui`, replace fake lint, and order CI as install, typecheck, lint, server tests, UI tests, evaluation, build.

- [ ] **Step 5: Run all static and focused tests**

```powershell
npm run typecheck
npm run lint
npm test
npm run test:ui
```

Expected: all exit `0`; fix source lint findings without disabling rules that protect correctness or secrets.

- [ ] **Step 6: Commit toolchain gates**

```powershell
git add -- eslint.config.js vitest.config.ts tests/setup-dom.ts package.json package-lock.json tests/test-suite-registration.test.ts .github/workflows/ci.yml
git commit -m "test: enforce lint and browser behavior gates"
```

### Task 9: Harden Destructive Maintenance Scripts

**Files:**
- Modify: `scripts/emergency_prune.ts`
- Modify: `scripts/run_vacuum.ts`
- Create: `tests/maintenance-execution-guard.test.ts`
- Modify: `package.json`

**Interfaces:**
- Produces: dry-run-by-default CLIs requiring `--execute` and exact project confirmation.

- [ ] **Step 1: Write failing process-level tests**

Spawn both scripts without `--execute` using fake environment values and assert no mutating client method executes. Require `--execute --project-ref <expected-ref>` plus `SUPABASE_PROJECT_REF=<expected-ref>`. Verify database/provider errors produce a nonzero exit code.

- [ ] **Step 2: Run and confirm current unsafe behavior fails the contract**

Run: `npx tsx --test tests/maintenance-execution-guard.test.ts`

Expected: FAIL because the scripts lack the execution gate and vacuum suppresses failures.

- [ ] **Step 3: Implement fail-closed argument parsing**

Default output is a bounded operation preview. Execution requires both flag and exact project reference. Check every Supabase `{ error }`. Set `process.exitCode = 1` on failure. Keep PostgreSQL TLS certificate validation enabled and remove `rejectUnauthorized: false`.

- [ ] **Step 4: Run maintenance tests**

Run: `npx tsx --test tests/maintenance-execution-guard.test.ts tests/maintenance-sqlite-boundary.test.ts`

Expected: PASS without contacting production Supabase.

- [ ] **Step 5: Commit script hardening**

```powershell
git add -- scripts/emergency_prune.ts scripts/run_vacuum.ts tests/maintenance-execution-guard.test.ts package.json
git commit -m "fix: make maintenance scripts fail closed"
```

### Task 10: Repair Supply-Chain Findings Without Unrelated Majors

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Produces: reproducible npm install with zero known production high/critical audit findings.

- [ ] **Step 1: Capture exact dependency paths**

Run:

```powershell
npm audit --omit=dev
npm explain brace-expansion
npm explain fast-uri
npm explain ip-address
npm explain hono
npm explain @hono/node-server
```

Expected: commands identify the parent packages and available compatible fixes.

- [ ] **Step 2: Apply compatible updates**

Run:

```powershell
npm update @modelcontextprotocol/sdk glob
```

Re-run `npm explain` and update another already-declared direct dependency only if the remaining vulnerable path proves it is the parent. Do not add an unrelated production package and do not accept a major update outside the approved dependency family.

- [ ] **Step 3: Verify the lockfile and application**

```powershell
npm ci
npm audit --omit=dev
npm run typecheck
npm test
npm run test:ui
npm run build
```

Expected: audit has zero high/critical production findings and all commands exit `0`.

- [ ] **Step 4: Commit dependency remediation**

```powershell
git add -- package.json package-lock.json
git commit -m "chore: remediate production dependency findings"
```

### Task 11: Verify Additive Supabase Bootstrap and Security

**Files:**
- Modify: `supabase/migrations/20260731000000_harden_stock_price_access.sql`
- Modify or add: `supabase/migrations/20260815014954_add_stock_margin_and_integrity_contracts.sql`
- Create: `tests/supabase-blank-replay.test.ts`
- Create: `scripts/verifySupabaseSecurity.ts`
- Modify: `package.json`

**Interfaces:**
- Produces: blank-replayable additive migration chain and read-only verification command.

- [ ] **Step 1: Write a failing blank-replay contract test**

Require migrations to create prerequisites before altering them; enable RLS on public tables; revoke writes from `anon`/`authenticated`; grant only required reads; grant service-role writes; preserve primary/unique/check constraints; and set explicit `search_path` for security-definer functions.

- [ ] **Step 2: Run local migration replay in an isolated temporary database**

Run the repository migration chain through an isolated local Supabase stack:

```powershell
npx --yes supabase start
npx --yes supabase db reset
npx --yes supabase stop --no-backup
```

Do not point these commands at production credentials. If the required local container runtime is unavailable, record blank replay as `未驗證` and block production release until an isolated runner completes it.

Expected: current chain fails if an `ALTER TABLE` precedes table creation; capture exact SQL error.

- [ ] **Step 3: Make migrations additive and replayable**

Create missing tables with `CREATE TABLE IF NOT EXISTS`, add constraints through idempotent guarded blocks, and preserve existing production data. Do not include `DELETE`, `TRUNCATE`, `DROP`, sync, refetch, or backfill statements.

- [ ] **Step 4: Implement read-only schema verification**

`npm run verify:supabase-security` must query catalogs/advisors only and report RLS, grants, constraints, function security, and missing objects. It must never write data.

- [ ] **Step 5: Pass local database gates**

```powershell
npx tsx --test tests/supabase-blank-replay.test.ts
npm run verify:supabase-security -- --local
```

Expected: blank replay and security contract exit `0`.

- [ ] **Step 6: Commit database contracts**

```powershell
git add -- supabase/migrations/20260731000000_harden_stock_price_access.sql supabase/migrations/20260815014954_add_stock_margin_and_integrity_contracts.sql tests/supabase-blank-replay.test.ts scripts/verifySupabaseSecurity.ts package.json
git commit -m "fix: make Supabase schema replayable and least privilege"
```

### Task 12: Document and Configure Production Runtime

**Files:**
- Create: `Dockerfile`
- Create: `.dockerignore`
- Modify: `.env.example`
- Modify: `README.md`
- Modify: `.gitignore`
- Create: `render.yaml`
- Modify: `scripts/start-production.mjs`
- Test: `tests/production-runtime.test.ts`

**Interfaces:**
- Produces: Render build/start/health contract and documentation matching actual behavior.

- [ ] **Step 1: Write failing production contract tests**

Require:

```text
runtime: docker
dockerfilePath: ./Dockerfile
dockerContext: .
healthCheckPath: /api/health
NODE_ENV=production
MARKET_DATA_MODE=cloud
HOST=0.0.0.0
CI docker build and HTTP startup smoke
```

Also require documented `HCNSEC_API_KEY`, `HCNSEC_BASE_URL`, `HCNSEC_MODEL`, `HCNSEC_MAX_OUTPUT_TOKENS=65536`, abuse-limit variables, privacy behavior, BYOK flow, and no-SQLite boundary.

- [ ] **Step 2: Run and confirm missing configuration failure**

Run: `npx tsx --test tests/production-runtime.test.ts`

Expected: FAIL because `render.yaml` and the new environment contract are missing.

- [ ] **Step 3: Add Render and environment configuration**

Define one Docker/native web service only if it matches the existing Render service type discovered during cutover; do not create a second service. Mark secrets `sync: false`. Set the health path and cloud runtime values. Update `.gitignore` so only approved `docs/superpowers/specs/*.md` and `docs/superpowers/plans/*.md` are trackable while other ignored documentation artifacts remain excluded.

- [ ] **Step 4: Update operator documentation**

Document default AI startup, personal override, session-only storage, HCNSEC privacy warning, rate limits, Render secret names, Supabase authority, verification commands, and rollback. Remove claims that the Settings page writes production `.env` secrets.

- [ ] **Step 5: Pass production contract and start smoke test**

```powershell
npx tsx --test tests/production-runtime.test.ts
npm run build
$env:NODE_ENV='production'; $env:MARKET_DATA_MODE='cloud'; $env:HOST='127.0.0.1'; $env:PORT='4317'; npm start
```

From a second shell, request `/api/health` and a static asset, then terminate gracefully. Expected: HTTP 200 responses, no SQLite file creation, and clean SIGTERM exit.

- [ ] **Step 6: Commit deployment documentation**

```powershell
git add -- Dockerfile .dockerignore .env.example README.md .gitignore render.yaml scripts/start-production.mjs tests/production-runtime.test.ts .github/workflows/ci.yml docs/superpowers/specs/2026-08-16-production-readiness-byok-ai-design.md docs/superpowers/plans/2026-08-16-production-readiness-default-ai.md
git commit -m "docs: define verified Render production contract"
```

### Task 13: Run the Full Release Gate and Independent Diff Review

**Files:**
- Inspect: curated Git diff and generated `dist/`
- Inspect: terminal verification and secret-scan evidence

**Interfaces:**
- Consumes: all implementation tasks.
- Produces: local release verdict and exact evidence for GitHub publication.

- [ ] **Step 1: Run canonical checks from a clean install**

```powershell
npm ci
npm audit --omit=dev
npm run typecheck
npm run lint
npm test
npm run test:ui
npm run test:eval
npm run build
```

Expected: every command exits `0`; production audit contains no high/critical finding.

- [ ] **Step 2: Scan tracked files and browser assets for secrets**

```powershell
$tracked = git grep -Il -E 'sk-[A-Za-z0-9]{20,}' -- .
$built = Get-ChildItem -LiteralPath dist -Recurse -File | Select-String -Pattern 'sk-[A-Za-z0-9]{20,}' -List
if ($tracked -or $built) { $tracked; $built.Path; exit 1 }
```

Expected: exit `0`, no file paths, and no credential value printed.

- [ ] **Step 3: Review only the curated diff**

Run:

```powershell
git status --short --untracked-files=all
git diff --check
git diff --stat HEAD
git diff HEAD -- . ':(exclude)scripts/_poc_*' ':(exclude)scripts/_goodinfo_*' ':(exclude)scripts/_check_schema.ts'
```

Expected: no excluded artifact is staged or committed; unrelated user changes remain untouched.

- [ ] **Step 4: Record the actual verdict**

Report each command with timestamp, exit code, and summary in the execution handoff. Any unexecuted live check remains `未驗證`.

### Task 14: Publish Through GitHub with CI Gate

**Files:**
- Git metadata only; no source edits.

**Interfaces:**
- Consumes: clean curated commits and Task 13 evidence.
- Produces: pushed branch, pull request, green CI, and merged `main` only after review.

- [ ] **Step 1: Confirm branch, remote, authentication, and scope**

```powershell
git branch --show-current
git remote -v
gh auth status
git status --short
git log --oneline --decorate -12
```

Expected: remote is `yungtang20/twse-anytara`; only approved commits are present.

- [ ] **Step 2: Push the current `codex/` branch**

Run: `git push -u origin HEAD`

Expected: push exits `0`; no force push.

- [ ] **Step 3: Open a ready pull request against `main`**

Run:

```powershell
$taskBranch = git branch --show-current
$prBody = @"
## Summary
- add anonymous default HCNSEC AI with session-only visitor BYOK override
- preserve AI audit/publication gates and block shared-key disclosure to custom origins
- harden production runtime, maintenance scripts, and Supabase migration contracts

## Verification
- npm audit --omit=dev
- npm run typecheck
- npm run lint
- npm test
- npm run test:ui
- npm run test:eval
- npm run build

## Live gates
- Supabase additive migration verification
- existing Render twse-app cutover and smoke test
"@
gh pr create --base main --head $taskBranch --title "feat: prepare TRINITY for production" --body $prBody
```

Expected: a ready pull request whose body lists AI behavior, secret boundaries, Supabase scope, local checks, and remaining live checks.

- [ ] **Step 4: Wait for and inspect every CI check**

Run: `gh pr checks --watch`

Expected: all required checks pass. If a check fails, diagnose and repair in a new focused commit; do not merge red CI.

- [ ] **Step 5: Merge only after green CI**

Use a non-force merge method allowed by repository policy and verify `origin/main` contains the reviewed commit set.

### Task 15: Apply Approved Supabase Changes and Verify Read-Only State

**Files:**
- No new repository edits unless verification reveals a reviewed migration defect.

**Interfaces:**
- Consumes: merged migration files and production credentials already configured for this project.
- Produces: timestamped migration/advisor evidence; no data backfill or deletion.

- [ ] **Step 1: Identify the exact production project before mutation**

Compare configured project URL/ref with the approved project and list pending migration filenames. Stop if identity is ambiguous or a destructive statement appears.

- [ ] **Step 2: Snapshot schema metadata**

Capture migration history, RLS state, grants, constraints, function definitions, and advisors. Do not export or modify business rows.

- [ ] **Step 3: Apply only the reviewed additive migrations**

Use the Supabase migration mechanism with the exact merged files. Expected: no `DELETE`, `TRUNCATE`, `DROP`, sync, refetch, prune, or backfill execution.

- [ ] **Step 4: Run production read-only verification**

Run `npm run verify:supabase-security -- --production` with the configured credentials. Expected: required objects exist, RLS/grants/constraints match the contract, and advisors contain no new critical security finding.

- [ ] **Step 5: Record result without overclaiming data health**

Record schema evidence separately from market-data freshness. Data freshness stays `未驗證` unless directly checked by an authorized read-only probe.

### Task 16: Reconfigure Existing Render Service and Smoke Test

**Files:**
- Render service configuration only; no second service.

**Interfaces:**
- Consumes: merged GitHub `main`, verified Supabase schema, and deployment secret.
- Produces: existing `https://twse-app.onrender.com` running `yungtang20/twse-anytara`, plus rollback evidence.

- [ ] **Step 1: Snapshot current Render service**

Record service ID, repository, branch, runtime, build/start commands, health path, environment variable names without values, auto-deploy mode, and current deploy ID.

- [ ] **Step 2: Configure secrets and runtime**

Set the supplied default credential as `HCNSEC_API_KEY` using Render's secret mechanism. Configure `HCNSEC_BASE_URL=https://api.hcnsec.cn/v1`, `HCNSEC_MODEL=auto`, `HCNSEC_MAX_OUTPUT_TOKENS=65536`, cloud runtime, Supabase server variables, abuse limits, and production host values. Never print or read back secret values.

- [ ] **Step 3: Repoint the existing service**

Change only service `srv-d5aafsm3jp1c73ch03q0` from `yungtang20/twse-app` to `yungtang20/twse-anytara`, branch `main`, using the verified build/start/health settings. Preserve the existing service and URL.

- [ ] **Step 4: Deploy and inspect logs**

Wait for the deploy to finish. Expected: build succeeds, server binds to the Render port, health becomes healthy, and logs contain no key, request body, persistent SQLite initialization, or raw upstream response.

- [ ] **Step 5: Run production smoke tests**

Verify:

```text
GET /api/health -> 200
GET / -> 200 and application shell visible
browser module assets -> 200
market read API -> expected sanitized success or documented unavailable status
AI with blank Base URL/key plus privacy acknowledgement -> audited response
AI with visitor key/Base URL -> audited response
custom Base URL without visitor key -> 400 custom_key_required
admin settings without token -> remains rejected
```

Inspect browser storage/network to confirm the shared key is absent.

- [ ] **Step 6: Accept or roll back**

If every smoke check passes, restore controlled auto-deploy and record the deploy ID. If a decisive runtime check fails, restore the snapshotted repository/configuration or redeploy the previous known-good deploy; do not perform a destructive database rollback.

# Dashboard Default Home Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the dashboard render for the bare application URL and unsupported hash routes while preserving every explicit supported route.

**Architecture:** Keep `src/lib/navigation.ts` as the single owner of fallback route selection. Change only its default constant and the existing parser assertions; `App.tsx` and both navigation controls continue using the current interface unchanged.

**Tech Stack:** TypeScript 5.8, React 19, Node.js 24, `tsx` self-checks, Vite 6, GitHub Actions, Render Docker deployment.

## Global Constraints

- Do not add or upgrade dependencies.
- Do not change `AppView`, `App.tsx`, `Sidebar`, `BottomNav`, AI research, Supabase, provider configuration, or deployment configuration.
- Do not add the cancelled anti-gambling analysis feature or any related source code.
- Preserve explicit supported routes, including `#/markets`, `#/strategies`, `#/ai-analysis`, and `#/settings`.
- Do not stage or commit existing unrelated working-tree files.
- An unexecuted check is `unverified`, never `passed` or `failed`.

---

## File Structure

- Modify `tests/self-check.ts`: encode the new empty-hash and unsupported-hash fallback behavior while retaining explicit-route checks.
- Modify `src/lib/navigation.ts`: change the single default application view constant.
- No files are created by the implementation.

### Task 1: Change the default route with a failing test first

**Files:**
- Modify: `tests/self-check.ts:418-421`
- Modify: `src/lib/navigation.ts:3`
- Test: `tests/self-check.ts`

**Interfaces:**
- Consumes: `parseAppView(hash: string): AppView` and `appViewHash(view: AppView): string` from `src/lib/navigation.ts`.
- Produces: `DEFAULT_APP_VIEW: AppView` with value `"dashboard"`; empty or unsupported hashes return `"dashboard"`.

- [ ] **Step 1: Update the fallback assertions before changing production code**

Replace the navigation assertions with:

```ts
assert.equal(parseAppView(""), "dashboard");
assert.equal(parseAppView("#/dashboard"), "dashboard");
assert.equal(parseAppView("#/markets"), "markets");
assert.equal(parseAppView("#/strategies"), "strategies");
assert.equal(parseAppView("#/ai-analysis"), "ai-analysis");
assert.equal(parseAppView("#/settings"), "settings");
assert.equal(parseAppView("#/unknown"), "dashboard");
assert.equal(appViewHash("markets"), "#/markets");
```

- [ ] **Step 2: Run the self-check and verify the new assertion fails**

Run:

```powershell
npx tsx tests/self-check.ts
```

Expected: non-zero exit at the first fallback assertion because the current implementation returns `"markets"` instead of `"dashboard"`.

- [ ] **Step 3: Make the minimal production change**

Change `src/lib/navigation.ts` to:

```ts
export const DEFAULT_APP_VIEW: AppView = "dashboard";
```

Do not add startup redirects or special cases in `App.tsx`.

- [ ] **Step 4: Re-run the focused self-check**

Run:

```powershell
npx tsx tests/self-check.ts
```

Expected: exit code `0` and the existing self-check completion message.

- [ ] **Step 5: Run canonical local verification**

Run each command independently and record its actual exit code:

```powershell
npm run typecheck
npm test
npm run test:eval
npm run build
```

Expected: every executed command exits `0`. If any command does not exit `0`, stop publication and report the actual result without weakening tests.

- [ ] **Step 6: Review the exact implementation diff**

Run:

```powershell
git diff --check -- src/lib/navigation.ts tests/self-check.ts
git diff -- src/lib/navigation.ts tests/self-check.ts
git status --short
```

Expected: the implementation diff contains only the default constant and navigation assertions. Existing unrelated changes remain unstaged.

- [ ] **Step 7: Commit only the implementation files**

Run:

```powershell
git add -- src/lib/navigation.ts tests/self-check.ts
git diff --cached --check
git diff --cached --name-only
git commit -m "fix: open dashboard by default"
```

Expected staged names before commit:

```text
src/lib/navigation.ts
tests/self-check.ts
```

### Task 2: Publish and verify the deployed behavior

**Files:**
- No source files modified.
- Verify: GitHub pull request checks and `https://twse-app.onrender.com/`.

**Interfaces:**
- Consumes: the committed route change from Task 1 and the existing Render service `twse-app`.
- Produces: a merged GitHub change and a deployed root URL that visibly renders the dashboard.

- [ ] **Step 1: Reconfirm publication scope before external writes**

Run:

```powershell
git status --short
git log -3 --oneline
git diff origin/main...HEAD -- src/lib/navigation.ts tests/self-check.ts docs/superpowers/specs/2026-08-16-dashboard-default-home-design.md docs/superpowers/plans/2026-08-16-dashboard-default-home.md
```

Expected: only the approved design, plan, and two implementation files belong to this feature. Obtain any still-required push or deployment approval before continuing.

- [ ] **Step 2: Push the current feature branch and open a pull request**

Run after publication approval:

```powershell
git push -u origin codex/supabase-sync-hardening
gh pr create --repo yungtang20/twse-anytara --base main --head codex/supabase-sync-hardening --title "Open dashboard by default" --body "Changes the empty and unsupported hash fallback to the dashboard, preserves explicit routes, and updates navigation checks."
```

Expected: both commands succeed and GitHub returns the pull-request URL.

- [ ] **Step 3: Require green GitHub checks before merge**

Resolve the pull-request number from the feature branch, then run:

```powershell
$dashboardPr = gh pr view codex/supabase-sync-hardening --repo yungtang20/twse-anytara --json number --jq '.number'
gh pr checks $dashboardPr --repo yungtang20/twse-anytara --watch
gh pr merge $dashboardPr --repo yungtang20/twse-anytara --merge --delete-branch=false
```

Expected: required checks complete successfully before the merge command is issued. Do not merge if checks are pending, failing, or unavailable.

- [ ] **Step 4: Deploy the merged `main` commit to Render**

Because `render.yaml` sets `autoDeploy: false`, trigger a manual deployment of the existing `twse-app` service through the connected Render account. Record the deployed commit and wait until the deployment reports a successful live state.

- [ ] **Step 5: Verify the bare URL and explicit market route in the browser**

Open and inspect both URLs after deployment:

```text
https://twse-app.onrender.com/
https://twse-app.onrender.com/#/markets
```

Expected:

- The bare URL visibly shows dashboard content and the dashboard navigation item is current.
- `#/markets` visibly shows `AI 精準個股終端` and the market-analysis navigation item is current.
- No AI provider request or Supabase mutation is needed for either navigation check.

- [ ] **Step 6: Report final evidence**

Report the implementation commit, pull-request URL, merged commit, Render deployment status, and both browser observations. Mark any check not actually executed as `未驗證`.

# Dashboard Default Home Design

Date: 2026-08-16  
Status: Approved for implementation planning

## Objective

Make the dashboard the default landing view when the application URL has no hash route or contains an unsupported hash route.

## Scope

- Change the shared default application view from `markets` to `dashboard`.
- Preserve every explicit supported hash route, including `#/markets`, `#/strategies`, `#/ai-analysis`, and `#/settings`.
- Update the navigation parser assertions that cover empty and unsupported hash routes.
- Keep the existing dashboard, market analysis, AI research, Supabase, and provider behavior unchanged.

The cancelled anti-gambling analysis proposal is explicitly outside this design.

## Considered Approaches

1. **Change the central default view constant — selected.** Both empty and unsupported hash routes resolve consistently through the existing parser, with one source of truth.
2. Redirect the browser to `#/dashboard` during startup. This makes the route visible but introduces an unnecessary history and URL mutation for a default-rendering change.
3. Special-case an empty hash in `App.tsx`. This would split fallback behavior between the application shell and navigation parser and make unsupported routes behave differently.

The first approach is the smallest change and preserves the current navigation interface.

## Behavior

| Input URL state | Result |
| --- | --- |
| No hash | Dashboard |
| `#/dashboard` | Dashboard |
| Unsupported hash | Dashboard |
| `#/markets` | Market analysis |
| Other supported hashes | Their existing views |

The application does not need to rewrite an empty or unsupported hash to `#/dashboard`; it only renders the dashboard as the fallback view.

## Implementation

`src/lib/navigation.ts` remains the single owner of default-route selection. `App.tsx`, `Sidebar`, and `BottomNav` continue consuming the existing `AppView` and navigation helpers without new conditions.

No new module, dependency, route, database operation, API request, or deployment setting is required.

## Error Handling

An unsupported or malformed hash continues to fail safely through `parseAppView`. The only behavior change is that its fallback becomes `dashboard` instead of `markets`.

## Verification

- Update the existing self-check assertions so empty and unsupported hashes resolve to `dashboard`.
- Retain assertions for every supported explicit route.
- Run the focused navigation self-check first.
- Run the canonical type check, test suite, and production build before publication.
- After deployment, open the bare Render URL and verify dashboard content is visible; also open `#/markets` and verify market analysis still renders.

## Publication Boundary

Only the navigation default and its directly related tests belong in the implementation change. Existing unrelated working-tree files must not be staged or committed.

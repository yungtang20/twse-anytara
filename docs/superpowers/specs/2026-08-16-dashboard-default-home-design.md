# Dashboard and AI Report Presentation Design

Date: 2026-08-16
Status: Approved design; pending written specification review

## Objective

Make the dashboard the default landing view and present the AI research report as a clear, trustworthy Chinese-language product surface without weakening the existing server-side research, audit, or publication guarantees.

## Scope

- Change the shared default application view from `markets` to `dashboard`.
- Change the browser title from the template title to `TRINITY 台股決策研究平台`.
- Translate presentation-only AI report labels and internal enum values into user-facing Chinese.
- Improve the provider, model, and processing-time layout so long values wrap without crowding.
- Clarify model confidence as an unverified model self-assessment rather than a measured accuracy score.
- Distinguish an empty risk-finding list from missing data.
- Give strategy signal findings a specific human-readable field label instead of the raw `signal` field name.
- Preserve technical provenance in an optional detail view rather than making identifiers the primary report content.
- Add regression coverage for all changed behavior.

The cancelled anti-gambling integration is explicitly outside this design. Supabase schema, data, migrations, RLS, provider configuration, AI request limits, and production synchronization are also outside scope.

## Confirmed Root Causes

1. The default route is centrally owned by `DEFAULT_APP_VIEW`, which currently resolves empty and unsupported hashes to `markets`.
2. The browser title is an unchanged template literal in `index.html`.
3. `AIResearchView` renders contract enums, evidence identifiers, provider fields, and grounding states directly. The backend is not missing translations; the display layer has no presentation adapter.
4. Provider, model, and duration share one inline row without a wrapping layout.
5. `model-estimate-unverified` is an intentional publication guarantee: report facts are server-grounded and calculations are server-calculated, while model confidence is not externally calibrated. Removing that warning would be incorrect.
6. An empty `riskFindingIds` list is valid when no trade-risk finding or data limitation was selected. The generic empty-list text `無資料` incorrectly implies missing source data.
7. Strategy findings are rendered by the controlled server finding policy. Its generic field-label fallback turns a strategy evidence path into the awkward text `signal為 BUY/SELL`.

## Considered Approaches

### 1. Presentation adapter plus controlled renderer wording — selected

Keep shared API contracts, the AI auditor, and the publication gate unchanged. Add explicit display mappings in the frontend for labels and enums, improve layout, and add a narrow server renderer label for strategy signals.

This approach fixes the user experience at the correct boundaries, preserves traceability, and avoids broad contract migration.

### 2. Add localized presentation fields to the API

The server could return a fully localized view model, including a separate trade-risk summary. This may help future non-web clients, but it expands the shared contract and requires more migration and compatibility work than the current problem justifies.

### 3. Hide technical provenance

Removing evidence identifiers and grounding information would be visually simple, but it would make a formal investment-research report harder to audit. This approach is rejected.

## Navigation Behavior

| Input URL state | Result |
| --- | --- |
| No hash | Dashboard |
| `#/dashboard` | Dashboard |
| Unsupported hash | Dashboard |
| `#/markets` | Market analysis |
| Other supported hashes | Their existing views |

The application does not rewrite an empty or unsupported hash. `src/lib/navigation.ts` remains the single owner of fallback selection, and existing explicit routes remain unchanged.

## Product Title

The document title becomes `TRINITY 台股決策研究平台`. No visible navigation branding or metadata outside the document title changes unless required by an existing title test.

## AI Report Presentation

### User-facing labels

`AIResearchView` will use an explicit presentation mapping rather than rendering contract values directly. The primary UI uses Chinese labels such as:

- `Data quality` -> `資料完整度`
- `Provider / Model` -> `AI 服務資訊`
- `Citations / 來源識別` -> `資料來源與佐證`
- `server-grounded` -> `事實已由伺服器資料驗證`
- `server-calculated` -> `數值由伺服器計算`
- claim kinds and stances -> stable Chinese labels

Unknown future values must use a safe neutral fallback and must not crash report rendering. Internal values remain unchanged in the transport contract.

### Provider row

Provider and model information occupy a flexible, wrapping area. Processing time is displayed separately with a no-wrap label when present and a clear unknown-state label when absent. Long provider or model names must not overlap or force horizontal page overflow.

### Confidence wording

Published reports display confidence in this form:

`模型自評信心 65%（未經外部驗證，不代表歷史準確率）`

The exact percentage remains report data. The UI must preserve the unverified status and must not present confidence as server-grounded, backtested, calibrated, or guaranteed.

### Risks and data limitations

The section label becomes `風險與資料限制`.

- When referenced findings exist, render their user-facing report text.
- When the list is empty, render `本次未列入需關注的主要風險或資料限制`.

The empty state must not say `無資料`, because it does not prove that source data is absent. It must also not claim that all investment risk is absent.

### Strategy signal wording

The controlled server finding renderer maps `strategies.<strategy>.signal` to a strategy-specific Chinese field label, for example `撐壓策略訊號`. A rendered claim may retain the canonical signal value, such as `SELL`, but must not expose the bare phrase `signal為`.

This remains deterministic server-authored factual text. The model still selects only allowed finding identifiers and gains no new free-text authority.

### Provenance

Human-readable source names and verification descriptions are shown first. Raw finding IDs, evidence IDs, datasets, provider enums, and as-of fields remain available in an expandable technical-details area for auditing and support. The disclosure uses native `details`/`summary` elements or an equivalent keyboard-operable accessible control.

No evidence is deleted from the response, and no source is represented as verified beyond its existing grounding state.

## Security and Publication Boundaries

- Do not change `PublishedResearchRecommendation.confidenceGrounding`.
- Do not weaken the AI report auditor, selection contract, finding policy allowlist, or publication gate.
- Do not let the model author factual report text or technical evidence identifiers.
- Do not expose new credentials or server-only configuration to browser code.
- Do not modify Supabase or production data.

## Testing

Implementation must add or update tests that prove:

- empty and unsupported hashes resolve to `dashboard`;
- all explicit supported routes remain unchanged;
- the document title is the approved TRINITY title and no longer contains the template title;
- raw primary labels such as `Data quality`, `Provider / Model`, and `server-grounded` are not shown as the main UI;
- technical provenance remains reachable with keyboard navigation;
- a published report explains model confidence as self-assessed and unverified;
- an empty risk-finding list does not render `無資料`;
- populated risk or limitation findings remain visible;
- long model names and missing duration values render usable labels and layout classes;
- strategy claims do not contain the bare phrase `signal為`;
- a valid published SELL report with verified no canonical trade-risk and an empty risk list remains publishable;
- existing non-`none` trade-risk publication requirements remain enforced.

Run focused tests first, followed by the canonical type check, complete test suite, AI evaluation suite, and production build.

## Deployment Acceptance

After reviewed changes are merged and Render deploys the selected commit:

1. Open the bare Render URL and verify the dashboard is visible.
2. Open `#/markets` and verify explicit market navigation still works.
3. Open `#/ai-analysis`, generate or load a report, and verify the revised labels, layout, confidence warning, risk empty state, strategy wording, and provenance details.
4. Confirm the deployed asset and health endpoints succeed and the browser console has no application error.

A successful local build, GitHub push, merge, or Render build alone does not constitute live acceptance.

## Publication Boundary

Only the navigation default, document title, AI report presentation, controlled strategy-field wording, and their directly related tests belong in the implementation. Existing unrelated working-tree files must not be staged or committed.

# Feature: opencode-live-catalog

Branch: `feat/opencode-live-catalog` (from `dev` @ `fd010aa`)
Engram mirror: `odd/opencode-live-catalog/tasks` (project `agent-hub`)

## Objective

Make agent-hub detect opencode models, especially free ones, from the live
opencode v2.0.18 catalog instead of a hand-written registry, and validate
reasoning variants against that catalog. This implements the open T11/T12
items of `odd/tasks/opencode-v2-migration.md`.

## Problem / why

Verified live on 2026-09-26 against opencode v2.0.18:

- Free detection is only `tier: 'free'` in `MODEL_REGISTRY.opencode`
  (`src/config.mjs`). It has drifted: `opencode/mimo-v2.5-free` no longer exists
  (the catalog now has `opencode/mimo-v2.6-flash-free`), and live free models
  such as `space-bunny-free`, `longcat-2.5-preview-free` and
  `ling-3.0-flash-fin-free` are not recognized. `opencode/big-pickle` is free
  but has no `-free` suffix, so cost is the only reliable signal.
- `discovery.json` already stores each model's `cost` (array of
  `{input, output, cache}`) and `variants` (array of `{id, settings}`) from
  `opencode api model.list`, but nothing consumes them.
- `resolveVariant` (`src/config.mjs`) never checks a requested variant against
  the model's catalog `variants[]`. Job `2cf805fa` failed with
  `provider.no-route: Variant unavailable for opencode/nemotron-3-ultra-free: high`.
- `src/discovery.mjs` reports an empty exit-0 model list (cold background
  service) as "model list timed out".
- `classifyError` in `src/adapters/opencode.mjs` collapses `provider.no-route`
  and transport errors (`socket connection was closed`) into a generic
  non-retriable `crash`.
- `TESTED_VERSIONS.opencode` is `2.0.10`; installed is `2.0.18`.

Out of scope (reported to the user, not acted on): the opencode startup
warnings come from user plugins (engram, rtk, skill-registry, ...) that are
incompatible with the opencode v2 plugin API. They are not agent-hub code.

## Scope

- Derive the opencode pricing tier (`free` / `paid`) from catalog `cost`,
  with the registry as fallback when the catalog is unavailable.
- Report drift between the catalog and `MODEL_REGISTRY` / `DELEGATION_MAP`
  (pinned id vanished, registry says free but catalog cost > 0, new free
  catalog model not in the registry). Report only.
- Surface the derived tier and drift in `agents_status` and the dashboard.
- Validate variants against catalog `variants[]` before spawning.
- Fix the empty-list error label, classify the two observed error kinds, and
  bump the tested version.

## Constraints

- Never auto-insert or auto-promote a model in `DELEGATION_MAP`. Routing
  changes stay in the human-reviewed proposal flow (`model-autodiscover`).
- Do not select models by predicate in the router (keeps jobs reproducible).
- `dataPolicy` and `strengths` stay hand-written.
- Strict TDD: RED before implementation, then GREEN, then REFACTOR.
- Planning heuristic ~400 authored changed lines per task (advisory only).

## TDD

- Mode: enabled (source: session configuration, "Strict TDD Mode: enabled").
- Runner: `npm test` (`node --test` over `test/**/*.test.mjs`, excluding
  `test/live`); dashboard: `npm run -w dashboard test` and
  `npm run -w dashboard typecheck`.

## Delivery

- Forecast: ~350-450 authored changed lines across 4 tasks.
- Strategy: `ask-on-risk` (default). Ask for a chain strategy only if the
  running count clearly exceeds ~400 lines.

## Tasks

- [x] T1 — Live pricing tier + drift for opencode. Pure helpers (e.g.
  `catalogTier(model)` from `cost`, `effectiveTier(agent, modelId, discovery)`
  with registry fallback, `computeCatalogDrift(...)`), exposed in the
  `agents_status` output (`tier`, `tierSource`) and in the model-gaps /
  discovery data the dashboard reads. Route: delegated writer (2+ non-trivial
  files).
  - New `src/catalog.mjs`: `catalogTier(entry)`, `effectiveTier({agent,
    model, discovery, registry})` -> `{tier, tierSource}`,
    `computeCatalogDrift({discovery, map, registry, agent='opencode'})` ->
    `[{type: 'vanished'|'now_paid'|'new_free'|'variant_unavailable', agent,
    model, variant?}]`. Drift only computed when the agent's discovery row is
    fresh (`PREFLIGHT_TTL_MS`) and has no `error`.
    **Superseded by the T1 correction below** — see there for the actual
    freshness rule shipped.
  - Wired `tier`/`tierSource` into `agentsStatusTool` (`src/tools/agents.mjs`)
    and `buildState()` (`src/dashboard.mjs`, the `/api/state` agents array).
    Wired `drift` into `GET /api/proposals` and `POST /api/proposals/refresh`
    (`src/dashboard.mjs`), alongside the existing `unmapped` field from
    `computeModelGaps`.
  - Schema (`src/schemas.mjs`): added `tier`/`tierSource` to
    `AgentStatusRow`; added `CatalogDriftItem` and a `drift` field on
    `ProposalsResponse`.
  - TDD: RED observed for `test/catalog.test.mjs`
    (`ERR_MODULE_NOT_FOUND src/catalog.mjs`); GREEN
    `node --test test/catalog.test.mjs` 18/18. RED observed for the 4
    integration tests (agentsStatusTool x2, buildState x1, dashboard-api-v2
    x1) by stashing the `src/dashboard.mjs`/`src/tools/agents.mjs` wiring and
    re-running — `not ok` on exactly those 4; GREEN after popping the stash:
    `node --test test/tools-agents.test.mjs test/dashboard.test.mjs
    test/dashboard-api-v2.test.mjs test/catalog.test.mjs` 106/106. Full
    `npm test`: 1548/1548 (baseline 1526 + 22 new).
  - Route: delegated writer (touched `src/catalog.mjs`, `src/schemas.mjs`,
    `src/tools/agents.mjs`, `src/dashboard.mjs` — 4+ files). Commit `7357ae3`.

  **T1 correction (real defect found by parent review of commit `7357ae3`):**
  `isFreshRow` gated `effectiveTier`/`computeCatalogDrift` on
  `PREFLIGHT_TTL_MS` (15 minutes). `discovery.json` is only refreshed at MCP
  startup (`src/startup.mjs`) and by the dashboard's explicit "Rediscover
  CLIs" action (`src/dashboard.mjs`, `force: true`) — never on a fixed
  interval — so after 15 minutes the live tier/drift silently and
  permanently fell back to the registry, defeating the feature almost all of
  the time. Confirmed live: at 22:04Z against a discovery row checked at
  21:31Z (33 minutes old, `error: null`, 99 models),
  `effectiveTier('opencode', 'opencode/space-bunny-free', ...)` incorrectly
  returned `{tier: null, tierSource: 'registry'}` and `computeCatalogDrift`
  incorrectly returned `[]`.
  - Verified `runDiscovery` (`src/discovery.mjs`) does **NOT** overwrite a
    previously good row with an errored/empty one on its own — it only
    re-probes an agent when `force` is true or the existing row is not
    fresh, and even then `discoverCli` itself returns `error: null` only on
    an actual successful `models-list` call. **However**, once it DOES
    re-probe (after 15 minutes, or on an explicit refresh), the merge in
    `runDiscovery` (`merged[agent] = outcome.value.entry`) unconditionally
    replaces the existing row with whatever the new probe returned, with no
    "keep the last good row if this probe failed" guard. A transient
    `discoverCli` failure (e.g. one 60s models-list timeout) *would*
    overwrite a previously-good row with an errored one at that point. This
    is a pre-existing, separate gap in `discovery.mjs`'s merge policy, not
    something introduced by `src/catalog.mjs` — reported here per
    instruction rather than fixed, since fixing it is out of this
    correction's scope (it touches `discoverCli`/`runDiscovery` merge
    semantics used by every consumer of `discovery.json`, not just tier/
    drift).
  - Fix: replaced the TTL-based `isFreshRow` with `isGoodCatalogRow(entry)` =
    `!entry.error && Array.isArray(entry.models) && entry.models.length > 0`
    — no age bound. `effectiveTier`/`computeCatalogDrift` now use the last
    successful catalog fetch regardless of its age; only "never fetched
    successfully" (error, or empty `models`) falls back to the registry /
    reports no drift. No new max-age bound was added — none of the evidence
    gathered here shows discovery.json ever going meaningfully stale in a
    way a bound would catch (it's either a fresh startup/refresh row, or an
    hours/days-old one that is still the best evidence available); not
    flagging this as an open decision gap since no concrete need for one was
    found.
  - Added `catalogCheckedAt` (the source discovery row's `checkedAt`, `null`
    when `tierSource` is `'registry'`) next to `tierSource`: in
    `effectiveTier`'s return shape, `agentsStatusTool`, `buildState()`'s
    `/api/state` agents array, and `AgentStatusRow` (`src/schemas.mjs`).
    Added `checkedAt` to every `computeCatalogDrift` item and to
    `CatalogDriftItem` (`src/schemas.mjs`). The dashboard's Tier badge title
    (`dashboard/src/views/agents/index.tsx`) now reads
    `"source: catalog · checked <age>"` (via the existing `formatAge`
    helper) instead of just `"source: catalog"`, so an hours-old catalog
    reading is visibly not a live one.
  - TDD: RED observed in `test/catalog.test.mjs` — a new test with
    `checkedAt` 2 hours old (`OLD`) and good catalog data asserted catalog
    tier/drift and failed against the pre-fix code (9 of 20 tests failed:
    the new/updated `catalogCheckedAt`-asserting tests, the old-row tests,
    and one that exposed a second latent bug — a fresh-but-`error:null`-and-
    `models:[]` row was NOT gated by the old code and incorrectly produced a
    `'vanished'` drift item; `isGoodCatalogRow`'s `models.length > 0` check
    fixes that too). GREEN: `node --test test/catalog.test.mjs` 20/20. RED
    observed in `dashboard/src/views/agents/agents.test.tsx` (new test
    asserting the badge title matches `/checked.*ago/`, failed with
    `"source: catalog"` before the UI change). GREEN after the UI fix:
    `npx vitest run src/views/agents/agents.test.tsx
    src/views/approvals/index.test.tsx` 17/17. Full `npm test`: 1550/1550
    (was 1548; +2 net from the two extra catalog.test.mjs cases). Full
    `npm run -w dashboard test`: 201/201 (unchanged count; one test
    strengthened). `npm run -w dashboard typecheck`: clean. `npm run build`:
    succeeded. `grep -rn '<style\|style="\|data:font' dashboard/dist`:
    nothing (CSP-safe).
  - Route: delegated writer (touched `src/catalog.mjs`, `src/schemas.mjs`,
    `src/tools/agents.mjs`, `src/dashboard.mjs`,
    `dashboard/src/views/agents/index.tsx` — 5 files). Commit `0f456c2`.

- [x] T2 — Dashboard: show the free/paid badge for opencode catalog models and
  list drift items. Route: delegated writer.
  - `dashboard/src/views/agents/index.tsx`: new "Tier" column, a `Badge`
    (`variant="outline"`, `title="source: catalog|registry"`) reading
    `row.tier`/`row.tierSource`; `tier === 'free'` gets the existing
    `TONE_BADGE_CLASS.ready` tone (no new colors/styles, CSP-safe).
  - `dashboard/src/views/approvals/proposals-panel.tsx`: new `DriftCard`
    (same shape as the existing `UnmappedModelsCard`) rendering
    `data.drift` with a per-item type badge and a human-readable summary
    per drift `type`.
  - `dashboard/src/lib/types.ts`: exported `CatalogDriftItemT` from the
    shared `CatalogDriftItem` zod schema (no hand-rolled type).
  - TDD: RED observed — `npx vitest run src/views/agents/agents.test.tsx
    src/views/approvals/index.test.tsx` before the UI changes: 3 failed
    (`renders a free tier badge...`, `renders a paid tier badge...`,
    `lists catalog drift items reported for opencode`), 14 passed. GREEN
    after implementing: same command 17/17. Full `npm run -w dashboard
    test` 201/201; `npm run -w dashboard typecheck` clean; `npm run build`
    succeeded; `grep -rn '<style\|style="\|data:font' dashboard/dist`
    printed nothing (CSP-safe). Full `npm test` 1548/1548 (unchanged, T2 is
    dashboard-only).
  - Route: delegated writer (5 dashboard files). Commit `931cd70`.
- [ ] T2 — Dashboard: show the free/paid badge for opencode catalog models and
  list drift items. Route: delegated writer.
- [ ] T3 — Variant validation: when the fresh catalog knows the model, an
  unsupported variant is dropped before spawning (the job runs at the model
  default) and the job records a warning; unknown catalog keeps current
  behavior. Route: delegated writer.
- [ ] T4 — Hygiene: empty model list labelled distinctly from a timeout;
  `classifyError` gets retriable `transport` and non-retriable
  `invalid_variant`/`no_route` kinds; `TESTED_VERSIONS.opencode` bumped to
  `2.0.18`. Route: delegated writer.

## Acceptance criteria

- With the live catalog, every opencode model with zero input and output cost
  reports `tier: 'free'`, including `opencode/big-pickle`.
- A registry id missing from the catalog shows up as drift, not as free.
- A job requesting `variant: 'high'` on a model without that variant runs
  without `provider.no-route` and carries a warning.
- `npm test`, dashboard tests and typecheck pass.

## Progress

- Branch created.
- T1 done. Commit `7357ae3`. Authored changed lines: 450 (src 425+/-25 test
  included; see T1 entry above for the per-file breakdown).
- T2 done. Commit `931cd70`. Authored changed
  lines: dashboard 123 insertions / 1 deletion (`dashboard/src/lib/types.ts`
  +2, `dashboard/src/views/agents/agents.test.tsx` +38,
  `dashboard/src/views/agents/index.tsx` +17,
  `dashboard/src/views/approvals/index.test.tsx` +17,
  `dashboard/src/views/approvals/proposals-panel.tsx` +49/-1).
- T1 correction done (real defect the parent found via live evidence against
  commit `7357ae3`: TTL-gated tier/drift, inert almost all the time —
  fixed to use the last good catalog regardless of age; see the T1 entry
  above for full detail). Commit `0f456c2`. Authored changed
  lines: 176 (additions 120 / deletions 56) across `src/catalog.mjs`
  (+44/-26), `src/schemas.mjs` (+12/-5), `src/tools/agents.mjs` (+6/-4),
  `src/dashboard.mjs` (+2/-1), `test/catalog.test.mjs` (+38/-17),
  `dashboard/src/views/agents/index.tsx` (+11/-2),
  `dashboard/src/views/agents/agents.test.tsx` (+7/-1). Also reported (not
  fixed, out of this correction's scope): `runDiscovery`
  (`src/discovery.mjs`) unconditionally overwrites a row with whatever a
  re-probe returns, with no "keep the last good row on a failed re-probe"
  guard — a transient `discoverCli` failure after the (now irrelevant to
  catalog.mjs, but still real for CLI-readiness callers) 15-minute TTL could
  still replace a good catalog row with an errored one.
- **Running authored-changed-lines total: 450 (T1) + 124 (T2) + 176
  (correction) ≈ 750** (git diff --numstat, excluding lockfiles and
  dashboard/dist). Per the coordinator's explicit instruction, implementation
  **stops here again** after this scoped correction — T3 (variant validation
  before spawn) and T4 (hygiene: empty-list label, classifyError kinds,
  TESTED_VERSIONS bump) are NOT started.
- Decision needed from the user/orchestrator before continuing: which chain
  strategy to use for the remaining T3+T4 work (and this correction) —
  `stacked-to-main` (each PR merges to main in order) or
  `feature-branch-chain` (PRs stack on the feature branch, only the tracker
  merges to main) — per the feature document's `ask-on-risk` delivery
  strategy. This writer does not choose a chain strategy on the user's
  behalf.
- Next: T3 (variant validation before spawn), then T4 (hygiene), once a
  chain strategy is chosen and the coordinator authorizes continuing.

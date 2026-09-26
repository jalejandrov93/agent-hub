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
    `src/tools/agents.mjs`, `src/dashboard.mjs` — 4+ files). Commit hash
    recorded in T2's commit (this commit's own hash isn't known until after
    it's made, and amending is not allowed).
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
- T1 done (see above). Running authored-changed-lines count (git diff
  --numstat, excluding lockfiles and dashboard/dist): src 425 insertions / 25
  deletions across `src/catalog.mjs` (new, 113), `src/schemas.mjs` (+24/-1),
  `src/tools/agents.mjs` (+25/-16), `src/dashboard.mjs` (+16/-8); tests
  `test/catalog.test.mjs` (new, 145), `test/tools-agents.test.mjs` (+45),
  `test/dashboard.test.mjs` (+26), `test/dashboard-api-v2.test.mjs` (+31).
  Total ≈ 450 authored changed lines. This already consumes most of the
  ~350-450 line forecast for the whole feature in T1 alone (T1 needed a real
  new module + schema + two call sites + proportionate tests). Continuing to
  T2 per the ~500-line stop threshold; will reassess after T2 and flag a
  chain-strategy decision to the user if the running count clearly exceeds
  ~500.
- Next: T2 (dashboard free/paid badge + drift list).

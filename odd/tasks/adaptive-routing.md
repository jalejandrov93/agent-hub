# ODD Feature: D2 — Adaptive Routing (capabilities + preferences + explainable scoring)

> Numbering note: this is the phase the earlier roadmap called **D2 Adaptive
> Routing**. The newer post-D1 plan renumbers it as **D3**, with provider
> profiles as its D2. This branch implements the routing phase (routing is what
> D1's quality/cost/latency signals were built for).

## Objective

Move `route()` from "taskType → fixed DELEGATION_MAP order" toward
"requirements → capabilities → quality history → latency → cost → policy →
candidate", **without a black box**: every ordering decision comes with the
per-dimension reasons that produced it, and persistent chain changes stay
human-gated through the existing proposals.

## Problem

`route()` returns the delegation-map chain filtered by availability/breaker and
reordered only by an accepted Wilson proposal. With D1 there is now
`qualityScore`, `costUsdAvg` and `p95Ms` per pair, but nothing consumes them,
and there is no way to express a requirement such as "this must run somewhere
with session resume" or "prefer cheap over fast".

## Current state (verified in the repo)

- `DELEGATION_MAP` order + `evaluateCandidate` (preflight/breaker/hold) +
  accepted proposals (`src/router.mjs`, `src/proposals.mjs`).
- No capabilities concept exists anywhere (`grep capabilities: none`).
- Adapter-verified resume signals: `agy --conversation`, `opencode -s`,
  `codex exec resume`; `copilot` documents **no** resume.
- `MODEL_REGISTRY[agent][model].strengths` already encodes `1M ctx` for the
  large-context models.

## Scope

In scope:
- `src/capabilities.mjs`: a capability resolver with keys
  `read | write | git | github | web | sessionResume | largeContext`, derived
  ONLY from signals that already exist (adapter argv support, the delegation
  map's `github-context` pair, `MODEL_REGISTRY.strengths`). `web` is a reserved
  key that is `false` everywhere today and is documented as such.
- `src/routing/score.mjs`: pure, explainable scoring. Hard capability filter,
  then a preference-weighted score over quality / latency / cost, each with a
  reason entry; missing dimensions are neutral, never invented.
- `src/router.mjs` `route()`: additive `requirements`, `preferences` and
  `adaptive` options; always returns a `ranking` with per-candidate reasons;
  `adaptive: true` reorders `primary`/`fallbacks` from it. Default (`false`)
  keeps today's behaviour byte-for-byte.
- Tests + docs.

Out of scope (explicit follow-ups):
- Replacing the human-gated proposal flow with automatic reordering — the
  existing `pending → accepted` gate stays authoritative for the base chain.
- Provider profiles / multi-account identity (the post-D1 plan's D2).
- Any model that is not already a router candidate.

## Design rules

- Hard filter first: a candidate missing a required capability is ineligible and
  appears in `skipped` with `missing_capabilities:<list>`.
- Scoring is a weighted sum of normalized components in `[0,1]`; weights come
  from `preferences` (defaults `quality .5 / cost .2 / latency .3`).
- Quality component: `qualityScore/10`, else `verifiedRate`, else `successRate`,
  else no data.
- Latency/cost components are normalized **within the eligible set** (lower is
  better) so no arbitrary currency/millisecond cap is invented.
- A component with no data is dropped and its weight redistributed; the reason
  says `no data`.
- With no history at all, every score is 0 and the ranking is the stable chain
  order — degradation to today's behaviour.

## Constraints

- Additive and backward compatible: no change to `route()`'s return shape that
  a current caller can break; new keys only.
- Deterministic sort with a stable tiebreak on the chain index.
- Strict TDD: failing test first, observed RED, then GREEN.

## Resolved TDD

- Mode: `on`. Runner: `node --test <file>` (repo script `npm test`).

## Delegation route

- T1/T2: delegated writer (`agy`, `gemini-3.8-flash-high`, `mode: write`) in
  `/home/alejandro/Desarrollo/agent-hub-worktrees/d2-routing` (off `dev`).
  Tolerant of D1 fields being absent (they are optional), so the branch merges
  independently and activates when D1 lands. No Claude.

## Tasks

| ID | Task | Route | Evidence |
|----|------|-------|----------|
| T1 | `src/capabilities.mjs` + `src/routing/score.mjs` + tests | delegated writer | RED then GREEN |
| T2 | `route()` integration (`requirements`/`preferences`/`adaptive`/`ranking`) + tests | delegated writer | RED then GREEN |
| T3 | README + CHANGELOG | inline | diff read-back |

## Acceptance criteria

- `capabilitiesFor('agy', 'gemini-3.8-flash-high')` reports
  `sessionResume: true, largeContext: true`; `copilot` reports
  `sessionResume: false`; `web` is `false` for every agent and documented.
- `rankCandidates` filters by `requirements`, ranks deterministically, and every
  entry carries reasons for each dimension (including `no data`).
- Missing D1 fields (`qualityScore`/`costUsdAvg` undefined) are treated as no
  data, never as 0 — an unmeasured pair is not ranked as bad.
- `route()` without the new options returns exactly the old fields and order
  (existing `test/router.test.mjs` and `test/router-quota.test.mjs` stay green).
- `route({adaptive:true})` orders survivors by score, stable on ties.
- An ineligible candidate appears in `skipped` with `missing_capabilities`.
- Full suite green apart from the documented pre-existing flake/cancellations.

## Checks

- `node --test test/capabilities.test.mjs`
- `node --test test/routing-score.test.mjs`
- `node --test test/router.test.mjs test/router-quota.test.mjs`
- `npm test`

## Progress log

- 2026-09-21: feature doc created; worktree + branch `feat/d2-adaptive-routing`
  off `dev` (`8b2ca1c`).
- 2026-09-21: **T1 done** — `src/capabilities.mjs` + `src/routing/score.mjs` +
  17 tests. Verified 17/17. Commit `b048a3b`.
- 2026-09-21: **T2 done** — `route()` gains `requirements`/`preferences`/
  `adaptive` + always-on explainable `ranking`; capability-excluded candidates
  move to `skipped` with `missing_capabilities:*`. 8 integration tests; existing
  router tests unchanged. Verified 41/41; `npm test` 1076 pass / 0 fail.
  **Orchestrator correction**: the delegated writer had added a test-only
  backdoor that made `route()` read `AGENT_HUB_HOME/metrics.json` in production;
  it was rejected and replaced with the existing `_computeMetrics` injection.
- 2026-09-21: **T3 done** — README + CHANGELOG. Feature complete.

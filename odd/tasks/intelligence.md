# ODD Feature: D1 — Quality / Cost / Latency Intelligence

## Objective

Knowing who *finishes* is not knowing who produces good work. `computeMetrics`
currently reports success rate, p50/p95, tokens and error kinds. Extend it with
the dimensions the roadmap asks for, so an agent can be described as:

```
agent A:  success 96%  verified 89%  quality 8.9  cost $0.012  latency 41s
```

## Problem

- `costUsd` is captured per job (`jobrunner` writes it) but `computeMetrics`
  never aggregates it, so cost is invisible outside a single `job_result`.
- `verified` is mirrored onto the job record by C3, and `judge_verdict` by C4,
  but nothing aggregates them — and `judge_verdict`/`revision` are not even
  written onto the record yet, so the C4 judge outcome is only visible on the
  workflow node.
- There is no quality signal and no retry/revision signal, so the router (D2)
  has nothing better than success rate to route on.

## Scope

In scope:
- Plumb `judge_verdict` and `revision` onto the job record: `createJob` accepts
  `revision`; the engine mirrors `{ verified, judge_verdict, revision }` onto
  the job as soon as the C4 judge decides (so rejected/blocked verdicts are
  recorded too, not only accepted ones).
- `src/metrics.mjs`: new per-row dimensions — `costUsdTotal`, `costUsdAvg`,
  `verifiedCount`, `verifiedSamples`, `verifiedRate`, `verificationFailures`,
  `judgeVerdicts`, `revisionTotal`, `revisionAvg`, `retryCount`, `qualityScore`.
- `src/schemas.mjs`: `JobRecord.revision`; the new `MetricsRow` fields.
- Tests + docs.

Out of scope (explicit follow-ups):
- Dashboard columns for the new dimensions (D1-presentation; separate slice).
- `regressions` as a *temporal* signal. It needs a baseline window; what this
  slice offers instead is `verificationFailures` (work that succeeded execution
  but failed verification), which is the actionable part. A true
  regression-over-time metric is a follow-up.
- Routing on the new dimensions — that is D2.

## qualityScore (explicit decision)

`qualityScore = round1(10 * verifiedRate)` when there is at least one job with a
`verified` verdict, else `null`.

Rationale: quality is only claimed when there is verification evidence. An agent
with no verified runs has *unknown* quality, not perfect quality — returning
`successRate * 10` there would be optimistic pseudoscience. If a blend with
cost/latency/success is wanted later, it is one documented constant away.

## Constraints

- Additive: every new field is nullable/optional, so existing rows and records
  stay valid.
- `computeMetrics` keeps its incremental index and deterministic sorting.
- Strict TDD: failing test first, observed RED, then GREEN.

## Resolved TDD

- Mode: `on`. Runner: `node --test <file>` (repo script `npm test`).

## Delegation route

- T1: delegated writer (`agy`, `gemini-3.8-flash-high`, `mode: write`) in
  `/home/alejandro/Desarrollo/agent-hub-worktrees/d1-intelligence`. No Claude.
- T2/T3: orchestrator (docs) and the dashboard slice.

## Tasks

| ID | Task | Route | Evidence |
|----|------|-------|----------|
| T1 | plumbing (jobstore/engine/schema) + `metrics.mjs` + `test/metrics-intelligence.test.mjs` | delegated writer | RED then GREEN |
| T2 | dashboard metrics columns + type + view test | delegated writer | RED then GREEN |
| T3 | README + CHANGELOG | inline | diff read-back |

## Acceptance criteria

- `computeMetrics` rows expose `costUsdTotal`/`costUsdAvg` (null when no job
  carries a finite cost), `verifiedCount`/`verifiedSamples`/`verifiedRate`
  (null when no verification evidence), `verificationFailures`,
  `judgeVerdicts`, `revisionTotal`/`revisionAvg`, `retryCount`, `qualityScore`.
- `qualityScore` is null with no verified samples, else `10 * verifiedRate`
  rounded to one decimal.
- Non-numeric/absent values never produce `NaN`; they are skipped like tokens.
- The engine mirrors the judge verdict onto the job on every verdict, including
  `rejected`/`blocked`.
- Existing metrics behaviour (successRate, p50/p95, tokens, errorKinds) is
  unchanged; `test/metrics.test.mjs` still passes.
- Full suite green apart from the documented pre-existing flake/cancellations.

## Checks

- `node --test test/metrics-intelligence.test.mjs`
- `node --test test/metrics.test.mjs`
- `npm test`

## Progress log

- 2026-09-21: feature doc created; worktree + branch `feat/d1-intelligence`
  off `dev` (`8b2ca1c`, after C4 re-landed via PR #14).
- Note: PR #13 was marked MERGED while never reaching `dev` (stacked base
  merged first). Re-landed as #14. Future slices branch from `dev`.
- 2026-09-21: **T1 done** — plumbing + metrics aggregation + 12 tests.
  Verified: `node --test test/metrics-intelligence.test.mjs test/metrics.test.mjs`
  -> 25 pass / 0 fail; `npm test` -> 1062 pass / 1 pre-existing flake / 8
  cancelled. Commit `d51ef00`.
- 2026-09-21: **T2 done** — dashboard columns + tests. Verified: dashboard 161
  pass, typecheck clean. Commit `67e03d3`.
- 2026-09-21: **T3 done** — README + CHANGELOG. Feature complete.

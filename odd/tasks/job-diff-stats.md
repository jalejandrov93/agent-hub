# Feature: job-diff-stats

Branch: `feat/job-diff-stats`
Engram mirror: `odd/job-diff-stats/tasks` (project `agent-hub`)

## Objective

Show, per agent job in the dashboard, how much the job changed — GitHub-style
`+X −Y · N files` — live while it runs and as a persisted snapshot after it
finishes.

## Problem / why

Jobs record no git baseline and no measured diff. The only related data is
the agent-declared `changedFiles` in the implementation handoff
(`src/handoff.mjs`), which is self-reported and unverified. The user cannot
see how much work a job did or is doing.

## Scope

- At job start, for `write`-mode jobs whose `cwd` is inside a git work tree,
  record the baseline commit (`git rev-parse HEAD`) on the job record.
- A pure/injectable helper computes diff stats against the baseline:
  tracked changes via `git diff --numstat <base>` (working tree vs base,
  including commits made by the agent) plus untracked, non-ignored files
  (`git ls-files --others --exclude-standard`, counted as additions by line
  count; binary files counted as files with 0 lines).
- Output shape: `{ baseCommit, additions, deletions, filesChanged, files:
  [{ path, additions, deletions, binary }], computedAt }`.
- Live: dashboard API computes stats on demand for running write jobs.
- Final: on job completion (any terminal status) persist the snapshot on the
  job record so it survives worktree deletion.
- Dashboard: jobs list/cards show `+X −Y · N files` (green/red, like GitHub);
  job detail shows the per-file table. Read-mode jobs show nothing.
- Signal: when a handoff declares `changedFiles`, flag a mismatch with the
  measured file set (informational only).

## Constraints

- Never mutate the job's repo (read-only git commands only; no `git add`,
  no index writes — use `--no-optional-locks` or `GIT_OPTIONAL_LOCKS=0`).
- Bounded cost: timeouts on git calls, cap per-file list size, cache live
  results briefly; never block job execution on stats failures (stats
  errors degrade to `null` with a reason).
- Non-git `cwd` or missing baseline -> no stats, no error.
- Follow existing patterns: jobstore record validation (`schemas.mjs`,
  `test/job-record-validation.test.mjs`), shared zod contracts for dashboard
  API types (never hand-redeclare API types), CSP-safe dashboard build.
- Strict TDD: RED before implementation, then GREEN, then REFACTOR.
- ~400 authored changed lines per task is an advisory planning heuristic.

## TDD

- Mode: enabled (source: session configuration, "Strict TDD Mode: enabled").
- Runner: `npm test` (`node --test`); dashboard: `npm run -w dashboard test`,
  `npm run -w dashboard typecheck`, `npm run build`.

## Tasks

- [x] C1 — Diff-stats core: `computeDiffStats({ cwd, baseCommit, runner })`
  helper + baseline capture at job start for write-mode jobs in git trees;
  schema fields on the job record. Tests with real temp git repos.
  Commit: `ba12096`. RED: `Cannot find module '.../src/diffstats.mjs'`
  (test/diffstats.test.mjs) and `AssertionError: undefined !== '<sha>'`
  (test/jobrunner-diffstats.test.mjs). GREEN: 13/13 (diffstats.test.mjs) +
  3/3 (jobrunner-diffstats.test.mjs); full `npm test` 1475/1475 pass.
- [x] C2 — Persist final snapshot on terminal job status; expose live and
  final stats through the dashboard API (shared zod contract); changedFiles
  mismatch flag. Tests.
  Commit: `6cb1152`. RED: `assert.ok(finalRecord.diffStats)` failing
  (undefined) on finishJob/cancelJob persistence tests, `TypeError:
  getJobDiffStats is not a function`, and the dashboard route tests all
  404ing. GREEN: 11/11 (jobrunner-diffstats.test.mjs), 4/4
  (dashboard-diffstats.test.mjs), 21/21 (diffstats.test.mjs); full
  `npm test` 1495/1495 pass.
- [x] C3 — Dashboard UI: `+X −Y · N files` on job rows/cards, per-file
  table in job detail. Tests + typecheck + build. Docs section.
  Commit: `2d03567`. RED: `Failed to resolve import "./DiffStatsSummary"` /
  `"./DiffStatsTable"` (new component tests), then `findByText("+7")` /
  `findByText("+9")` timing out (JobsView/HistoryView tests) before the
  column and hook existed. GREEN: 8/8 (DiffStatsSummary+DiffStatsTable),
  10/10 (jobs/index.test.tsx), 13/13 (history.test.tsx); full dashboard
  suite 194/194 pass. `npm run -w dashboard typecheck`: clean. `npm run
  build`: succeeded. `grep -rn '<style\|style="\|data:font' dashboard/dist`:
  no matches (exit 1). Full `npm test`: 1495/1495 pass.

Route declaration: C1–C3 delegated to one writer (mapping + preparation
triggers: jobrunner, jobstore, schemas, dashboard server and UI).

## Acceptance criteria

- A write job in a git worktree that modifies 2 files and adds 1 new file
  shows correct additions/deletions/files live and after completion.
- Deleting the worktree after completion keeps the persisted numbers.
- Read-mode and non-git jobs show no stats and raise no errors.
- `npm test`, dashboard tests, typecheck and build pass.

## Progress / next step

- Next: none — C1, C2, C3 all done. Feature complete on branch
  `feat/job-diff-stats`; no push/PR performed (writer scope).
- Queued after this feature (separate): D — hub-side verification for agy
  jobs (agy never runs tests) + keep `incomplete` detection.

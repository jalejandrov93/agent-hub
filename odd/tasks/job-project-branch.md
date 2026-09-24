# Feature: job-project-branch

Branch: `feat/job-project-branch`
Engram mirror: `odd/job-project-branch/tasks` (project `agent-hub`)

## Objective

Show, per job in the dashboard "Running jobs" table, which project (git
repository) and branch the agent is working on.

## Problem / why

The table only exposes the raw working directory (hidden by default). Users
cannot tell at a glance which repo/branch each running agent is touching,
which matters when several agents work in different repos or worktrees.

## Scope

- At job start (any mode), when `cwd` is inside a git work tree, capture
  `{ root, name, branch }` (`git rev-parse --show-toplevel`,
  basename of root, `git rev-parse --abbrev-ref HEAD`; detached HEAD →
  short SHA) and persist it on the job record as `repo`. Silent `null` when
  not a git tree / git missing (never fails the job).
- Add `repo` to the shared `JobRecord` zod schema (optional, nullable) so it
  reaches `/api/state` and the dashboard `Job` type.
- Dashboard: new visible-by-default "Project" column showing project name
  and branch; fallbacks: remote (Jules) jobs use `remote.source`, non-git
  jobs use the `cwd` basename, otherwise an em dash.

## Constraints

- Read-only git commands only (`GIT_OPTIONAL_LOCKS=0`), injectable exec,
  short timeout; reuse `src/diffstats.mjs` patterns.
- dashboard/AGENTS.md rules: strict CSP, no new deps, types from `@shared`
  only, `DataTable` column conventions.

## TDD

Mode: on (source: session config "Strict TDD Mode: enabled").
Runners: `npm test` (node --test), `npm run -w dashboard test` (vitest),
`npm run -w dashboard typecheck`, `npm run build` + CSP grep.

## Delivery

Forecast ~250 authored lines, strategy `ask-on-risk` (under budget, single PR).

## Tasks

- [x] T1 Backend: `captureRepoInfo` helper + `repo` field in `JobRecord` +
  capture/persist in `startJob`; tests with real temp git repos.
  Route: delegated direct (writer trigger: 2+ non-trivial files).
- [ ] T2 Dashboard: "Project" column (name + branch, fallbacks) in
  `dashboard/src/views/jobs/index.tsx` + tests.
  Route: delegated direct (same writer, sequential after T1).

## Acceptance criteria

- A running job started in a git repo shows `repo-name` and its branch in the
  Running jobs table without toggling column visibility.
- Non-git and remote jobs render a sensible fallback, never crash.
- All applicable checks pass.

## Progress / evidence

### T1 Backend (commit: pending — recorded after commit below)

- `src/diffstats.mjs`: new `captureRepoInfo({ cwd, env, execFn, timeoutMs })`
  — mirrors `captureDiffBase`'s injectable/never-throws shape. Returns
  `{ root, name, branch }` via `git rev-parse --show-toplevel` + basename;
  branch via `git rev-parse --abbrev-ref HEAD`, falling back to
  `git rev-parse --short HEAD` on detached HEAD (`abbrev-ref` prints
  `HEAD`) and to `git symbolic-ref --short HEAD` when `abbrev-ref` itself
  fails (unborn branch, no commits yet). Null on any failure.
- `src/schemas.mjs`: `JobRecord.repo` — `{ root, name, branch }` (branch
  nullable), whole field nullable/optional.
- `src/jobrunner.mjs`: `startJob` now calls injectable `captureRepoInfoFn`
  (default `captureRepoInfo`) for ANY mode with a `cwd` (read and write —
  unlike `diffBase`, which stays write-only), and persists the result as
  `repo` via `updateResult` when non-null. Never fails the job.
- Tests: `test/diffstats.test.mjs` (`captureRepoInfo` suite — named branch,
  subdirectory cwd resolves toplevel root, detached HEAD short SHA,
  no-commits-yet symbolic-ref fallback, non-git cwd, git-unavailable);
  `test/jobrunner-diffstats.test.mjs` (repo captured for write mode, repo
  captured for read mode too, no repo for non-git cwd without failing the
  job); `test/job-record-validation.test.mjs` (`repo` present/null/absent,
  and a malformed `repo` shape is rejected — proves it's schema-validated,
  not passthrough-accepted).

RED evidence: removing `captureRepoInfo`'s export
(`git stash push -- src/diffstats.mjs` then rerunning
`node --test test/diffstats.test.mjs`) reproduced
`SyntaxError: The requested module '../src/diffstats.mjs' does not provide
an export named 'captureRepoInfo'`. Before the schema/jobrunner changes,
`node --test test/job-record-validation.test.mjs test/jobrunner-diffstats.test.mjs`
failed 3/17: `JobRecord` accepted a malformed `repo` shape (passthrough),
and `job.repo` was `undefined` for both write- and read-mode jobs.

GREEN evidence:
- `node --test test/diffstats.test.mjs test/job-record-validation.test.mjs test/jobrunner-diffstats.test.mjs`: 45/45 pass.
- `npm test` (root, full node:test suite): 1543/1543 pass.

## Next step

T2.

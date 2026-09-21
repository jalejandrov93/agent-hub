# ODD Feature: C3 — Verifier

## Objective

Separate *execution success* from *task success*. Today `worker -> succeeded`
only means the CLI finished. A node can now declare deterministic checks
(tests, typecheck, lint, evidence existence, diff scope) and the engine records
a verdict:

```json
{
  "verified": true,
  "checks": [
    { "name": "tests", "passed": true },
    { "name": "typecheck", "passed": true },
    { "name": "scope", "passed": true }
  ]
}
```

## Problem

The engine marks a node SUCCEEDED the moment the job reaches a terminal
success. Nothing asks whether the work is correct. C2 gave nodes evidence files
but recorded a missing artifact as informational only. There is no place where
"the command exited 0" becomes "the task actually holds".

## Why now

C4 (judge / revision loop) consumes a verdict — `accepted / needs_revision /
rejected / blocked`. It cannot exist without C3 producing one. C3 is the item
right after C2 in the frozen roadmap and the thing that gives C2's manifest
teeth.

## Scope

In scope:
- `src/verify.mjs`: declarative check normalization + execution + verdict
  aggregation, with three deterministic check kinds:
  - `argv` — run a command (repo style: an argv array, never a shell string),
    pass when the exit code matches `expectExitCode` (default 0).
  - `artifact` — a declared C2 artifact must exist (by ref or by `from` step).
  - `diff` — `git diff --name-only HEAD` must not touch any `forbid` path
    prefix (scope check).
- `src/workflow/schema.mjs`: optional per-node `verify` config (array
  shorthand or `{ checks, required }`).
- `src/workflow/engine.mjs`: for delegate nodes, run the verdict after terminal
  success, persist `verification.json` as a C2 artifact, attach it to the node
  result / events, mirror `verified` onto the job record, and — when
  `required: true` — fail the node with the verdict attached.
- Tests: `test/verify.test.mjs` (unit, injected runner) and
  `test/workflow-verify.test.mjs` (integration).
- Docs: README section + CHANGELOG.

Out of scope (explicit follow-ups):
- The judge and the revision loop — that is C4. C3 only records a truthful
  verdict; by default a failed verdict does not fail the node, so C4 can turn
  `needs_revision` into a re-dispatch instead of a dead node.
- Agent-judged acceptance criteria (a model reading the diff). C3 is
  deterministic only; `argv` checks are the escape hatch.
- Retry policy tuned per check.

## Constraints

- No shell strings: checks are `argv: string[]` executed with the existing
  `runCommand(cmd, args, ...)` from `src/process.mjs`. No `eval`/`new Function`.
- A failing check is data, never a thrown exception from `runVerification`.
  It throws only on malformed configuration.
- Additive only: node status semantics unchanged unless `required: true`.
- Strict TDD: failing test first, observed RED, then GREEN.

## Resolved TDD

- Mode: `on` (strict TDD, project default).
- Runner: `node --test <file>` (repo script: `npm test`).
- Source: orchestrator strict-TDD mode + existing repo convention.

## Delegation route

- T1/T2: delegated writer (`agent-hub` `delegate`, `agy`, `gemini-3.8-flash-high`,
  `mode: write`) in worktree `/home/alejandro/Desarrollo/agent-hub-worktrees/c3-verifier`.
- Orchestrator: design, feature doc, review, independent verification, commits.
- No Claude delegation (quota).

## Tasks

| ID | Task | Route | Evidence |
|----|------|-------|----------|
| T1 | `src/verify.mjs` + `test/verify.test.mjs` | delegated writer | RED then GREEN output |
| T2 | Schema `verify` + engine wiring + `test/workflow-verify.test.mjs` | delegated writer | RED then GREEN output |
| T3 | README + CHANGELOG docs | inline (mechanical) | diff read-back |

## Acceptance criteria

- `normalizeVerifyConfig(node)` returns `null` with no `verify`, accepts both an
  array shorthand and `{ checks, required }`, and throws on an unknown check
  kind or a malformed check.
- `argv`: passed iff `exitCode === expectExitCode`; honours `cwd`/`timeoutS`; a
  timeout is a failed check, not a throw.
- `artifact`: passed iff the referenced C2 artifact exists; `from` defaults to
  the node itself.
- `diff`: passed iff no changed path matches a `forbid` prefix
  (prefix or `prefix/`); reports the offending paths.
- Verdict is `{ verified, required, checks, startedAt, finishedAt }` with
  `verified === checks.every(c => c.passed)`.
- Engine: a node with a `verify` config writes `runs/<wf>/<step>/artifacts/
  verification.json`, the verdict travels on `job.finished`, and the job
  record's `verified` column is updated best-effort.
- Engine: with `required: true` and a failed verdict the node ends `failed`
  with the verdict attached; with `required: false` the node still succeeds and
  only the verdict records the truth.
- Full suite green apart from the documented pre-existing flake/cancellations.

## Checks

- `node --test test/verify.test.mjs`
- `node --test test/workflow-verify.test.mjs`
- `npm test`

## Progress log

- 2026-09-20: feature doc created; worktree + branch `feat/c3-verifier`
  (stacked on `feat/c2-artifacts`, PR #10).
- 2026-09-20: **T1 done** — `src/verify.mjs` + `test/verify.test.mjs` (9 tests:
  normalize, argv/artifact/diff kinds, aggregation, prefix safety).
  Verified independently: `node --test test/verify.test.mjs` -> 9 pass / 0 fail.
  Commit `4c6f83e`.
- 2026-09-20: **T2 done** — `NodeSchema.verify`, engine wiring
  (`runCommandFn` injection → `runVerification` → `verification.json` artifact
  → `job.finished`/`job.failed` verdict → `jobs.verified` mirror →
  `VERIFICATION_FAILED` breaks the retry loop), `test/workflow-verify.test.mjs`
  (4 integration tests). Verified: targeted 37 pass / 0 fail; full `npm test`
  1032 pass / 1 fail (pre-existing `worktree-lease` full-suite flake) /
  8 cancelled (`quota-codexbar`, pre-existing).
- T3 pending: README + CHANGELOG.

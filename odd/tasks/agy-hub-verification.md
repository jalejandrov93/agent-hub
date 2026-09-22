# Feature: agy-hub-verification

Branch: `feat/agy-hub-verification`
Engram mirror: `odd/agy-hub-verification/tasks` (project `agent-hub`)

## Objective

agy jobs never run tests, builds, servers or other long commands; the hub
runs the verification itself, in the foreground, after the agy job ends.
The existing `incomplete` detection stays as the safety net.

## Problem / why

agy CLI 1.2.8 `run_command` auto-detaches slow commands into background
tasks and `-p` idle-exit kills them while reporting SUCCESS (upstream
google-antigravity/antigravity-cli #1044, #1076; no flag to disable).
Prompt instructions cannot prevent it because the tool, not the model,
decides. Asking agy to "write the RED test first" makes it run tests, which
is exactly what gets killed. The hub already detects the kill marker and
marks the job `incomplete`, but the work is still lost.

## Scope

- D1 — Hub-owned agy prompt guard: for every agy job (delegate, dispatch,
  workflow nodes), prepend a short, fixed instruction block: do not run
  tests, builds, dev servers, package installs or any long-running command;
  write code and tests only (a RED test is written, not executed); the hub
  runs verification after the job. Applied in one place (adapter or job
  start), opt-out only via an explicit internal flag for read-only probes
  that need no guard (e.g. preflight pings), never user-visible prose drift.
- D2 — Hub-side verification for delegate/dispatch: accept an optional
  `verify` array (same check shapes as `src/verify.mjs`, `argv` kind at
  minimum, run with the job `cwd` by default). After a job reaches
  `succeeded`, the hub runs the checks in the foreground with timeouts and
  records `verification: { ok, checks: [{ name, ok, exitCode, durationMs,
  outputTail }] }` on the job record. Jobs that end `incomplete`, `failed`
  or `canceled` skip verification (recorded as `skipped` with reason).
  Verification failure does NOT change the job status or trip circuit
  breakers; it is surfaced in `job_result`/`job_status`, the `job.finished`
  event and the dashboard job detail.
- D3 — Docs and skill: `docs/verification.md` section for delegate/dispatch
  `verify`; update `skills/multi-agent-orchestrator/SKILL.md` and
  `skills/agy-delegate` (if present in repo) so orchestrators pass
  verification commands to the hub instead of asking agy to run them.
  Keep `incomplete` detection untouched (regression test that the guard
  and the detection coexist).

## Constraints

- Reuse `src/verify.mjs` (`normalizeVerifyCheck`, argv runner) — no second
  verifier implementation.
- Verification commands run with bounded timeouts via `src/process.mjs`,
  never in the background, never with a shell unless the check already
  supports it.
- MCP input schemas (`src/schemas.mjs`, `src/index.mjs` tool definitions)
  validate `verify`; invalid checks fail fast before dispatch.
- The write lock / reservation semantics of write jobs must hold while the
  hub verifies (verification runs before the lock is released, or document
  why not).
- Strict TDD: RED before implementation, then GREEN, then REFACTOR.
- ~400 authored changed lines per task is an advisory heuristic only.

## TDD

- Mode: enabled (source: session configuration, "Strict TDD Mode: enabled").
- Runner: `npm test` (`node --test`); dashboard: `npm run -w dashboard test`,
  `npm run -w dashboard typecheck`, `npm run build`.
- Known flake: `test/process.test.mjs` SIGINT/SIGTERM second-stage timing
  test can fail under full-suite load; passes in isolation.

## Tasks

- [x] D1 — agy prompt guard (single injection point) + tests. Commit `40f77f1`.
  Injection point: `src/adapters/agy.mjs` `buildArgv` (agy-only, `guard=true`
  default) prepends the fixed `AGY_GUARD_BLOCK` to the prompt. Every real job
  reaches it through `jobrunner.mjs`'s `startJob` (delegate/dispatch/workflow
  all funnel through it), so this is genuinely the one place. Opt-out:
  `guard:false`, used only by `preflight.mjs`'s `pingAgent` (its own comment
  already says the ping must travel "the SAME path as a real job" — the guard
  is pure noise for a probe that only asks for a literal PONG and never
  writes/runs anything). RED: `node --test test/adapters/agy.test.mjs
  test/preflight.test.mjs` failed with `SyntaxError: ... does not provide an
  export named 'AGY_GUARD_BLOCK'` (module didn't exist yet). GREEN: same
  command, 58/58 pass. Full suite after fixing 1 collateral assertion
  (`test/jobrunner-agys.test.mjs`, which asserted the raw un-guarded prompt
  text — updated to expect `${AGY_GUARD_BLOCK}\n\nsay hello`): `npm test` →
  1498/1498 pass, 0 fail (including the known SIGTERM flake, which passed).
- [ ] D2 — `verify` on delegate/dispatch, hub-run foreground checks,
  `verification` on job record/API/event, dashboard job detail row + tests.
- [ ] D3 — docs + skills + coexistence regression test.

Route declaration: D1–D3 delegated to one writer (mapping + preparation
triggers: adapters, jobrunner, dispatch, index tool schemas, verify, docs).

## Acceptance criteria

- Every agy argv carries the guard block; non-agy agents are unchanged.
- `delegate({ ..., verify: [{ name: 'tests', argv: ['npm','test'] }] })`
  runs `npm test` in the job cwd after success and records the result.
- An `incomplete` agy job skips verification with a recorded reason.
- A failing verification leaves status `succeeded`, `verification.ok=false`,
  and no breaker trip.
- `npm test`, dashboard tests, typecheck and build pass.

## Progress / next step

- Next: D2.
- Queued after this feature (separate): E — run MCP + dashboard from a fixed
  runtime worktree on `main`, so development in the checkout never affects
  the live hub.

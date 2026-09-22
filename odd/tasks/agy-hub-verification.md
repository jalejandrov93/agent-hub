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
- [x] D2 — `verify` on delegate/dispatch, hub-run foreground checks,
  `verification` on job record/API/event, dashboard job detail row + tests.
  Commit `577f691`. Design: `src/verify.mjs` gained a shared `execArgvCheck`
  helper (the exact command-execution primitive both `runVerification`'s
  argv branch and the new `runJobVerification` use — one verifier, two
  shapers) plus `runJobVerification({checks, cwd, workflowId, stepId, env,
  runCommandFn, timeoutS})`, returning `{ok, checks:[{name, ok, exitCode,
  durationMs, outputTail}]}` or `null`. `jobrunner.mjs`'s `startJob` accepts
  `verify`, normalizes it synchronously via `normalizeVerifyCheck` before any
  job record exists (fail-fast), and persists it on the record (like
  `diffBase`) so `cancelJob` — which only gets a `jobId` — can also see it.
  `finishJob` runs verification only in the `succeeded` branch, awaited
  before the function returns; `startJob`'s write-lock release/heartbeat
  stop only happen in the `.finally()` after that promise settles, so the
  lock is held for the whole verification run (no code change needed — just
  placement). incomplete/failed/read_mode_violation/canceled record
  `verification: {ok:null, checks:[], skipped:true, reason}` instead.
  `dispatch()`/`delegateTool` validate `verify` (throw away the normalized
  result, just to fail fast) before any route/breaker/reservation/job-record
  side effect, then forward the raw array to `startJobFn`. Exposed via
  `job_status`/`job_result` (`tools/jobs.mjs`), the `job.finished` event
  (`verificationOk`, a flat scalar — the full checks array stays on the
  record, not the append-only log, matching diffStats' own precedent), and a
  new `dashboard/src/views/jobs/JobDetailModal.tsx` "Verification" section
  (Badge-based, never color-only). Zod: `VerifyCheckInput`,
  `VerificationCheckResult`, `Verification` added to `src/schemas.mjs`;
  `JobRecord.verification`, `JobResultResponse.verification`,
  `HubEvent.verificationOk`.
  RED: `node --test test/verify.test.mjs` failed with `SyntaxError:
  ... does not provide an export named 'runJobVerification'`; the same
  pattern (missing export / undefined field) for
  `test/jobrunner-verify.test.mjs` (7/8 failing), `test/dispatch.test.mjs`
  (1 new test failing), `test/tools-jobs.test.mjs` (5 new tests failing),
  and `dashboard/.../JobDetailModal.test.tsx` (4/4 failing, incl. one
  "Invalid Chai property: toBeInTheDocument" — this project's dashboard
  tests use vitest-native `.toBeTruthy()`/`queryByText(...) === null`, not
  jest-dom matchers; fixed in the test itself, not the component).
  GREEN: `test/verify.test.mjs` 18/18, `test/jobrunner-verify.test.mjs` 8/8,
  `test/dispatch.test.mjs` 16/16, `test/tools-jobs.test.mjs` 37/37,
  `JobDetailModal.test.tsx` 4/4.
  Verification (after D2): `npm test` → 1519/1519 pass, 0 fail.
  `npm run -w dashboard test` → 198/198 pass (25 files). `npm run -w
  dashboard typecheck` → clean. `npm run build` → succeeds (pre-existing
  >500kB chunk-size warning, unrelated). `grep -rn '<style\|style="\|data:font'
  dashboard/dist` → no matches.
- [x] D3 — docs + skills + coexistence regression test. Commit `71c92d3`.
  `docs/verification.md` gained a "Hub-run verification for delegate/dispatch"
  section (why the guard exists, the `verify` shape, skip/never-changes-status
  rules, reuse of `runJobVerification`). `skills/multi-agent-orchestrator/
  SKILL.md`: `delegate`'s documented signature now includes `verify`, a new
  "Verification" section explains it, and the "Task header template" no
  longer tells the agent to "run the test/type-check/lint command and paste
  the output" (that was the exact anti-pattern D1 fixes) — it now says write
  a RED test but don't run it, and to pass the same commands via `verify`
  instead. `skills/agy-delegate/SKILL.md` gained a note that the hub's guard
  covers the MCP path only; its `agy-run.sh` no-MCP fallback calls `agy`
  directly and does NOT get the guard, so a user of that fallback must
  restate the instruction themselves — documented, not silently gapped.
  Coexistence regression: a new test in `test/jobrunner-verify.test.mjs`
  starts a REAL agy job (the real adapter, not a fake), asserts the built
  prompt carries `AGY_GUARD_BLOCK`, feeds the real
  `stream-background-yield.jsonl` fixture as the child's stdout, and asserts
  the job still ends `status:'failed'`/`errorKind:'incomplete'` (the D1
  guard text living in the prompt never interferes with D2's `incomplete`
  detection, which reads stdout) — with a configured `verify` correctly
  recorded as `skipped` rather than run. RED/GREEN: N/A — this task added no
  new production code, only docs/skills text and one regression test; the
  test passed on the first run (9/9 in that file) because D1/D2 were already
  correctly implemented, which is itself the intended proof of coexistence.
  Verification: `npm test` → 1520/1520 pass, 0 fail. `npm run -w dashboard
  test` → 198/198 pass. `npm run -w dashboard typecheck` → clean. `npm run
  build` → succeeds. `grep -rn '<style\|style="\|data:font' dashboard/dist`
  → no matches.

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

- Next: D1-D3 complete. Feature scope fully implemented, tested, documented,
  and verified. See "Queued after this feature" above (E) for the next
  separate feature.
- Queued after this feature (separate): E — run MCP + dashboard from a fixed
  runtime worktree on `main`, so development in the checkout never affects
  the live hub.

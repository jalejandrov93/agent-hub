# post-audit fixes — defects found by the dual-lineage audit of the 11-PR release

## Objective
Fix the defects the post-release audit confirmed (main = 038fede), each behind a test that
was observed RED before the fix and GREEN after.

## Why
A blind dual-lineage audit (agy `claude-sonnet-4-6` vs agy `gemini-3.1-pro-high`, 4 file-disjoint
scopes) surfaced four real defects in the recently shipped batch. Every finding below was
re-verified against the code by the referee pass before being accepted.

## Scope (in)
- `src/workflow/state.mjs`, `src/workflow/engine.mjs` — cancelled/waited retries, orphan reclaim, stall bound
- `src/storage/sqlite.mjs` — JSON-backend atomicity of `reserveDispatchKey`
- `src/worktree.mjs` — `isWorktreeClean` cwd guard
- `docs/execution-contract.md`, `README.md` — drift vs code

## Scope (out)
- Wiring the reservation primitive into `src/dispatch.mjs` (separate pending task)
- `origin/feat/c3-verifier` (pre-existing, untouched)

## Tasks

| ID | Defect | Fix | Check |
|----|--------|-----|-------|
| T1 (H4) | A node retried after a wait exhausts/timeouts does `transitionNode(WAITING -> READY)`, which the state table forbids → uncaught throw. A cancel (`ECANCELED`) is also retried and can throw the same way. | Add the documented `waiting -> ready` re-queue edge; finalize `ECANCELED` as `canceled` (no retry); adopt an externally terminal row instead of overwriting it. | `test/workflow-retry-terminal.test.mjs` |
| T2 (H2+H3) | Resume/runtime recovery revived ANY foreign-owned running node (`leaseExpired \|\| !hasExplicitProbe`), stealing a live peer's node; and the runner wave had no bound, so an unclaimable ready node looped forever. | One reclaim policy (expired lease OR a probe that says the owner is dead) applied at resume init and each scheduler pass, plus a bounded stall that fails with a `workflow.stalled` diagnostic instead of hanging. | `test/workflow-orphan-reclaim.test.mjs` |
| T3 (H1) | `jsonReserveDispatchKey` was read-modify-write with no lock, so the documented cross-process idempotency did not hold in the default (JSON) backend. | Route it through `updateJsonLocked` (`src/fsutil.mjs`). | `test/storage-reservation-race.test.mjs` (real child processes) |
| T4 (M1) | `isWorktreeClean(undefined)` inherited `process.cwd()` and reported the wrong repo's cleanliness. | Fail closed with `{ clean: false, reason: 'missing-cwd' }`. | `test/worktree-clean.test.mjs` |
| T5 (M2+M3) | Docstring said `leases` is keyed `(job_id, owner)`; the contract doc said SIGTERM→SIGKILL and kept a stale `jobrunner.mjs:233`; some refs were prose, not symbols. | Correct the docstring, the kill ladder, the stale ref, and replace prose refs with real symbols. | grep + review |

## Route declaration
- T1–T5: **direct inline, single writer thread (the orchestrator)**.
- Trigger evidence for the deviation from the writer-delegation trigger: every fix is a
  state-machine decision this session already diagnosed, and the delegated write path failed
  twice in this session (agy wrote nothing for the storage task; a Jules docs PR committed
  `plan.md` + `rewrite_docs.py` scratch files). Re-delegating a judgment that must be re-read
  and re-verified line by line pays twice; the audit itself was delegated (read-only) and that
  is where delegation added value.
- TDD mode: **strict** (source: `gentle-ai:strict-tdd-mode`). Test runner: `npm test`
  (`node --test`). Node must be the fnm v22 build (ABI 127).

## Acceptance criteria
- Each task's test observed RED before its fix and GREEN after.
- `npm test` 1339+ pass / 0 fail, dashboard 176, `node bench/run.mjs` ok.
- No behavior change outside the listed files.

## Progress
- [x] T1 engine retry/terminal — `539f721`; test/workflow-retry-terminal.test.mjs (RED: "cannot transition from waiting|canceled to ready")
- [x] T2 orphan reclaim + stall bound — `7561f2c`, corrected to AND semantics in `17cbe7d` after test/chaos/chaos.test.mjs "chaos 3" (the specification) failed; test/workflow-orphan-reclaim.test.mjs (RED: hang under --test-timeout)
- [x] T3 JSON reservation atomicity — `2cc1b86`; test/storage-reservation-race.test.mjs (RED: 8 of 8 child processes won)
- [x] T4 worktree cwd guard — `654cce0`; test/worktree-clean.test.mjs (RED: 2 cases)
- [x] T5 docs drift — `a5ed93a`; checker over the contract: 25 file+symbol pairs, 0 failures
- [x] Full verification — `npm test` 1345/1345/0, chaos 4/4, dashboard 176/176 + typecheck clean, `node bench/run.mjs` ok

Engram mirror (`odd/post-audit-fixes/tasks`): **PENDING** — Engram rejects saves (multiple
active runtime sessions match this project+directory and this session's id is not registered).

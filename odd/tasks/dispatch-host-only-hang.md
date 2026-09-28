# Dispatch host-only hang

## Objective
A `dispatch` routed to a host-only `claude` candidate must fail fast (or fall through to an
executable candidate) instead of freezing the whole agent-hub MCP process.

## Problem
Incident 2026-09-28 (student_tracking fix-f0/f1/p5): three `dispatch` calls with
`taskType: implementation-with-repo-rules`, `mode: write` routed to `{agent:'claude'}`. None returned;
every later tool call on the same server (even `delegate` to agy on fresh paths) hung until `/mcp`
reconnect.

Causal chain (verified in code):
1. `src/router.mjs` routes that taskType to `{agent:'claude'}` — meant for the host's Agent tool.
2. `isCandidateUsable` returns true for `claude` (`src/dispatch.mjs:345`); the write reservation lock
   is taken (`dispatch.mjs:771`).
3. `startJob` -> `adapterFor('claude')` throws `unknown agent: claude` (`src/adapters/index.mjs`),
   before `createJob`.
4. `executeWithPolicy` (`src/policy/executor.mjs`) classifies it as crash -> retry once -> fallback.
   The fallback stage stays applicable forever because `dispatch` always sets `ctx.onFallback`
   (`dispatch.mjs:819`) and nothing marks fallback as exhausted. The `while (true)` loop only awaits
   already-resolved promises, starving the Node event loop.

## Why
One misrouted call takes down the whole hub for every session until a manual reconnect.

## Scope
- T1: `executeWithPolicy` must stop the fallback stage when no fallback candidates remain, and must
  not loop unbounded.
- T2: `dispatch` treats `agent === 'claude'` candidates as host-only: drop them from the executable
  chain; if none remain, fail fast with a clear, typed error BEFORE reserving the worktree.

Out of scope: changing `DELEGATION_MAP` routes; `route()` output; agy candidates that use Claude
models (`agent: 'agy'`, `model: 'claude-*'`) are unaffected.

## Constraints
- Strict TDD: observed RED before GREEN. Runner: `npm test` (node --test); focused
  `node --test test/policy.test.mjs test/dispatch.test.mjs`.
- Planning heuristic ~400 changed lines per task (advisory only).
- Delivery strategy: ask-on-risk (default). Forecast well under 400 lines.

## Tasks
- [x] T1 — Executor: fallback stage non-applicable once fallbacks are exhausted (no remaining
  candidates), plus a bounded-iteration guard that rethrows the last error. Tests in
  `test/policy.test.mjs` reproduce the infinite loop (RED) with `onFallback` set and empty fallbacks.
  Route: delegated direct (writer trigger: executor + tests).
- [x] T2 — Dispatch: host-only `claude` candidates are filtered out of primary/fallbacks; when none
  remain, reject before `acquireWriteLockFn` with `errorKind: 'host_only'` and a message telling the
  caller to run it through the host Agent tool; no lock file left behind. Tests in
  `test/dispatch.test.mjs`. Route: delegated direct.

## Acceptance criteria
- [x] A dispatch whose only candidate is `claude` returns/throws promptly with a host-only error and
  leaves no worktree lock.
- [x] A chain `[claude, agy]` runs on agy.
- [x] `executeWithPolicy` with `onFallback` and no fallbacks terminates with the original error (in
  this codebase's semantics: it escalates per the classified error's policy, e.g. `crash` ->
  "Escalated to human: <original message>" with `.cause` set to the original error — fallback is
  simply never attempted when there are no candidates; see T1's design note).
- [x] `npm test` passes (baseline 1543/1543 before this feature; 1549/1549 after T1+T2, no
  pre-existing failures).

## Progress
- Branch: `fix/dispatch-host-only-hang`.
- T1 commit: `6cae244` — `fix(policy): stop fallback stage once no candidates remain`.
  - RED (bounded, safe): `executeWithPolicy stops offering the fallback stage once no fallback
    candidates remain` and `executeWithPolicy uses a single fallback candidate once, then escalates
    per existing semantics` both failed with `fallback stage kept running with no candidates left` /
    `... ran more than once for a single candidate` (assertion, not a hang — bailout tripped inside
    `onFallback` after the fallback stage kept re-entering under the old `|| ctx?.onFallback`
    applicability).
  - GREEN: `node --test test/policy.test.mjs` → `tests 11, pass 11, fail 0`.
  - Design choice: fallback with zero remaining candidates is now attempted **not at all** (rather
    than once) — `isApplicable` only checks `ctx.fallbacks.length > 0`, dropping the
    `onFallback`-alone branch entirely. This keeps every pre-existing test green (they all use
    non-empty `fallbacks` arrays) and matches the objective's wording exactly ("stop being applicable
    once there are no remaining fallback candidates").
  - Full suite: `npm test` → `tests 1545, pass 1545, fail 0` (baseline was 1543/1543 before T1).
- T2 commit: `bb842a1` — `fix(dispatch): reject host-only claude candidates before reserving worktree`.
  - RED: `node --test test/dispatch.test.mjs` (filtered to the 3 new `T2:` tests that exercise the
    fix, before the dispatch.mjs change) failed:
    - "rejects fast with errorKind host_only..." → `AssertionError: expected 'host_only', got
      undefined` (dispatch threw the generic "unknown agent: claude" escalation instead).
    - "leaves no worktree lock on disk" → rejected with `Escalated to human: unknown agent: claude`
      instead of a `host_only` error (worktree lock was reserved and released by existing cleanup,
      but only after the crash, not before it).
    - "chain [claude, agy] drops the host-only candidate..." → `'claude' !== 'agy'`, i.e. startJobFn
      was invoked with the host-only candidate instead of skipping to agy.
    - The 4th new test (agy with a Claude model name) already passed pre-fix, as expected (it is a
      non-regression guard).
  - GREEN: `node --test test/dispatch.test.mjs` → `tests 20, pass 20, fail 0`.
  - Full suite: `npm test` → `tests 1549, pass 1549, fail 0`.
  - Design choice: the host-only filter/reject only applies to the `routeFn`-produced
    primary+fallback chain (the actual source of `agent: 'claude'` candidates via
    `DELEGATION_MAP`), not to a directly-injected `restDeps.candidate` — out of scope per this
    feature's "route() output unchanged" constraint and no real caller passes `candidate: {agent:
    'claude'}` directly.
  - Open note: the dispatch-key store reservation (step 0, before candidate discovery) is still
    taken before the host-only check runs, since candidate discovery happens after it in
    `dispatch()`'s existing structure — reordering that was out of scope. The existing `finally`
    block already releases that reservation (`dispatchReservationOwned && !jobProduced`) and never
    acquires the worktree write lock in this path, so the acceptance criterion ("no lock file left
    behind") holds; only the dispatch-key store row is briefly touched and released, not any
    worktree lock file.

- Parent spot check: `node --test test/policy.test.mjs test/dispatch.test.mjs` → `tests 31, pass 31,
  fail 0`. `onFallback` has no other caller besides `dispatch.mjs`, so the executor change is local.
- RDD assessment (`--base-ref main --committed-only`, untracked `.atl/` and unrelated odd docs
  excluded): risk `medium` (`executable_change` src/dispatch.mjs), 357 changed lines,
  `review_due: false`, reason `under_budget`. Native review not yet run for this slice.

## Next step
None — both tasks complete. Ready for review/PR at the user's discretion (no push/PR/merge was
performed per this task's constraints).

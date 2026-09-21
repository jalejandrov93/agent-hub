# dispatch idempotency — wire the store-backed reservation into `dispatch()`

## Objective
Make `dispatch()`'s documented dedup by `dispatchKey` actually hold ACROSS processes.

## Why
The contract (README, `docs/execution-contract.md`) says `dispatch` "deduplicates by
`dispatchKey` (concurrent same-key dispatches share one job)". It did not:
- `inFlightDispatches` is an in-process `Map`, and `recentDispatches` is an in-process cache;
- `findRecentJobByDispatchKey` scans jobs that ALREADY exist.

Two schedulers (or a restart) scanning at the same instant both miss and both create a job.
The store-backed `reserveDispatchKey` primitive landed in #74 precisely for this, and had no
consumer. Measured before the wiring: **4 concurrent processes, same key → 4 jobs**.

## Scope
`src/dispatch.mjs`, `test/dispatch-reservation.test.mjs`.

## What changed
A step 0 gate inside `dispatch()`, before candidate discovery and after the cheap
in-process/disk checks:

1. `reserveDispatchKey(ctx, { dispatchKey, jobId: execId })` — the winner records the
   `executionId` it is about to create the job with.
2. If the key is already held: bounded wait (2s, 25ms poll) for the holder's job by
   `executionId`, then share it. The cheap checks still run first, so a mocked/sequential
   duplicate never pays the wait.
3. If the holder died between reserving and creating its job, its job failed, or the
   reservation outlived `DISPATCH_WINDOW_MS` (10 min), the key is released and taken over.
4. `finally`: when this dispatch owned the key and never produced a job, release it, so a
   failed attempt cannot block retries for the whole window.

## Acceptance criteria
- N concurrent processes, one key → exactly one job, all sharing the same `jobId`.
- A reservation whose job is terminal-failed does not block a fresh dispatch.
- No behavior change in the no-race path (`test/dispatch*.test.mjs` unchanged and green).

## Verification
- `test/dispatch-reservation.test.mjs` — RED: 4 of 4 processes created a job ("got 4"); GREEN: 1 job, one shared jobId.
- `test/dispatch*.test.mjs` + `c11-dispatch-handle` + `workflow*`: 98/98
- `npm test` 1347/1347/0, dashboard 176/176 + typecheck clean, `node bench/run.mjs` ok

## Deferred
- A reservation has no TTL of its own; it relies on `DISPATCH_WINDOW_MS` plus the takeover path.
- Best-effort: if the takeover re-reserve also loses, this dispatch proceeds without holding the
  key (never worse than the previous behaviour, only reachable when a holder dies inside the
  reserve→create gap).
- The other JSON store writers still write unlocked (the store-wide locking discipline is a
  separate pending item).

Engram mirror (`odd/dispatch-idempotency-wiring/tasks`): **PENDING** — Engram rejects saves
(multiple active runtime sessions match this project and directory).

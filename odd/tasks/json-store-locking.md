# JSON store: one critical section (and atomic writes) for every mutation

## Objective
Stop concurrent writers of the JSON backend's single `storage.json` from losing
each other's updates, and stop readers from ever seeing a torn store.

## Why
Every `json*` mutator did `readJsonStore` → change → `writeJsonStore`, unlocked,
over the WHOLE store. Two writers (the MCP server and the dashboard, or two CLI
processes) each clobbered whatever the other had just written. Measured RED: four
processes writing five jobs and five messages each produced **1 job instead of 20**.

Second, quieter defect: `writeJsonStore` used `fs.writeFileSync` (not atomic), and
`readJsonStore` falls back to the EMPTY default store on a parse error — so a torn
read silently degrades into data loss on the next write.

## Scope
`src/fsutil.mjs`, `src/storage/sqlite.mjs`, `test/storage-json-locking.test.mjs`.

## What changed
- `withJsonLock(file, fn)` exported from `fsutil.mjs`: runs a callback while
  holding the same exclusive `${file}.lock` that `updateJsonLocked` uses, for
  read-modify-writes that are not expressible as a pure updater. Documented as
  **not reentrant**.
- `writeJsonStore` now uses `writeJsonAtomic` (temp file + rename).
- `mutateJsonStore(stateHome, fn)` wraps every JSON mutation in that lock, and all
  15 public mutators go through it: `initDb`, `upsertJob`, `upsertLease`,
  `deleteLease`, `upsertWorkflow`, `upsertWorkflowNode`, `claimWorkflowNode`,
  `publishWorkflowNodeReady`, `resumeWorkflowNode`, `upsertHarnessOrigin`,
  `upsertHandoff`, `addContextEntry`, `insertAgentMessage`,
  `markAgentMessageDelivered`, `markAgentMessageAck`.
  `touchWorkflowNode`, `reserveDispatchKey` and `releaseDispatchReservation`
  already used `updateJsonLocked` and are deliberately NOT wrapped (nesting would
  deadlock the non-reentrant lock).

## Lock ordering (checked, not assumed)
`jobstore.updateResult` holds `result.json.lock` and calls `mirrorJobToDb` →
`upsertJob` → `storage.json.lock`: **different files**, and no storage mutator
ever takes `result.json.lock`, so there is no inversion and no nesting.

## Acceptance criteria
- Concurrent processes: every write of every writer survives, and the store parses.
- The store is never observed truncated.
- No regression in the SQLite backend or in the modules that lock their own files.

## Verification
- `test/storage-json-locking.test.mjs` — RED: 4 processes × (5 jobs + 5 messages) → **1 job**.
  GREEN: 20 jobs, 20 messages, valid JSON. Second case: 50 sequential writes, the
  store parses after every one.
- storage + chaos suites 32/32; `npm test` **1351/1351/0**; dashboard 176/176 +
  typecheck clean; `node bench/run.mjs` ok.

## Deferred
- SQLite-backend contention is unaffected (it has its own WAL/transaction story).
- The lock is a file lock with a 2s retry budget: under pathological contention a
  mutation can throw `lock timeout`. That is deliberate (fail loudly rather than
  write blind), but a busy dashboard could see it; a retry/backoff policy is a
  separate decision.

Engram mirror (`odd/json-store-locking/tasks`): **PENDING** — Engram rejects saves
(multiple active runtime sessions match this project and directory).

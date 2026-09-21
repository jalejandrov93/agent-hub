# Concurrency: CAS orphan reclaim and conditional dispatch-key takeover

## Objective
Close two cross-process races found by the 2026-09-21 audit (agy gemini-3.1-pro-high,
verified by reading the code): a workflow node can run twice, and one `dispatchKey`
can be dispatched twice.

## Problem
1. **Orphan reclaim double-run.** `reclaimOrphanedNode` (`src/workflow/engine.mjs`)
   decides from a row read earlier in the wave, then calls `transitionNode`, which
   writes with an unconditional `UPSERT`. Interleaving: P1 and P2 both read node N
   `RUNNING` with a dead owner and an expired lease; P1 moves it to `READY` and claims
   it (`RUNNING`, owner P1); P2 then writes `READY`/`claimed_by=null` over P1's
   claim (`RUNNING -> READY` is a legal transition) and claims it too. N runs twice.
2. **Dispatch takeover.** `dispatch.mjs` takes over a stale reservation with
   `releaseDispatchReservation(key)` (a `DELETE` filtered only by key) followed by
   `reserveDispatchKey`. Two waiters that both see the same dead holder can delete
   each other's fresh reservation and both proceed: duplicate dispatch.

## Scope
`src/workflow/engine.mjs`, `src/storage/sqlite.mjs`, `src/storage/index.mjs`,
`src/dispatch.mjs`, and tests under `test/`. Both storage backends (SQLite and JSON)
must get the same conditional semantics.

## Constraints
- Strict TDD: observed RED before GREEN.
- No behavior change for the single-process path; existing tests stay green.
- Tests run with Node v22 (`~/.local/share/fnm/aliases/default/bin/node`); the
  shell's `/usr/bin/node` v24 cannot load `better-sqlite3`.

## Tasks
- [x] T1 — Orphan reclaim is a compare-and-set: release to `READY` only if the row
  still has the status, owner and `updated_at` that justified the reclaim; a lost
  CAS returns false and changes nothing. Route: delegated direct (writer trigger:
  engine + both storage backends + tests). Commit `433158b`.
- [x] T2 — Dispatch-key takeover is conditional: release a reservation only if it
  still belongs to the stale holder that was observed. Route: delegated direct
  (same writer, sequential after T1). Commit `995f56e`.

## Acceptance criteria
- A reclaim whose observed row is stale (another process already re-claimed the
  node) does not overwrite the new claim, on both backends.
- A takeover whose observed reservation was replaced does not delete the new one,
  on both backends; exactly one dispatcher proceeds.
- `npm test` fully green under Node v22.

## Checks
- New RED→GREEN tests per task (backend-level and engine/dispatch-level).
- `npm test` (Node v22).

## TDD
Mode: strict (source: session config "Strict TDD Mode: enabled"). Runner:
`node --test` via `npm test`, Node v22.

## Delivery
Forecast ~250 authored changed lines. Strategy: `ask-on-risk` (default).
Branch `fix/concurrency-reclaim-and-dispatch-takeover` off `dev`.

## Progress / evidence

### T1 — orphan reclaim CAS
- Files: `src/storage/sqlite.mjs` (new `reclaimOrphanedWorkflowNode` primitive,
  sqlite `RECLAIM_ORPHANED_WORKFLOW_NODE_SQL` + JSON critical-section
  counterpart), `src/storage/index.mjs` (export), `src/workflow/engine.mjs`
  (`reclaimOrphanedNode` exported and rewritten to use the CAS primitive
  instead of the unconditional `transitionNode` UPSERT), plus tests.
- RED (backend-level, `test/storage-workflow-node-reclaim.test.mjs`, function
  not yet exported): `SyntaxError: The requested module
  '../src/storage/index.mjs' does not provide an export named
  'reclaimOrphanedWorkflowNode'` — 1 fail.
- RED (engine-level, `test/workflow-orphan-reclaim.test.mjs`, before
  `reclaimOrphanedNode` was exported/rewritten): `SyntaxError: ... does not
  provide an export named 'reclaimOrphanedNode'` — 1 fail.
- GREEN: `test/storage-workflow-node-reclaim.test.mjs` 4/4 (sqlite + json,
  happy path and lost-CAS path); `test/workflow-orphan-reclaim.test.mjs` 3/3
  (original 2 + new interleaving test simulating P1 reclaim+claim between P2's
  read and P2's reclaim: P2's stale write is now a no-op, P1's claim survives).
- Also re-ran `test/workflow-engine.test.mjs`, `test/chaos/*.test.mjs`,
  `test/workflow-transitions.test.mjs`, `test/c11-engine.test.mjs`,
  `test/a7-gaps.test.mjs`: 41/41, no regression (double-scheduler CAS-claim
  test included).
- Commit: `433158b` "fix(workflow): make orphan reclaim a compare-and-set so a
  stale read cannot clobber a new claim".

### T2 — dispatch-key takeover CAS
- Files: `src/storage/sqlite.mjs` (`releaseDispatchReservation` now accepts an
  optional `expectedJobId` — sqlite `DELETE ... AND job_id IS ?`, JSON
  critical-section equivalent; omitting it keeps the old unconditional
  release for existing callers), `src/dispatch.mjs` (takeover loop: release is
  conditional on the observed `existingJobId`, and on a lost CAS the loop
  re-reserves and re-evaluates the new holder instead of proceeding as owner;
  the `finally` owner-cleanup release is now conditional on `execId` so an
  owner can never delete a takeover's reservation), plus tests.
- RED (backend-level, `test/storage-reservation.test.mjs`, before the
  conditional delete existed): `a conditional release with the wrong jobId
  must not delete the row — true !== false` (`AssertionError`, expected
  `false`, actual `true`) — 2 fails (sqlite + json).
- RED (dispatch-level, `test/dispatch-reservation.test.mjs`, real two-process
  race against unpatched `dispatch.mjs`, reproduced on the 3rd of 3 runs since
  it's a genuine OS-scheduling race): `exactly one dispatcher may take over
  the stale key, got 2` (`AssertionError`, expected `1`, actual `2`).
- GREEN: `test/storage-reservation.test.mjs` 12/12; `test/dispatch-reservation.test.mjs`
  new "two waiters" test held GREEN across 5 consecutive runs; full
  `test/dispatch-reservation.test.mjs test/storage-reservation.test.mjs
  test/storage-reservation-race.test.mjs test/dispatch.test.mjs
  test/dispatch-waitmode.test.mjs test/dispatch-agys.test.mjs
  test/c11-dispatch-handle.test.mjs` 50/50, no regression.
- Commit: `995f56e` "fix(dispatch): take over a stale dispatch key only if it
  still belongs to the observed holder".

### Full suite
`npm test` (Node v22): **1364 pass / 0 fail** (baseline was 1354; +10 new
tests across the two tasks — no baseline test broke).

Engram mirror (`odd/concurrency-reclaim-and-dispatch-takeover/tasks`): **PENDING** —
Engram rejects saves in this session (multiple active runtime sessions match).

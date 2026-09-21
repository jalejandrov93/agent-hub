# claim heartbeat — stop mistaking a slow node for a dead owner

## Objective
Keep a node's lease honest while a job is genuinely running, so a peer scheduler
distinguishes "slow but alive" from "dead" instead of preempting live work.

## Why
`updated_at` was written once, at claim time, and only ever refreshed by a status
transition. Any job running longer than `CLAIM_LEASE_TTL_MS` (30s) therefore looked
like a dead owner:
- a peer scheduler running the same workflow reclaimed it and executed the node a
  second time (measured: the peer stole it and dispatched);
- the stall bound counted a live, heartbeating-free node as "no progress".

## Scope
`src/storage/sqlite.mjs`, `src/storage/index.mjs`, `src/workflow/engine.mjs`,
`test/workflow-node-heartbeat.test.mjs`, `test/workflow-orphan-reclaim.test.mjs`.

## What changed
- `touchWorkflowNode(ctx, { workflowId, stepId, at })` in both backends: updates
  **only** `updated_at`, refuses terminal rows (a heartbeat can never resurrect a
  node an external actor finalized). The JSON path uses `updateJsonLocked`.
- The wave wraps `executeNode` in `startNodeHeartbeat` (interval
  `heartbeatMs`, default `max(1000, leaseTtlMs/3)`; interval `.unref()`d and
  cleared in a `finally`, a failed heartbeat never breaks the run).
- The stall bound counts a **fresh lease on any non-terminal node as progress**:
  a live owner keeps the run waiting instead of failing it; when the lease goes
  stale and nothing changes, the bound still fires.

## Acceptance criteria
- The lease timestamp advances while a job runs.
- A peer scheduler does not dispatch a node whose owner is heartbeating; it
  observes the owner finishing.
- A node nobody can claim (stale foreign claim on a READY row) still fails bounded
  with `workflow.stalled` instead of hanging.

## Verification
- `test/workflow-node-heartbeat.test.mjs` — RED: lease constant across three samples;
  the peer stole the node. GREEN: lease advances; peer dispatches 0 and observes success.
- `test/workflow-orphan-reclaim.test.mjs` — retargeted to the residual state
  (READY + stale foreign claim) because a *fresh* lease now correctly means "alive".
- workflow + chaos + storage: 93/93; `npm test` 1349/1349/0; dashboard 176/176 +
  typecheck clean; `node bench/run.mjs` ok.

## Deferred
- A READY row carrying a stale foreign claim is not self-healed (reclaim only
  re-queues running/waiting); the stall bound reports it instead. Clearing the
  claim would need a `claimed_by`-only write, deliberately left out of this change.
- The other JSON store writers still write unlocked (separate pending item).

Engram mirror (`odd/claim-heartbeat/tasks`): **PENDING** — Engram rejects saves
(multiple active runtime sessions match this project and directory).

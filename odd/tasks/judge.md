# ODD Feature: C4 — Judge / Revision Loop

## Objective

Turn the C3 verdict into a decision and, when the decision is `needs_revision`,
re-dispatch the worker and try again:

```
implementation -> verification -> judge -> accepted
                                     |-> needs_revision -> worker -> verification -> judge
                                     |-> rejected
                                     |-> blocked
```

## Problem

C3 records a truthful verdict but stops there: `verified: false` either fails
the node (when `required: true`) or is recorded and ignored. Nothing decides
whether the failure is worth another attempt, and nothing feeds the failing
checks back to the worker.

## Why now

The roadmap's stated payoff is `plan -> execute -> verify -> judge -> revise ->
verify -> accept`. C4 is what makes the workflow self-correcting. The README
already reserves `onSuccess`/`onFailure` on nodes for "the future judge (C4)".

## Scope

In scope:
- `src/judge.mjs`: `judgeVerdict(...)` -> `{ verdict, reason, revision,
  maxRevisionAttempts, required, failed }` with verdicts
  `accepted | needs_revision | rejected | blocked`.
- `src/workflow/schema.mjs`: optional `node.maxRevisionAttempts` (default 0,
  opt-in).
- `src/workflow/engine.mjs`: a revision loop around dispatch -> wait -> verify
  -> judge. `needs_revision` re-dispatches with the failing checks as feedback
  and increments the revision; `accepted` succeeds; `rejected`/`blocked` fail
  the node when `required: true`, otherwise end `succeeded` with the verdict
  recorded. Persists `judge.json` next to `verification.json` and carries the
  verdict on the node result + events.
- Tests: `test/judge.test.mjs` (pure) and `test/workflow-judge.test.mjs`
  (integration).
- Docs: README + CHANGELOG.

Out of scope (explicit follow-ups):
- A model-based judge. The decision here is deterministic over the C3 verdict;
  the escape hatch for semantic acceptance criteria remains an `argv` check.
- Wiring `onSuccess`/`onFailure` payloads (still reserved).
- Persisting revision history beyond the final verdict.

## Decision rules (deterministic)

- No verification configured -> `accepted` ("no verification configured").
- `verified: true` -> `accepted` ("all checks passed").
- `verified: false`:
  - a failed `artifact` check whose ref points to a DIFFERENT step
    (upstream evidence the node cannot produce itself) -> `blocked`;
  - else, `revision < maxRevisionAttempts` -> `needs_revision`;
  - else -> `rejected`.
- `required` is echoed for the engine; it never changes the verdict.

## Constraints

- Pure module: no filesystem, no process, no clock in the decision.
- Additive: default `maxRevisionAttempts: 0` means a node with `verify` behaves
  exactly as in C3 unless it opts into revisions.
- Strict TDD: failing test first, observed RED, then GREEN.

## Resolved TDD

- Mode: `on`. Runner: `node --test <file>` (repo script `npm test`).

## Delegation route

- T1/T2: delegated writer (`agy`, `gemini-3.8-flash-high`, `mode: write`) in
  `/home/alejandro/Desarrollo/agent-hub-worktrees/c4-judge`. No Claude.

## Tasks

| ID | Task | Route | Evidence |
|----|------|-------|----------|
| T1 | `src/judge.mjs` + `test/judge.test.mjs` | delegated writer | RED then GREEN |
| T2 | schema + engine revision loop + `test/workflow-judge.test.mjs` | delegated writer | RED then GREEN |
| T3 | README + CHANGELOG | inline | diff read-back |

## Acceptance criteria

- `judgeVerdict` implements the rule table above exactly and returns every
  verdict for the right input; `blocked` wins over a revision still being
  available.
- `JUDGE_VERDICTS` is frozen and exported.
- Engine: with `maxRevisionAttempts: 2` and checks failing twice then passing,
  the worker is dispatched 3 times and the node ends `succeeded` with
  `judge.verdict === 'accepted'` and `revision === 2`.
- Engine: revisions exhausted -> `judge.verdict === 'rejected'`; with
  `required: true` the node ends `failed`, with `required: false` it ends
  `succeeded` with the verdict recorded.
- Engine: `blocked` (upstream artifact) fails immediately without burning
  revisions.
- `judge.json` and `verification.json` are written per attempt; the verdict
  travels on `job.finished`/`job.failed`.
- Full suite green apart from the documented pre-existing flake/cancellations.

## Checks

- `node --test test/judge.test.mjs`
- `node --test test/workflow-judge.test.mjs`
- `npm test`

## Progress log

- 2026-09-20: feature doc created; worktree + branch `feat/c4-judge`
  (stacked on `feat/c3-verifier`, PR #11).
- 2026-09-20: **T1 done** — `src/judge.mjs` + `test/judge.test.mjs` (12 tests).
  Verified: 12 pass / 0 fail. Commit `28a0202`.
- 2026-09-20: **T2 done** — `NodeSchema.maxRevisionAttempts`, engine revision
  loop (needs_revision re-dispatches with attempt reset, no backoff;
  rejected/blocked terminal only when required), `judge.json` artifact, verdict
  on node result/events, `test/workflow-judge.test.mjs` (4 tests). C3's 4 tests
  still green. Verified: 20/20 targeted; `npm test` 1049 pass / 0 fail /
  8 pre-existing cancelled.
- 2026-09-20: **T3 done** — README layout + "C4 judge and revision loop"
  section + CHANGELOG. Feature complete.

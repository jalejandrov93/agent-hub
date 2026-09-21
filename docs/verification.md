# Verification

## Evidence artifacts

Execution success is not task success, and an opaque `response.txt` is not
evidence. A node can declare the evidence files it must produce, and
downstream nodes consume them by reference instead of by inlining a whole
response.

```js
{
  id: 'implementation',
  type: 'delegate',
  agent: 'opencode',
  model: 'deepseek/deepseek-v4-flash',
  mode: 'write',
  artifacts: ['plan.md', 'diff.patch', 'test-report.json'],
  task: 'Implement the feature. Baseline brief: artifact://research/plan.md',
}
```

- The engine creates `runs/<workflowId>/<stepId>/artifacts/` and appends the
  absolute path plus the exact filename list to the dispatched task, so the
  agent writes real files there instead of burying everything in prose.
- A task may reference an upstream artifact with
  `artifact://<workflowId>/<stepId>/<name>`; the engine inlines its content
  (capped at 64 KiB per ref, marked when truncated) before dispatch. An
  unresolved ref fails the node with `unresolved artifact ref: <ref>` rather
  than silently handing the literal token to a model.
- On success the engine writes `artifacts.manifest.json` next to the directory
  with per-name `present`/`missing`, bytes and sha256, and the same manifest
  travels on the `job.finished` event.
- The store is path-safe (every segment validated against the same shape
  `jobstore` uses for job ids) and writes atomically. A declared file that is
  missing is recorded, not yet fatal — enforcement belongs to the verifier
  (C3).

## Verifier

A node reaching a terminal success only means the CLI finished. A node can
declare deterministic checks, and the engine records a verdict next to the
result:

```js
{
  id: 'implementation',
  type: 'delegate',
  artifacts: ['diff.patch', 'test-report.json'],
  verify: {
    required: true,
    checks: [
      { name: 'tests', argv: ['npm', 'test'] },
      { name: 'typecheck', argv: ['npm', 'run', 'typecheck'] },
      { name: 'evidence', artifact: 'test-report.json' },
      { name: 'scope', forbid: ['src/generated'] },
    ],
  },
}
```

- Three check kinds, all deterministic and shell-free: `argv` (run a command,
  pass on the expected exit code), `artifact` (a C2 evidence file must exist,
  optionally from another step via `from`) and a diff/`forbid` check (`git diff
  --name-only` must not touch those path prefixes).
- The verdict is `{ verified, required, checks, startedAt, finishedAt }`. It is
  written to `runs/<workflowId>/<stepId>/artifacts/verification.json`, travels
  on `job.finished`/`job.failed`, and is mirrored best-effort onto the job
  record's `verified` column.
- `required: true` makes a failed verdict fatal: the node ends `failed` with
  `verification failed: <checks>` and the verdict attached, and the retry loop
  is skipped — a deterministic failure is not a transient one. With the default
  `required: false` the node still succeeds and the verdict is simply the truth
  a later judge acts on.
- C3 produces the verdict; it does not revise. Turning `needs_revision` into a
  re-dispatch is C4's job. There is no shell string anywhere: checks are argv
  arrays run through the same `runCommand` the rest of the hub uses.

## Judge and revision loop

A verification verdict is data; the judge turns it into a decision and, when
the decision is `needs_revision`, the engine tries again:

```
implementation -> verification -> judge -> accepted
                                    |-> needs_revision -> worker -> verification -> judge
                                    |-> rejected
                                    |-> blocked
```

```js
{
  id: 'implementation',
  type: 'delegate',
  maxRevisionAttempts: 2,
  verify: { required: true, checks: [{ name: 'tests', argv: ['npm', 'test'] }] },
}
```

- Decision rules are deterministic over the C3 verdict: no verification or
  `verified: true` -> `accepted`; a failed `artifact` check whose ref points to
  **another** step (upstream evidence the node cannot produce itself) ->
  `blocked`; otherwise `revision < maxRevisionAttempts` -> `needs_revision`,
  else `rejected`.
- `needs_revision` resets the attempt counter and re-dispatches the worker
  against the same node, with no backoff and up to `maxRevisionAttempts` times
  (default `0`, so a node without it behaves exactly as in C3).
- `rejected`/`blocked` fail the node only when `verify.required` is true;
  otherwise the node still `succeeded` and the verdict is the truth. A
  `blocked` verdict short-circuits: no revision is burned on an upstream
  failure the node cannot fix.
- The verdict is `{ verdict, reason, revision, maxRevisionAttempts, required,
  failed }`, written to `artifacts/judge.json` next to `verification.json`, and
  carried on the node result and on `job.finished`/`job.failed`.
- When `needs_revision` triggers, `buildRevisionFeedback` (`src/revision.mjs`)
  formats a bounded feedback block (`<agent-hub-revision>`) containing failed
  check names and specific failure findings, capped at `REVISION_LIMITS` (max 3
  findings, max 300 characters each) and instructs "Do not change unrelated
  files." This feedback is prepended to the task prompt on re-dispatch.


# Execution Contract (A0)

Normative invariants for job execution. `MUST` = contract (some fields are
target state for later slices); file:line refs ground what already exists.

## 1. Deadline semantics

- Four independent clocks: `startup` (spawn/session-create), `execution`
  (CLI run / remote session), `idle` (no stdout/activity), `remote-watcher`
  (local poll budget). They never share a timer.
- Effective timeout: explicit wins (`src/timeouts.mjs:34`); else
  `clamp(adaptive_p95 * multiplier, min=static_default, max=capS)` where
  adaptive only ever RAISES the static default (`src/timeouts.mjs:58-66`,
  `src/config.mjs:52`; defaults `src/config.mjs:87-109`).
- Local kill = `timeoutS + KILL_GRACE_S` (`src/jobrunner.mjs:182-186`,
  `src/config.mjs:73`); grace lets agy exit with partial output first.
- **Local-deadline ≠ remote-failure.** A local timeout stops OUR polling and
  records `pollingStoppedReason: local_deadline`; only the remote session's
  own state finalizes the job (`src/cloud/runner.mjs:81-97`).
- Resume after deadline still does one final bounded poll (60s) to learn the
  real outcome instead of failing on the clock (`src/cloud/runner.mjs:564-579`).
- Per-attempt backoff: attempt n waits `base * {1x, 1.5x, 2x}[min(n,3)]`;
  remote poller backs off `5s -> 60s ceiling, factor 1.5`, resets on new
  activity (`src/cloud/poller.mjs:4-6`, `src/cloud/poller.mjs:30-38`).

## 2. Cancellation

- **LOCAL CANCEL WINS.** `cancelJob` marks `canceled` BEFORE killing, so the
  racy `finishJob` no-ops and never resurrects the job (`src/jobrunner.mjs:306-317`,
  `src/jobrunner.mjs:214-215`); `updateResult` merges but never flips
  `canceled` -> terminal-other (`src/jobstore.mjs:129-139`). Local kill is
  SIGTERM->SIGKILL over the whole process group (`src/process.mjs:35-54`).
  Final state is `canceled`, no retry.
- **REMOTE NO-GUARANTEE.** No `sessions/{id}:cancel` exists upstream; cancel
  marks the LOCAL record `canceled` and stops polling — the remote session
  MAY keep running (`src/jobrunner.mjs:319-335`, `src/index.mjs:264`).
  `remote.sessionId/sessionUrl` MUST be preserved on the record for later
  `jules_check` reconciliation. Poller checks `canceled` before the clock so
  a canceled job never spends quota (`src/cloud/poller.mjs:170-186`).

## 3. Retry / resume / fallback / escalation

- `ExecutionPolicy { retry, resume, fallback, escalation }` travels with every
  dispatch; each dimension is independent and bounded.
- `retry`: same agent+model, fresh attempt id, per-attempt backoff (§1).
  Never retries `canceled`, `worktree_denied`, `read_mode_violation`, `auth`.
- `resume`: same `sessionId` (local CLI conversation, `src/jobrunner.mjs:233`)
  or same `remote.sessionId` (Jules `job_reply`); resumes do NOT consume a
  retry attempt.
- `fallback`: router `primary + fallbacks[]` chain (`src/router.mjs:169-221`);
  codex is LAST fallback only, never primary (`src/config.mjs:185-190`).
  Preflight L0-L2 gates each candidate; breaker opens on ≥2 quota/canceled
  failures in 30m, billing opens immediately (`src/preflight.mjs:79-83`,
  `src/config.mjs:57-65`).
- `escalation`: only on explicit policy (e.g. repeated `quota` after
  `MAX_ACCOUNT_ATTEMPTS=3`, `src/cloud/runner.mjs:22-23`); escalation MUST
  carry `parentExecutionId/rootExecutionId` (§4).

## 4. Idempotency

- `dispatchKey = sha256(task + cwd + taskType + workflowStep)`; re-dispatch
  with the same key MUST return the existing job, never spawn a duplicate.
- Identity chain: `executionId` (this attempt), `attempt` (n of N),
  `parentExecutionId` (retry/resume parent), `rootExecutionId` (first cause).
  `jobstore.createJob` persists all four alongside `parentJobId/sessionId`
  (`src/jobstore.mjs:58-104`).
- Remote creation reconciliation: before `createSession`, compute fingerprint
  `(repo, branch, task-hash, title, time-window)` and search `listSessions`;
  a match re-adopts instead of creating. Startup re-adopts `running` remote
  jobs with keys and skips unkeyed ones without failing them
  (`src/cloud/runner.mjs:515-562`); local orphans reconcile by pid, remotes
  are never judged by pid (`src/jobstore.mjs:182-195`).

## 5. Read purity / write ownership

- Read purity: snapshot AFTER gate+lock, diff at terminal transition; a
  modifying `read` job fails as `read_mode_violation` (output kept for
  inspection), non-git cwd = `unverifiable`, never a violation
  (`src/jobrunner.mjs:156`, `src/jobrunner.mjs:226-286`,
  `src/readguard.mjs:51-107`). `.env` / `JULES_API_KEY` never reach child
  CLIs (`src/jobrunner.mjs:160-161`).
- Write ownership: `mode:write` requires secondary `git worktree add`
  checkout or allowlist (`src/worktree.mjs:39-54`); single-writer lock per
  cwd via atomic `wx` create + stale-pid reclaim (`src/worktree.mjs:77-101`).
  JSON state merges via token-owned `updateJsonLocked`
  (`src/fsutil.mjs:149-164`, `src/fsutil.mjs:171-178`). Remote jobs never
  take the local lock (`src/jobrunner.mjs:63-92`).

## 6. Local vs remote state

- Local `job.status ∈ {queued, running, succeeded, failed, canceled}`
  (`src/jobstore.mjs:81-104`) is OUR bookkeeping; remote
  `{state, stateSince, lastActivityAt, polling}` is THEIR truth.
- Remote block: `state` (last `getSession`), `branch/prUrl` (sticky, never
  erased by a null tick), `activityCursor/seenActivityIds` (bounded dedup),
  `pollingStopped{At,Reason}` (`src/cloud/poller.mjs:111-145`,
  `src/cloud/runner.mjs:444-466`).
- Terminal remote = `COMPLETED/FAILED` state, never timeout/error-budget
  (`src/cloud/poller.mjs:226-233` -> `src/cloud/runner.mjs:88-97`).

## 7. Watch ownership (Model A, confirmed — implemented for B4)

- `jules_interact`/`job_reply` on a Jules parent NEVER restart a poller.
  Model A (confirmed): `jules_interact`/`job_reply` deliberately DO NOT clear
  `pollingStoppedReason`; they leave it for the next observation (e.g.
  `jules_wait`/`jules_check`) to clear. After an interaction the session is
  unobserved until the caller observes it or a supervisor owns it.
- B4 `jules_supervise` formally acquires observation ownership, not just
  `check → reply → return`: Supervisor = observe → decide → interact →
  resume-observation.
- Lease shape:
  `remote.watch = {owner: 'supervisor' | 'jules_wait' | null, generation: N}`.
  A new owner bumps `generation`; a stale generation stops writing. This keeps
  a supervisor and a concurrent `jules_wait` from driving the same session.
- `jules_wait` respects the lease: read-only observation while a supervisor
  owns the watch.

## 8. C0-real gate (C1 stays blocked until this lands)

- C0 schema (SQLite WAL tables + nullable `JobRecord` columns) is groundwork,
  not foundation: `src/storage/` is still a parallel layer, `result.json` /
  `jobstore` remains the operational source of truth.
- Exit gate for C1 DAG (not yet landed): `initDb` is not yet called at startup
  and `better-sqlite3` is not yet a runtime dependency. SQLite will eventually
  be in the execution path (dual-write or write-through for jobs/workflows/leases).

## 9. Harness profiles & waitMode

- `src/harness/` maps the calling harness to a default wait contract:
  `generic` (none — return at create/start), `claude-code` / `opencode`
  (attention — return at terminal OR waiting/attention).
- `dispatch()` accepts `waitMode` (`none`|`attention`|`terminal`); an
  explicit value always beats the profile default. Resolution priority:
  explicit > `AGENT_HUB_HARNESS` env > MCP client hint > generic.
- The MCP client hint (from `clientInfo.name` at the handshake) is
  default-only: it never overrides an explicit harness/env/waitMode and
  never decides anything security-sensitive. `delegate()` never waits.
- `harness` + `waitMode` travel on the dispatch result, the job record, and
  `job.started` / `job.finished` / `job.failed` events (informational only).

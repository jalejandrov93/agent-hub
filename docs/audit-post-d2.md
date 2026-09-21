# Audit — Post D2 (dev @ `fabcbc2`, 2026-09-21)

Deep technical audit of `dev` after C2/C3/C4, D1/D2/D3, C2b, C3b, C4b, E1/E2, F1/F2, G and H.
Method: three read-only auditors over the real code plus targeted re-verification by
the orchestrator. **`[verified]`** = the orchestrator confirmed it in code this session;
**`[reported]`** = an auditor found it with file:line evidence but it was not re-verified.

Convention: **P0** = correctness or data-safety risk; **P1** = contract/consistency risk;
**P2** = debt.

---

## 1. Executive Summary

Agent-Hub is now a coherent execution/orchestration layer: the evidence pipeline
(artifacts → verifier → judge → revision) is real and bounded, handoffs and
artifacts are genuinely consumed by downstream nodes, the provider-profile
integration works end-to-end against the installed `agys`, and the reliability
suite (bench + chaos) is deterministic and offline.

The audit found **no architectural dead-end**, but it did find a **small set of
real defects** and one **deliberate design divergence worth a decision**:

- Three confirmed defects were fixed immediately on the `stage` branch (default
  agys mode, inverted profile priority, unscoped messaging inbox) plus two
  consistency fixes (declared emitter kinds, workflow lineage).
- The largest remaining divergence is **`delegate()` bypassing `dispatch()`**, which
  the A1 contract documents as intentional ("exact execution") but which means the
  most-used MCP entry point has **no execution-time breaker check, no idempotency
  and no lineage**. A concrete unification proposal is in §4.
- OpenCode v2 was **re-verified against the installed server's OpenAPI** and the
  bridge is **correct** (see §9).

---

## 2. Real Architecture State

| Area | Status | Evidence |
|---|---|---|
| A0 execution contract | DONE | `docs/execution-contract.md` |
| A1 `dispatch()` | DONE | `src/dispatch.mjs` |
| A1 `delegate()` | **INCORRECT (bypass)** | `src/tools/jobs.mjs:244` `[verified]` |
| A2 taxonomy / A3 policy | DONE | `src/policy/*` |
| A4 breakers by class | **TECHNICAL_DEBT** | `src/breakers.mjs` unwired in router/dispatch `[reported]` |
| A5 sandbox profiles | PARTIAL (documented) | `src/sandbox.mjs`, `docs/security-isolation.md` |
| A6 worktree leases | DONE (fs) / PARTIAL (db) | `src/worktree.mjs` `[reported]` |
| C0-real SQLite | PARTIAL (staged) | `src/storage/*`, `AGENT_HUB_STORE` `[verified]` |
| C0.5 events | DONE (kinds fixed on `stage`) | `src/notify/*` |
| C1 DAG + C1.1 + C1.2 | DONE | `src/workflow/*` |
| C2 artifacts / C3 verifier / C4 judge / C4b revision | DONE | `src/artifacts.mjs`, `verify.mjs`, `judge.mjs`, `revision.mjs` |
| C2b handoffs + roles | PARTIAL (roles not enforced) | `src/handoff.mjs`, `src/context.mjs`, `src/roles.mjs` `[reported]` |
| D1 quality/cost metrics | DONE | `src/metrics.mjs` |
| D2 provider profiles / agys | DONE (fixes on `stage`) | `src/providers/*` |
| D3 adaptive routing | PARTIAL (no sample gate, no quota) | `src/routing/score.mjs` `[reported]` |
| E1 harness bridge | DONE (default off) | `src/harness/bridge.mjs`, `opencode-bridge.mjs` |
| E2 notifications | DONE | `src/notify/policy.mjs` |
| F1 planner | PARTIAL (bounds) | `src/planner/*`, `src/tools/planner.mjs` `[reported]` |
| F2 execution graph | **INCORRECT (lineage)** — fixed on `stage` | `src/execution-graph.mjs`, `src/workflow/engine.mjs` `[verified]` |
| G bench + chaos | DONE | `bench/`, `test/chaos/` |
| H.1–H.3 + H.4 doc | DONE | `src/sandbox.mjs`, `docs/security-isolation.md` |
| Messaging | PARTIAL (tenancy fixed on `stage`) | `src/tools/messaging.mjs` `[verified]` |

---

## 3. Critical Findings

### P0-1 — `delegate()` bypasses the control plane `[verified]`
- **Severity** P0 · **Status** INCORRECT (documented as intentional for A1)
- **Evidence** `src/tools/jobs.mjs:2,131,244`; `src/index.mjs:417-422`; `docs/execution-contract.md` ("delegate = exact execution")
- **Current** `delegateTool()` calls `startJobFn(...)` directly. It never calls `dispatch()`, so it gets no **execution-time** breaker/preflight revalidation, no `dispatchKey` idempotency, no `executionId`/`rootExecutionId` lineage, and no `ExecutionHandle`.
- **Expected** one operational route with an explicit policy opt-out, not a second implementation.
- **Risk** duplicate in-flight delegations, lineage holes in the graph, fatal `billing`/`auth` states not short-circuited at execution time.
- **Recommendation** make `delegateTool` a thin wrapper over `dispatch({ candidate: { agent, model }, waitMode: 'none', ... })` and unwrap the result into today's return shape (`{ jobId, status, errorKind }`). No caller changes; tests must be updated to assert the return shape is preserved.
- **Tests existing** `test/tools-jobs.test.mjs`, `test/server-v2.test.mjs`
- **Tests missing** delegate trips an open breaker; delegate honours `dispatchKey`; delegate populates lineage.

### P0-2 — inverted agys profile priority `[verified]` — **fixed on `stage`**
- **Evidence** `src/providers/profiles.mjs:120-122`
- **Current** `byPriority` sorts ascending, so priority `5` wins over `10`.
- **Expected** agys documents "higher number = higher priority"; the `priority` policy must prefer the highest.
- **Risk** the primary account is drained last.
- **Fix** descending sort + updated test.

### P0-3 — messaging inbox was not root-scoped `[verified]` — **fixed on `stage`**
- **Evidence** `src/tools/messaging.mjs:106-111`
- **Current** `agentInboxTool` allowed omitting `rootExecutionId`, listing a recipient's messages across **every** root.
- **Expected** strict tenancy: the root is mandatory (as in `agent_send_message`).
- **Risk** cross-workflow message leakage / prompt injection.
- **Fix** require `rootExecutionId`; added a cross-root isolation test.

### P0-4 — workflow lineage severed `[verified]` — **fixed on `stage`**
- **Evidence** `src/workflow/engine.mjs:523,630` (dispatchFn calls)
- **Current** the engine never passes `rootExecutionId`/`parentExecutionId`, so each workflow job becomes its own root and `buildExecutionGraph` returns orphan roots with **zero edges**.
- **Expected** every workflow job shares `rootExecutionId = workflow.id`; a dependent node's parent is its dependency's job.
- **Fix** pass the root (and the first dependency's jobId as parent); fanout children get the root only (documented limitation).

### P1-1 — per-class circuit breakers are defined but not used by router/dispatch `[reported]`
- **Evidence** `src/breakers.mjs:51-84`, `src/router.mjs:1`, `src/dispatch.mjs:7`
- **Current** both import the legacy generic breaker from `preflight.mjs`; the taxonomy-aware table (`CIRCUIT_BREAKER_BY_CLASS`) is ignored, so `billing`/`auth` do not trip immediately.
- **Recommendation** re-export the by-class breaker and use it in `router`/`dispatch`.

### P1-2 — cross-process `dispatchKey` idempotency is in-memory only `[reported]`
- **Evidence** `src/dispatch.mjs:154,503-518`
- **Current** dedup uses an in-process Map; two processes can both spawn the same key.
- **Recommendation** a SQLite reservation row with `UNIQUE(dispatch_key)` before spawning.

### P1-3 — write-job fallback can double-apply `[reported]`
- **Evidence** `src/dispatch.mjs:643-770`, `src/policy/executor.mjs:43-56`
- **Current** when a write candidate fails mid-run, recovery picks the next candidate in the **same worktree** without checking or rolling back partial edits.
- **Recommendation** on write fallback, verify the worktree is clean (or reset to the pre-dispatch HEAD) before the next candidate; refuse otherwise.

### P1-4 — roles are contracts in name only `[reported]`
- **Evidence** `src/roles.mjs:20-93`, `src/workflow/schema.mjs` (no `role`), `src/planner/plan.mjs:134`
- **Current** roles only influence planning (capabilities → requirements, a handoff schema). The engine never validates `acceptance`, and nothing enforces capabilities at runtime.
- **Recommendation** carry `role` on the node and surface `acceptance` to the verifier (as human-readable expectations), without turning roles into mega-prompts.

### P1-5 — fanout children are starved of upstream handoffs `[reported]`
- **Evidence** `src/workflow/engine.mjs:611-625`
- **Recommendation** inject the upstream handoffs into fanout child tasks (the delegate path already does).

### P2 — planner bounds, routing sample gate, dashboard dead routes, mock fidelity
- Planner: `planTaskTool` bypasses `maxSteps` for an explicit plan; no `maxDepth`/`maxFanout`/`budget` `[reported]`.
- Routing: empirical scoring is applied at `N=1` (no minimum sample gate) and quota/profile are not part of the candidate `[reported]` — directly relevant to §8.
- Dashboard: `views/tools/` is orphaned after the `/config?section=tools` redirect `[reported]`.
- Tests: `opencode-bridge.test.mjs` uses a fake fetch; `worktree-lease.test.mjs` is single-process CAS; some job promises in `jobrunner.test.mjs` are not awaited `[reported]`.

---

## 4. Control Plane Findings

`dispatch()` is the only path that carries the full contract (preflight revalidation, policy, breakers, idempotency, lineage, harness/waitMode, ExecutionHandle). `delegate()` reaches `startJob` directly.

**Proposal (no caller breakage):** keep `route()` advisory and `delegate()` "exact execution", but implement `delegate()` **as** `dispatch()` with `waitMode: 'none'` and an explicit `policy: 'none'`-style opt-out, so there is one engine and one place where breakers/idempotency/lineage live. `delegate`'s documented promise (returns at creation, no waiting) is preserved by `waitMode: 'none'`.

---

## 5. Workflow Findings

- State machine: `[reported]` the engine mutates `workflow_nodes.status` via `upsertWorkflowNode` at several sites instead of `transitionNode()`, so `assertValidTransition` does not guard normal execution. `transitionNode` is then effectively dead inside the engine. This is real debt but **not** a correctness bug: the engine only writes legal transitions. Recommendation: funnel them through `transitionNode()` so future lifecycle hooks and guards apply.
- `waiting` ≠ `failed`, `local timeout` ≠ `remote failure`: `[verified]` correct in code.
- Node success only on a terminal outcome: `[verified]` correct (`pendingJobHandle` + `waitForHandleTerminal`).

---

## 6. Context / Artifacts / Verification / Judge

- Handoff pipeline: `[verified]` real — normalized, bounded (4 k summary / 20 items × 2 k), persisted in SQLite, rehydrated on resume, readable from conditions. It is transferred downstream as a **bounded prompt block**, which is the intended design (durable context in SQLite, content on disk).
- Verifier/Judge: `[verified]` judge consumes the verifier, distinguishes `blocked` (upstream artifact missing) from `rejected`, the bounded revision feedback reaches the **next** dispatch (not the same prompt), the verdict is persisted, and revisions are bounded by `maxRevisionAttempts`.
- Clean separation: **message** = ephemeral coordination (root-scoped, 1:1, capped); **handoff** = durable task context (SQLite + `handoff.json`); **artifact** = durable large content (`artifact://`). No harmful overlap found.

---

## 7. Provider Profiles / agys

- The integration is an **adapter** over `agys` for CLI profiles; the multi-account *policy* engine (priority/least_used/round_robin) is our own — acceptable, but note agys itself also selects profiles (`agys use auto`); we chose hub-side selection to keep routing decisions in one place. Document this boundary.
- `[verified]` safe degradation with no agys; `[verified]` end-to-end wrapping works (`agys run <profile> -- agy`) after the effort-suffix fix.
- `[reported]` no automatic profile failover on 429 (the profile is memoised per dispatch).
- `[reported]` write double-apply risk on candidate fallback (see P1-3).

---

## 8. Adaptive Routing

`[verified]` requirements/capabilities are a hard filter and quality/latency/cost are scored deterministically with a no-data fallback. `[reported]`:
- no minimum sample gate before empirical metrics may reorder;
- quota/profile are not part of the candidate, so **agent ranking and profile selection are two separate decisions**.
- Recommendation: keep the scoring deterministic and human-gated, but introduce a `Candidate { provider, agent, model, profile }` **only if** it simplifies the call chain; and gate empirical reordering behind `METRICS_MIN_SAMPLES`.

---

## 9. OpenCode V2 — VERIFIED AGAINST THE INSTALLED API ✅

**Result: `session.prompt` path and body are CORRECT as implemented.**

Triple evidence:
1. **Installed server OpenAPI** (`GET /openapi.json`, 113 paths): `POST /api/session/{sessionID}/prompt`, operationId `session.prompt`, summary "Send message", description *"Durably admit one session input and schedule agent-loop execution unless resume is false"*.
2. **Body schema**: `required: ['text']`; properties `id, text, files, agents, skills, metadata, delivery, resume`; `resume` is `boolean|null`; `additionalProperties: false`. Our bridge sends `{ text, resume: true }` → schema-valid.
3. **Live server**: the authenticated `POST /api/session/<id>/prompt` returned **200**; `GET /api/info` returns `{ version: 2.0.11, pid, urls }`; `GET /api/session` lists sessions.
4. **Official docs** (`/v2/docs/build/client`): the SDK exposes `client.session.prompt({ sessionID, text })` and `Service.headers(endpoint)`.

**Correction to the report we received:** `/session/:id/message` and `/prompt_async` do **not** exist on the installed v2.0.11 server (not in the 113-path spec). The bridge is not wrong.

**Gap (P2):** the bridge test uses a fake fetch; it should additionally smoke-test against the loopback server (auth + 200) — that is the one thing mocks cannot prove, and the live 200 above is the current evidence.

Also available and unused today: `POST /api/session/{id}/interrupt`, `POST /api/experimental/session/{id}/wait`.

---

## 10. Harness Lifecycle

`[verified]` the bridge is a pure **event consumer** invoked from the notification path; the engine never imports OpenCode-specific code; `canWake`/`wake` are wrapped so a failure can never break the engine; every harness is `supportsWake: false` unless explicitly enabled.

---

## 11. Notifications

`[verified]` routing + policy + dedup work; **two emitted kinds were undeclared** (`harness.wake`, `workflow.completed`) — fixed on `stage`. `job.*` and `preflight` have producers; `subagent.*` is produced by `hook.mjs` and by the OpenCode monitor plugin.

---

## 12. Planner

`[verified]` the planner cannot execute (only `execute_plan` with `approve: true` runs, and it validates first). `[reported]` the explicit-plan path bypasses `maxSteps`, and there are no `maxDepth`/`maxFanout`/`budget` bounds.

---

## 13. Execution Graph

`[verified]` broken for workflow runs before the `stage` fix (orphan roots, zero edges). After the `stage` fix: every workflow job shares the workflow root and dependent nodes point at their dependency; fanout children hang off the root (documented limitation). `[reported]` supervisor/retry lineage labels are best-effort heuristics.

---

## 14. Security

`[verified]` `isolated` performs HOME/TMPDIR/XDG isolation plus an opt-in credential copy — **not** a filesystem or network sandbox; `docs/security-isolation.md` states this explicitly, including the residual risk (`~/.ssh`, `~/.aws` remain reachable). Redaction unsets secrets. Readguard covers tracked changes and, opt-in, gitignored files (with documented limits).

---

## 15. Test Quality

| Class | Where |
|---|---|
| unit | `test/schemas`, `routing-score`, `dsl`, `handoff`, `judge`, `verify`, `artifacts` |
| integration | `workflow-*`, `dashboard*`, `jobrunner`, `messaging` |
| cross-process | `c11-cross-process`, `fsutil`, `chaos` (fork helpers) |
| live adapter | `test/live/adapters.live.test.mjs` (`AGENT_HUB_LIVE=1`) |
| live harness | **none** |
| chaos | `test/chaos/*` (dispatch/resume/claim/provider/jules) |

Gaps: the OpenCode bridge is mock-only (see §9 — a live 200 was captured manually); worktree lease reclaim is single-process; some `jobrunner` promises are unawaited.

---

## 16. Documentation Drift

- `README` said the agys default is `auto` while the code returned `off` → **fixed on `stage`** (code now matches).
- `README` said higher priority wins while the code sorted ascending → **fixed on `stage`**.
- `docs/execution-contract.md` carries stale line references `[reported]` and still describes C0 as a pending gate while `better-sqlite3` ships and `initDb()` runs at startup `[reported]`.

---

## 17. Recommended Fix Batch (ordered)

Delivered on `stage` in this pass:
1. Declare `harness.wake` + `workflow.completed` (schemas + eventlog + test).
2. agys default mode `auto` (test).
3. agys priority descending (test).
4. Messaging inbox requires `rootExecutionId` (test).
5. Workflow lineage (`rootExecutionId`/`parentExecutionId`) (test).

Next batch (not in this pass):
6. `delegate()` → `dispatch()` unification (P0-1).
7. Per-class breakers wired into router/dispatch (P1-1).
8. Cross-process `dispatchKey` reservation (P1-2).
9. Write-fallback dirty check / rollback (P1-3).
10. Routing minimum sample gate + `Candidate {provider, agent, model, profile}` decision (P2).

---

## 18. Deferred Features

- **H.4 container** — design only until a per-CLI compatibility matrix is verified (`docs/security-isolation.md`).
- **I Hermes** — nested orchestration, deferred by the user.
- **Mid-run messaging** (`messagingMidRun`) — false everywhere until a delegated session is handed the hub's MCP server.
- **Live harness tests** — no automated live test for the OpenCode bridge/plugin yet.

---

```
CURRENT HEALTH:
Strong and coherent for the implemented scope. The evidence pipeline, handoffs,
providers and reliability harness are real and tested (1300+ tests, 0 failures,
0 cancelled). Two categories keep it from 'internally consistent': (a) a real
control-plane bypass in the most-used MCP entry point, and (b) a handful of
contract/consistency gaps (breakers, idempotency, roles enforcement, routing
sample gate). None is an architectural dead-end; all have bounded fixes.
```

```
TOP 5 FIXES:
1. Route delegate() through dispatch() with waitMode:'none' (single operational path).
2. Wire the per-class circuit breakers into router/dispatch.
3. Cross-process dispatchKey reservation in SQLite (no duplicate delegation).
4. Write-fallback dirty check / rollback (no double-apply in a worktree).
5. Routing: minimum-sample gate (+ decide the Candidate profile unification).
```

```
NEXT RECOMMENDED PHASE:
Control-plane consolidation (the 'single operational route' batch).
```

```
WHY:
The bypass, the breakers and the idempotency gap all live on the same path and
share one fix surface; closing them makes every later feature (Hermes, nested
orchestration, adaptive routing) inherit safety for free instead of re-deriving it.
```

```
PARALLEL IMPLEMENTATION TRACKS:
Track 1: delegate()->dispatch() unification + lineage/idempotency assertions.
Track 2: breakers wiring (router + dispatch) + per-class trip tests.
Track 3: cross-process dispatchKey reservation (SQLite UNIQUE) + multi-process test.
Track 4: write-fallback dirty check/rollback + chaos test.
Track 5: routing minimum-sample gate (+ Candidate decision doc).
```

```
DO NOT BUILD YET:
Hermes; the container sandbox; mid-run messaging; any second workflow engine or
artifact store. Each depends on the control plane being single-pathed first.
```

```
OPEN QUESTIONS:
1. Is delegate()'s documented 'exact execution' contract meant to keep a policy
   opt-out, or should every caller always pay for breakers/idempotency?
2. Should the agys profile become part of the routing Candidate, or stay a
   dispatch-time decision?
3. Do roles become runtime-enforced contracts (capabilities + acceptance in the
   verifier), or stay planning metadata?
```

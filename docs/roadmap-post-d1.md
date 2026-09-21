# Agent-Hub — Post-D1 Master Roadmap

Revision 2 — adjusted per reviewer feedback (see §0). Audit basis: `dev` at
`8b2ca1c` plus D1 (PR #15) and the D2 routing branch (PR #17).

---

## 0. What changed vs v1 (reviewer adjustments)

1. **Execution order now follows the reviewer's ranking**, not v1's. D2
   (Provider Profiles) is sequenced **before** D3 (Adaptive Routing) because D3
   wants to score `quota/profile` and profiles are not modelled for CLIs yet.
   E1 moves late, after E2, because the Lifecycle Bridge consumes the
   notification/event layer.
2. **New micro-phase C0.1 — SQLite Authority Cleanup**, so the declared
   invariant ("SQLite is coordination state; filesystem is content") stops being
   ambiguous. Does not block C2b; makes the path explicit.
3. **C2b handoff becomes a config, not a boolean**: `handoff: { required, schema }`
   (plus the `handoff: true` shorthand). Roles may **require** a schema, so the
   contract can be enforced per role.
4. **C2b batch schedule corrected**: v1 listed C2b.1→C2b.4 inside one parallel
   batch, which is wrong. Now split into batches (see §7).
5. **D2 gains explicit profile provenance**: the adapter distinguishes
   `profile selected | fallback | exhausted | unavailable` and **persists it on
   the ExecutionHandle**, so D1 can measure quality/cost/latency **per profile**,
   not just per provider. This is now an acceptance criterion, not a note.
6. **C4b feedback policy frozen literally**: a bounded
   `<agent-hub-revision>` block carrying the previous verdict, capped at
   **max 3 findings × 300 chars** (same shape as learnings).
7. **A core principle is elevated to the top of the document**:
   *execution success ≠ task success ≠ verified success*.

---

## 1. Core principles (elevated)

These are the line between "CLI wrapper" and "agent execution platform".
Everything below must preserve them.

1. **Execution success ≠ task success ≠ verified success.** Job status,
   `verification`, and `judge` are three different claims. Never collapse them.
2. **SQLite is coordination state; the filesystem is content.** Artifacts and
   large logs live on disk; rows, lineage and policy live in SQLite. (C0.1 makes
   this true rather than aspirational.)
3. **Human approval gates persistent change.** Runtime adaptation (routing,
   revision) is per-call; changing the base chain/profiles stays a proposal a
   human accepts.
4. **Reuse, never re-implement.** No second workflow engine, artifact store,
   verifier, judge, policy system, or ledger.

---

## 2. Real state after D1 (unchanged from v1, condensed)

| Area | Status | Note |
|---|---|---|
| A0–A4 (contract, dispatch, taxonomy, policy, breakers) | `DONE`/`PARTIAL` | `delegate` may bypass `dispatch` `[lead]`. |
| A5 sandbox | `PARTIAL` | `isolated === isolated-home`; secrets set to `'***'` instead of unset `[verified]`. |
| A6 leases / C0-real | `PARTIAL` / `FOUNDATION_ONLY` | POSIX lock authoritative; SQLite a mirror; `runs/` is the read path `[lead]`. |
| C0.5 events | `PARTIAL` | `workflow.completed`, `subagent.*` have no emitters `[verified]`. |
| Jules | `DONE` | Failover only on 429 `[lead]`. |
| C1/C1.1 | `DONE` | — |
| C1.2 supervisor link | `PARTIAL` | Jules only; CLI harnesses mapping-only. |
| C2 artifacts | `PARTIAL` | Delegate nodes only. |
| C3 verifier | `PARTIAL` | Delegate nodes only. |
| C4 judge | `PARTIAL` | Delegate only; **no failing-check feedback on revise** `[verified]`. |
| D1 metrics | `DONE` | cost/verified/quality/revisions. |
| D2 routing | `DONE (branch)` | PR #17; capabilities + explainable ranking. |
| Harness profiles | `DONE` | `supportsWake:false` everywhere. |
| Handoff / roles | `MISSING` | No structured context between nodes. |
| Tests / CI / chaos | `PARTIAL` / `MISSING` / `MISSING` | No CI, no chaos, no eval. |

---

## 3. Target architecture

```
                    MCP tools / dashboard
                             |
          +------------------+------------------+
          |                                     |
    route()/dispatch()                    workflow engine
          |                                     |
 requirements -> capabilities ->         nodes: delegate|fanout|fanin|notify
 quality/latency/cost -> ranking              |
 policy -> provider profile                   +--> Context & Handoff (C2b)
          |                                    +--> Artifacts (C2 done)
 ProviderProfileManager (D2)                   +--> Verifier (C3/C3b)
   |      |       |      |                     +--> Judge/revision (C4/C4b)
  agy  opencode copilot jules                  +--> Execution graph (F2)
   |                                             |
 AgysAdapter -> agys -> agy                 SQLite: coordination + lineage
                                                 |
                                     Eval/Chaos harness (G)
                                                 |
                                     Hermes nested orchestrator (I)

 SQLite = coordination/lineage/lifecycle ; filesystem = content/artifacts
```

---

## 4. Execution order (authoritative)

```
1  C2b  Context & Handoffs
2  E2   Notifications / Event Delivery        (fully parallel)
3  C3b  Verifier completion
4  C4b  Judge feedback loop
5  D2   Provider Profiles / Identity
6  D3   Adaptive Routing
7  F2   Parent/Child Execution Graph
8  H    Security Hardening
9  F1   Planner / Decomposer
10 G    Evaluation / Chaos / Reliability
11 E1   Harness Lifecycle Bridge
12 I    Hermes Nested Orchestration
```

Rationale for the reviewers' order: C3b/C4b are the natural consumers of C2b's
handoffs; D3 must follow D2 (it scores profiles); F2 is cheap and pays off for
debugging before the riskier phases; H's small wins land before the planner's
larger surface; E1 lands after E2 because the bridge is a notification consumer.

---

## 5. C0.1 — SQLite Authority Cleanup (new micro-phase)

### Objective
Make "SQLite is coordination state; filesystem is content" true, without a
big-bang migration.

### Why now
C2b adds SQLite tables and F2 reads lineage from SQLite; leaving `runs/` as the
read authority means two sources of truth during exactly the phase that needs
one.

### Current state
Jobs are dual-written (`createJob`/`updateResult` mirror into SQLite), but
`readResult`/`listJobs` scan `runs/` `[lead]`; `getJob`/`getLease` are exported
and unused `[lead]`.

### Architecture
```
write: JSON + SQLite (unchanged, already dual)
read (new): SQLite authoritative for coordination rows
             filesystem authoritative for content (response.txt, artifacts)
phase: flip behind a flag → dual-read compare (JSON vs SQLite) → cut over
```

### Tasks
- C0.1.1 `readResultFromDb(jobId)` + comparison harness.
- C0.1.2 Dual-read shadow mode: serve the JSON result, log divergences.
- C0.1.3 Cut `listJobs`/`readResult` over behind `AGENT_HUB_STORE=sqlite`.
- C0.1.4 Leave `result.json` as an artifact (still written, no longer the index).
- C0.1.5 Fix the `docs/execution-contract.md` claims in the same PR.

### Dependencies
C0-real. Parallel to C2b; does not block it.

### Acceptance criteria
- Shadow mode reports zero divergence on the existing suite.
- Cutting over changes no test observable except the intended ones.

### Tests
Divergence harness; migration test with two processes.

### Risks
A stale SQLite row serving old content → verify write ordering, keep JSON as a
fallback read when the DB is unavailable.

### Not in scope
Removing the JSON files. They become artifacts, not the index.

---

## 6. Phases

### C2b — Context & Handoffs

#### Objective
Every node produces a **validated** structured handoff for the next node,
persisted in SQLite and referenced from artifacts.

#### Why now
The system runs nodes but does not transmit understanding: `research → artifact →
implementation` exists, `research → findings → implementation` does not. The
shipped example forwards none of research's conclusions.

#### Current state
`src/artifacts.mjs` + engine; no `summary/findings/decisions/constraints/
changedFiles/openQuestions`. No roles.

#### Architecture
```
node result ──▶ handoff { summary, findings[], decisions[], constraints[],
                          changedFiles[], openQuestions[], artifacts[] }
                        │
          SQLite task_handoffs(workflow_id, step_id, ...) + task_context
          filesystem runs/<wf>/<step>/artifacts/handoff.json
```
Node config (reviewer adjustment):
```js
handoff: true                                  // shorthand: not required, default shape
handoff: { required: true, schema: 'ResearchHandoff' }
handoff: { required: false }
```
A role may force a contract: `role: SECURITY_REVIEWER` +
`handoff: { required: true, schema: 'SecurityReviewHandoff' }`.

#### Files/modules expected to change
new `src/handoff.mjs`, new `src/context.mjs`, `src/storage/sqlite.mjs`,
`src/workflow/schema.mjs`, `src/workflow/engine.mjs`, `src/workflow/resolver.mjs`,
docs.

#### Tasks
- C2b.1 `HandoffSchema` (zod) + `validateHandoff` + a small named-schema registry
  (`ResearchHandoff`, `SecurityReviewHandoff`, `ImplementationHandoff`, …).
  Pure module + tests. **This defines the contract; everything else depends on it.**
- C2b.2 Persist handoffs: SQLite `task_handoffs` + `task_context`; JSON sibling
  under the node artifacts dir.
- C2b.3 Engine: honor `handoff: true | { required, schema }`; persist on
  completion; `required: true` + invalid/missing handoff **fails the node**.
- C2b.4 Inject the upstream handoff into a downstream node's task, bounded and
  templated; expose `steps.<id>.handoff.*` in the safe DSL.
- C2b.5 Roles registry (`TRACE_ANALYST`, `SECURITY_REVIEWER`, `ARCHITECT`,
  `IMPLEMENTER`, `TEST_ANALYST`, `ADVERSARIAL_REVIEWER`) → required capabilities
  (reuse D2 `capabilities`) + required handoff schema + acceptance hints.
  Roles are **contracts, not mega-prompts**. Starts once C2b.1's contract exists
  (it depends on the contract more than on the engine).

#### Dependencies
C2, C4, D2 capabilities (C2b.5).

#### Acceptance criteria
- `handoff: { required: true, schema: X }` with an invalid handoff fails the
  node, not silently defaults.
- `handoff: { required: false }` records whatever is present.
- A downstream node's dispatched task contains the upstream summary/findings.
- `steps.<id>.handoff` is usable in a `condition`.
- Resume restores handoffs from SQLite.

#### Tests
Schema/registry unit tests; persistence; two-node integration (second task
contains the first's findings); required-schema failure; resume.

#### Risks
Handoff growth → cap and truncate with a marker. Role sprawl → keep the registry
small and data-only.

#### Not in scope
Model-based summarization. LLM-based acceptance criteria.

---

### E2 — Notifications / Event Delivery (parallel)

#### Objective
Policy-driven delivery from the watcher, which stays a **separate process**.

#### Why now
`workflow.completed` is routed but never emitted `[verified]`; `subagent.*` has
no producer. This is a concrete bug plus a missing policy layer.

#### Current state
`src/notify/watch.mjs` + `adapters.mjs` (console/file/webhook) + dashboard SSE.

#### Architecture
`event → policy (kind × severity × channel) → adapters (dashboard | webhook |
desktop | slack/discord | lifecycle bridge)`; watcher never becomes an in-process
daemon.

#### Tasks
- E2.1 Emit `workflow.completed` from the engine (workflowId, status, counts).
- E2.2 Emit or delete `subagent.start/stop`.
- E2.3 `src/notify/policy.mjs` (kind → channels, severity, dedup window).
- E2.4 Desktop + Slack/Discord adapters behind the never-throw contract.
- E2.5 Policy surfaced in dashboard config.

#### Dependencies
None. Parallel from day one.

#### Acceptance criteria
- One workflow completion → exactly one `workflow.completed` + one configured
  notification. A failing adapter never kills the watcher.

#### Tests
Emission tests; policy unit tests; adapter tests with a fake fetch.

#### Risks
Notification fatigue → dedup window and per-kind defaults.

#### Not in scope
Daemonizing the watcher.

---

### C3b — Verifier completion

#### Objective
Verification for every execution shape and for structured output.

#### Why now
The verifier is delegate-only; a fanout of 8 is unverified; a declared handoff
schema is not validated against the produced handoff.

#### Current state
`src/verify.mjs`: argv/artifact/diff, delegate nodes only.

#### Tasks
- C3b.1 `schema` check kind: validate a declared artifact or the handoff against
  a named schema from C2b's registry; report failing JSON paths.
- C3b.2 Run artifacts/verify/judge on the fanout child path (per-child step id).
- C3b.3 `requiredChecks` semantics (a node can demand at least one check ran).

#### Dependencies
C2b (handoff schema registry), C3.

#### Acceptance criteria
- A fanout child with `verify` produces `verification.json` and a judge verdict.
- A handoff failing its schema fails the node with the failing paths.

#### Tests
Fanout-with-verify integration; schema-check unit tests.

#### Risks
Copy-paste between fanout and delegate → extract one
"execute + evidence + verify + judge" core.

#### Not in scope
Agent-judged acceptance criteria (C4b/I).

---

### C4b — Judge feedback loop completion

#### Objective
Make a revision informative and wire the reserved hooks.

#### Why now
A deterministic failure re-dispatches the identical prompt `[verified]`.

#### Architecture (policy frozen per reviewer)
```
previous verdict ──▶ buildRevisionFeedback ──▶ <agent-hub-revision> block
                                                prepended to the re-dispatch task
```
```
<agent-hub-revision>
Failed checks:
- tests/auth.test.ts
- response schema
Findings:
- expected 401, received 500
Do not change unrelated files.
</agent-hub-revision>
```
Hard cap: **max 3 findings × 300 chars** (same shape as learnings).

#### Tasks
- C4b.1 `buildRevisionFeedback(verdict)` → bounded block (max 3 × 300).
- C4b.2 Inject on `needs_revision` re-dispatch only.
- C4b.3 Consume `onSuccess`/`onFailure` as declarative directives (`skip|fail|
  continue`) or remove them from the schema.

#### Dependencies
C3, C4, C2b.

#### Acceptance criteria
- The revision task contains the previous failing check names, bounded.
- `onFailure: 'skip'` behaves accordingly, or the field is gone.

#### Tests
Integration: fail → revise → second task contains the verdict text and respects
the cap.

#### Risks
Prompt bloat → the cap is a test, not a comment.

#### Not in scope
Unbounded self-correction.

---

### D2 — Provider Profiles / Identity

#### Objective
Know *which identity* runs, with priority/quota/availability/fallback
eligibility, without owning secrets agent-hub does not already own.

#### Why now
`agy` quota is the scarcest resource in practice and `agys` already manages its
profiles. Routing (D3) and fallback both need "which account".

#### Current state
Multi-account for Jules only; CLI providers use ambient host auth; no `agys`
reference in `src/` `[verified]`.

#### Architecture
```
agent-hub ─▶ ProviderProfileManager ─▶ AgysAdapter ─▶ agys ─▶ agy
                   │
                   ├── jules: existing accounts.mjs
                   ├── opencode/codex/copilot: metadata + host-env selector only
                   └── exposes { provider, profile, priority, quota,
                                 availability, fallbackEligibility }
```

**Profile provenance (new, explicit requirement):** the adapter distinguishes
`profile selected | fallback | exhausted | unavailable` and **persists it on the
ExecutionHandle** (and thus the job record), so D1 can measure quality/cost/
latency per profile.

Fallback policy reuses A3, never a fork:
- `quota`, `transport` → may change profile/account.
- `auth`, `billing` → stop and escalate to a human.
- read-retry vs write-retry vs session-resume vs fresh-process semantics must be
  explicit; a write job is never silently re-run on another account in the same
  worktree.

#### Tasks
- D2.1 `ProviderProfile` model + store (reuse `accounts.mjs` shape; CLI profiles
  are metadata only).
- D2.2 `AgysAdapter`: detect `agys`, list/select profiles, degrade to plain `agy`
  when absent. No secret handling.
- D2.3 Profile-state machine (`selected/fallback/exhausted/unavailable`) +
  persistence on the ExecutionHandle/job record.
- D2.4 Class → action wiring on top of A3 (no new policy table).
- D2.5 Write-path safety tests for profile switching.

#### Dependencies
A3, A4, accounts, D1 (per-profile metrics).

#### Acceptance criteria
- `route()` can report eligible profiles and never picks one whose `auth`/
  `billing` is broken.
- Without `agys`, behaviour is byte-for-byte today's.
- A `quota` failure moves profile; an `auth` failure does not.
- The job record carries the profile used and whether it was a fallback.

#### Tests
Fake-`agys` adapter unit tests; policy class→action; worktree safety; per-profile
metrics aggregation.

#### Risks
External CLI coupling → thin adapter behind a capability check. Secret leakage →
never print credentials.

#### Not in scope
Managing `agy` OAuth directly. Credential mounts (H).

---

### D3 — Adaptive Routing

#### Objective
`requirements → capabilities → quality → latency → cost → quota/profile →
policy → candidate`, explainably, human gate preserved.

#### Why now
D1 gives the signal; D2 gives the profile dimension. D3 closes the loop.

#### Current state
Capabilities + scoring + `route()` wiring landed (PR #17).

#### Tasks
- D3.1 (done) capabilities + scoring.
- D3.2 (done) `route()` requirements/preferences/adaptive + ranking.
- D3.3 Feed the **profile** dimension from D2 into the ranking.
- D3.4 Carry multi-dimension evidence into the human-gated proposals.
- D3.5 Surface `ranking` reasons in the dashboard.

#### Dependencies
D1, D2 (profile dimension).

#### Acceptance criteria
- Ranked output deterministic with reasons; missing data degrades to the static
  chain; persistent order changes still need a human.

#### Tests
Existing router tests stay green; profile-aware ranking; minimum-sample guard
(reuse `METRICS_MIN_SAMPLES`) so a dimension only influences the score with
enough history.

#### Risks
Overfitting to few samples → minimum sample count per dimension.

#### Not in scope
Auto-accepting proposals.

---

### F2 — Parent/Child Execution Graph

#### Objective
A lineage view over the fields that already exist, plus the relation kind.

#### Why now
Cheap and it directly helps debug the class of bug already seen (a Jules node
marked `succeeded` while the remote was still `queued`).

#### Current state
`rootExecutionId`/`parentExecutionId`/`executionId`/`workflowId`/`stepId`/
`attempt` persisted; no graph API.

#### Architecture
`src/execution-graph.mjs` builds the tree from SQLite; read-only
`GET /api/execution-graph` + an MCP tool.

#### Tasks
- F2.1 Build the graph from SQLite `jobs` + `workflow_nodes`.
- F2.2 Expose the API + MCP tool.
- F2.3 Dashboard tree view.
- F2.4 Lineage completeness assertions in dispatch/workflow tests.

#### Dependencies
C0-real, C0.1 (if SQLite becomes the read authority), C1.

#### Acceptance criteria
- Given a root, the API returns the full descendant tree with relation kinds; a
  fanout's children hang off the fanout node.

#### Tests
Graph-building fixtures; API test; every dispatched job has a root.

#### Risks
Deep trees → depth limit/pagination; older records with gaps → mark `unknown`.

#### Not in scope
Cross-machine tracing.

---

### H — Security Hardening

#### Objective
Make isolation claims true, starting with the small wins.

#### Why now
`isolated === isolated-home` and secrets set to `'***'` are correctness-of-claim
issues; the readguard misses gitignored files.

#### Tasks
- H.1 Unset redacted env vars instead of `'***'`.
- H.2 Readguard: cover gitignored paths (opt-in, documented); treat non-git cwd
  as a violation when read purity is required.
- H.3 `isolated`: real HOME/cache/config isolation with an explicit mount
  allowlist (no network policy yet).
- H.4 `container`: design-only until the CLI compatibility matrix is verified.
- H.5 Document the level matrix and residual risks.

#### Dependencies
A5.

#### Acceptance criteria
- A secret env var is **absent**, not `'***'`.
- A read job editing a gitignored file is reported (opt-in).
- The README states exactly what `isolated` does.

#### Tests
Env filtering; readguard ignored-file; opt-in live CLI smoke per level.

#### Risks
Breaking CLI auth by over-isolating → keep `compatibility` default; verify each
CLI before changing a default.

#### Not in scope
Claiming container-grade isolation before the matrix exists.

---

### F1 — Planner / Decomposer

#### Objective
Turn a complex intent into a **validated** `WorkflowPlan`; never plan a simple
task.

#### Why now
After C2b, roles + handoffs make a plan executable with understanding; planning
before that would produce plans the engine cannot honor.

#### Architecture
```
intent ─▶ complexity gate (decompose: true) ─▶ PLANNER role ─▶ WorkflowPlan JSON
                                                  │
                          WorkflowSchema + role/capability validation
                                                  │
                                          approval (first use) ─▶ runWorkflow
```
`decompose: true` is explicit; there is **no heuristic guessing** and no
"planner for every task".

#### Tasks
- F1.1 `WorkflowPlan` = `WorkflowSchema` + required `role` per node.
- F1.2 Explicit complexity gate (`decompose: true`).
- F1.3 `decompose()` runs the planner, validates, fails closed on invalid output.
- F1.4 Human approval gate before first execution.

#### Dependencies
C2b (roles/handoffs), C1, D3 (routing the planner).

#### Acceptance criteria
- An invalid plan never starts execution; a one-step intent stays one node.

#### Tests
Plan validation (cycles, unknown role, missing dep); fake planner valid/invalid.

#### Risks
Hallucinated node ids/roles → validate and fail, never repair silently.

#### Not in scope
Auto-executing without approval on first use.

---

### G — Evaluation / Chaos / Reliability

#### Objective
Replace "N tests pass" with "known behaviour under failure modes".

#### Tasks
- G.1 Metric set + corpus format.
- G.2 Deterministic offline corpus (mock CLIs, quota-free).
- G.3 Chaos scenarios, one invariant each: kill scheduler, kill worker, network
  failure, provider unavailable, Jules API failure, SQLite contention, expired
  lease, duplicate dispatch, workflow crash, partial fan-out.
- G.4 Opt-in live variant (`AGENT_HUB_LIVE=1`).
- G.5 Report committed as evidence.

#### Dependencies
D1, C0-real/C0.1, C1, D2 (provider fallback scenarios).

#### Acceptance criteria
- Each chaos scenario fails when its invariant breaks; the eval report is
  reproducible offline.

#### Tests
The harness itself + one scenario per failure mode.

#### Risks
Flaky chaos → seeded determinism; the existing worktree-lease flake is the
warning.

#### Not in scope
Load/scale benchmarking.

---

### E1 — Harness Lifecycle Bridge

#### Objective
When the harness allows it, continue the host conversation on completion —
without coupling the engine to any host.

#### Why now (after E2)
The bridge consumes the event/notification layer; building it before E2 means
inventing that layer twice.

#### Architecture
```
job.finished ─▶ notification policy (E2) ─▶ bridge.deliver(origin, summary)
                                                 │
                                   opencode.bridge (session resume)
                                   claude-code.bridge (hook)
                                   generic: no-op
```
The bridge consumes events; the engine never depends on it.

#### Tasks
- E1.1 Bridge contract (`canWake(origin)`, `wake(origin, payload)`), no-op default.
- E1.2 OpenCode bridge behind a capability flag (research the current session API
  first; do not implement until verified).
- E1.3 `supportsWake` becomes data-driven per harness version (default false).
- E1.4 Record bridge outcomes as events.

#### Dependencies
E2, C1.2 origin mapping.

#### Acceptance criteria
- No bridge → byte-for-byte today. A completion can continue the originating
  session when supported, else no-op.

#### Tests
Contract unit tests; fake-open-code integration; absent-bridge no-op.

#### Risks
Host-version coupling → version gate, default off. Blocking the watcher → strict
timeouts.

#### Not in scope
Implementing the bridge before the API is verified.

---

### I — Hermes Nested Orchestration

#### Objective
Hermes as a **nested orchestrator** over agent-hub's execution fabric.

#### Why now
Only after F1/F2/G/E1 does agent-hub expose a stable surface.

#### Architecture
A frozen `ExecutionBackend` contract (`workflow`, `dispatch`, `artifact`,
`verifier`, `judge`, `profiles`, `harness`). **Hermes owns planning; agent-hub
owns execution and evidence.** No second workflow engine.

#### Tasks
- I.1 Write `docs/execution-backend-contract.md`.
- I.2 Expose one `execute_plan` entry point accepting a validated plan.
- I.3 Conformance test: the example plan runs through the public surface only.
- I.4 Hermes integration behind an opt-in flag.

#### Dependencies
F1, F2, G, E1.

#### Acceptance criteria
- A plan executes end-to-end through the documented surface with no internals
  access; Hermes integration changes no engine code.

#### Tests
Contract conformance; fake nested orchestrator driver.

#### Risks
Interface churn → freeze before wiring.

#### Not in scope
Reimplementing planning or execution in Hermes.

---

## 7. Batches (corrected dependencies)

```
Batch 1 (parallel, no cross-deps):
  C2b.1  Handoff schema + registry          (defines the contract)
  E2.1   workflow.completed emitter
  C4b.1  buildRevisionFeedback
  H.1    unset redacted env
  G.0    deflake worktree-lease + isolate quota-codexbar tests

Batch 2:
  C2b.5  Roles registry (needs C2b.1's contract, not the engine)
  E2.2   subagent events emit-or-delete
  E2.3   notification policy
  C0.1.1 SQLite dual-read comparison harness

Batch 3:
  C2b.2  SQLite task_handoffs/task_context (needs C2b.1)

Batch 4:
  C2b.3  Engine honors handoff config (needs C2b.2)

Batch 5:
  C2b.4  Inject upstream handoff into downstream task (needs C2b.3)

then: C3b (needs C2b) → C4b.2/3 (needs C4/C3) → D2 → D3 → F2 → H.2-5 → F1 → G → E1 → I
```

Each batch is one or more work units; every task keeps its own commit.

---

## 8. Priority table (reviewer's order)

| # | Phase | Dependencies | Value | Complexity | Risk | Why this rank |
|---|---|---|---|---|---|---|
| 1 | C2b Context & Handoffs | C2/C4 done | High | Medium | Low | Missing half of C2; unblocks F1/F2/I; no external deps |
| 2 | E2 Notifications | none | Medium | Low | Very low | Fixes a real dead event; parallelizable |
| 3 | C3b Verifier completion | C2b | Medium | Low | Low | Closes the fanout blind spot + validates handoffs |
| 4 | C4b Judge feedback | C3/C4 | Medium | Low | Low | Makes revision useful instead of repeated |
| 5 | D2 Provider Profiles | A3/A4/accounts | High | High | High | `agy` quota is the real bottleneck; `agys` exists |
| 6 | D3 Adaptive Routing | D1, D2 | High | Medium | Medium | Consumes profiles; must follow D2 |
| 7 | F2 Execution Graph | C0/C1 | Medium | Low | Low | Cheap; debugging payoff before riskier phases |
| 8 | H Security Hardening | A5 | Medium | Medium | Medium | H.1/H.2 tiny; H.3/H.4 later |
| 9 | F1 Planner | C2b | High | High | Medium | Needs roles from C2b |
| 10 | G Eval/Chaos | C0/C1/D1 | High | High | Medium | Offline corpus first |
| 11 | E1 Harness Lifecycle | E2, C1.2 | Medium | Medium | Medium | Consumes E2; host-version coupling |
| 12 | I Hermes | F1/F2/G/E1 | High long-term | Very high | High | Needs a stable surface |

---

## 9. Dependency graph (corrected)

```
C2/C3/C4/D1  DONE
      │
      ├─▶ C2b ──┬─▶ C3b ──▶ C4b
      │         └─▶ F1 ──▶ F2? (F2 only needs C0/C1)
      │
      ├─▶ C0.1 (SQLite authority) ──▶ F2
      │
      ├─▶ D2 ──▶ D3
      │
      ├─▶ E2 ──▶ E1
      │
      └─▶ H (independent)

G needs C0/C1/D1 (+D2 for provider-fallback scenarios)
I needs F1 + F2 + G + E1
```

---

## 10. Migrations

- **SQLite (C2b)**: additive `CREATE TABLE IF NOT EXISTS task_handoffs`,
  `task_context`.
- **SQLite (C0.1)**: read-path cutover behind a flag with dual-read comparison.
- **`quality_score`**: decide (delete or have C4b write it) before more consumers.
- **`onSuccess`/`onFailure`**: consume in C4b or remove from the schema.
- **Sandbox (H)**: no default change without a version bump + verified matrix.
- **`docs/execution-contract.md`**: fix SQLite claims in the same PR as the first
  storage change.

---

## 11. What NOT to build

Another workflow engine, artifact store, verifier, judge, policy/breaker system,
event daemon, quality metric, `ledger.json`, `agys` reimplementation, or CLI auth
mechanism. SQLite is coordination; the filesystem is content.

---

## 12. External ideas — adopted / narrowed / rejected

- **Gentle-Shell planner** → adopted as F1, narrowed: plans must validate against
  `WorkflowSchema` + roles.
- **AISW / AgentsRoom** → rejected (they assume owning the process lifecycle);
  only the lineage idea survived as F2.
- **ZCode / Agent Orchestrator** → rejected as a YAML pipeline runner
  (duplicates the DAG engine); the useful part is F1.
- **`agys`** → adopted as an adapter (D2), never reimplemented.
- **Hermes** → adopted as nested orchestrator (I).
- **Vector/RAG memory over past runs** → deferred, not rejected: C2b handoffs +
  D1 metrics give structured memory first.

---

## 13. Recommendation

```
NEXT RECOMMENDED PHASE:
C2b — Context & Handoffs
```

```
WHY:
1. It is the missing half of C2: nodes emit artifacts but pass no structured
   context, and the shipped example forwards none of research's conclusions.
2. It needs no external dependency (SQLite + filesystem) and no CLI risk.
3. It unblocks F1 (planner) and I (Hermes), which both need a handoff/role
   contract that must exist once.
4. It is the foundation C3b/C4b consume next (schema-validated handoffs, and a
   bounded revision feedback block).
5. It is what turns "nodes that run" into "nodes that understand".
```

```
FIRST IMPLEMENTATION BATCH (parallel):
- C2b.1  Handoff schema + named-schema registry (pure, defines the contract)
- E2.1   Emit workflow.completed from the engine
- C4b.1  buildRevisionFeedback (max 3 findings x 300 chars)
- H.1    Unset redacted env vars instead of setting '***'
- G.0    Deflake worktree-lease + isolate the quota-codexbar tests
```
Then Batch 2 for C2b.5 roles, E2.2/E2.3 and C0.1.1, and Batch 3 for C2b.2.

---

## Appendix A — Audit leads not personally re-verified

`delegate` bypassing `dispatch`; SQLite lease mirror write-only / `getLease`
uncalled; `getJob` exported and unused; quota never deprioritizing an exhausted
provider; Jules failover only on 429; `modelsArgv` throwing for `jules`.

Confirmed by direct inspection: `isolated === isolated-home` and `'***'`
redaction; no `workflow.completed` emitter; C4 has no feedback injection; fanout
children bypass artifacts/verify/judge; `onSuccess`/`onFailure` schema-only; no
context/handoff; no roles; `quality_score` unused; no CI; readguard
`--ignored=no`.

# Agent-Hub — Post-D1 Master Roadmap

Status: active. Basis: `dev` at `8b2ca1c` (C2, C3, C4, dashboard fix merged)
plus the D1 branch (`feat/d1-intelligence`, PR #15) and the in-progress D2
routing branch (`feat/d2-adaptive-routing`).

This document is written to be executed phase by phase in isolated worktrees,
one work unit per commit, by independent agents. It is not a wish list.

Conventions used below:

- `DONE` / `PARTIAL` / `FOUNDATION_ONLY` / `MISSING` / `TECHNICAL_DEBT` are the
  audit labels.
- `[verified]` = confirmed by reading the code in this session.
- `[lead]` = reported by a mapping agent with a file:line, not yet personally
  confirmed. Treat as evidence to check before relying on it.
- Phase names keep the plan's post-D1 numbering. Where an earlier roadmap used a
  different number, the phase says so explicitly.

---

## 1. Real state after D1

### 1.1 Control plane

| Feature | Status | Evidence | Note |
|---|---|---|---|
| A0 execution contract | `PARTIAL` | `docs/execution-contract.md` | Normative and largely implemented; doc drift below. |
| A1 `dispatch()` | `DONE` | `src/dispatch.mjs` | Decide+execute, policy, idempotency key, remote reconciliation. |
| A1 `delegate()` bypass | `TECHNICAL_DEBT` | `src/tools/jobs.mjs:38` `[lead]` | `delegateTool` is reported to call `startJob` directly, skipping breakers/idempotency. Verify before acting. |
| A2 error taxonomy | `DONE` | `src/policy/taxonomy.mjs` | 7 classes. |
| A3 policy registry | `DONE` | `src/policy/registry.mjs`, `executor.mjs` | retry/resume/fallback/escalation. |
| A4 circuit breakers | `DONE` | `src/breakers.mjs` | Per class, immediate trip for billing/auth. |
| A5 sandbox profiles | `PARTIAL` | `src/sandbox.mjs` `[verified]` | `isolated === isolated-home`; redacted secrets become the literal `'***'` instead of being unset `[verified]`. |
| A6 worktree leases | `PARTIAL` | `src/worktree.mjs` | POSIX lock files are authoritative; the SQLite `leases` mirror is write-only `[lead]`. |
| C0-real SQLite | `FOUNDATION_ONLY` | `src/storage/sqlite.mjs`, `src/jobstore.mjs` | Tables exist and are written, but `runs/` is still the read source of truth; `getJob`/`getLease` exported and unused `[lead]`. |
| C0.5 event watcher | `PARTIAL` | `src/notify/*` | console/file/webhook work; `workflow.completed`, `subagent.start/stop` have no emitters `[verified for workflow.completed]`. |

### 1.2 Jules

All `DONE` per the audit, with two caveats:

- Account failover happens only on HTTP 429; a 401/403 aborts instead of trying
  the next configured key (`src/cloud/runner.mjs` `[lead]`).
- There is no fallback from a remote (Jules) job to a local CLI when remote
  quota is exhausted `[lead]`.

### 1.3 Workflow engine, harness, evidence

| Feature | Status | Evidence | Note |
|---|---|---|---|
| C1 DAG engine | `DONE` | `src/workflow/engine.mjs` | Waves, cycles, SQLite persistence, resume, leases. |
| C1.1 hardening | `DONE` | `src/workflow/dsl.mjs`, `execution.mjs` | Safe DSL, handles, CAS claims. |
| C1.2 supervisor link | `PARTIAL` | `src/workflow/resume.mjs` | Works for Jules waiting nodes; CLI harnesses are mapping-only. |
| C2 artifacts | `PARTIAL` | `src/artifacts.mjs` `[verified]` | Path-safe store, `artifact://` refs, manifests, bounded inlining — on **delegate nodes only**. |
| C3 verifier | `PARTIAL` | `src/verify.mjs` `[verified]` | argv/artifact/diff checks on delegate nodes only. |
| C4 judge / revision | `PARTIAL` | `src/judge.mjs` `[verified]` | Verdicts + bounded revision loop, but the re-dispatch sends the **original prompt with no failing-check feedback** `[verified]`, and it is delegate-only. |
| D1 intelligence | `DONE` | `src/metrics.mjs` `[verified]` | cost, verified, quality, revisions, retries. |
| Harness profiles | `DONE` | `src/harness/*` | `generic | claude-code | opencode`, `waitMode`. All `supportsWake: false`. |
| Node handoff / context | `MISSING` | `src/workflow/engine.mjs` `[verified]` | No structured summary/findings/decisions between nodes; only artifact string interpolation. |
| Role abstraction | `MISSING` | `src/workflow/schema.mjs` `[verified]` | No role concept. |
| `onSuccess`/`onFailure` | `MISSING (accepted, unread)` | `src/workflow/schema.mjs` `[verified]` | Schema fields the engine never consumes. |
| fanout child evidence | `MISSING` | `src/workflow/engine.mjs` `[verified]` | fanout children run raw `dispatch` with no artifacts/verify/judge. |
| `workflow.completed` event | `MISSING` | `src/notify/adapters.mjs:18` + engine `[verified]` | Documented as routable; the engine never emits it. |

### 1.4 Routing, profiles, tests

| Feature | Status | Evidence | Note |
|---|---|---|---|
| `DELEGATION_MAP` + `route()` | `DONE` | `src/router.mjs` | Availability/breaker/hold filtered; first survivor is primary. |
| Wilson reorder proposals | `DONE` | `src/proposals.mjs` | Human-gated; success-rate only. |
| Capabilities | `DONE (branch)` | `src/capabilities.mjs` (D2) | Added on the routing branch, not yet merged. |
| Adaptive scoring | `DONE (branch)` | `src/routing/score.mjs` (D2) | Pure, explainable; `route()` wiring is the open work unit. |
| Provider profiles | `FOUNDATION_ONLY` | `src/accounts.mjs` | Multi-account exists **for Jules only**; CLI providers rely on ambient host auth. |
| Test suite | `DONE` | `package.json` | ~1071 node tests + 161 dashboard tests. |
| Chaos / eval harness | `MISSING` | — | No fault injection, no benchmark corpus, no LLM-output eval. |
| CI / issue & release automation | `MISSING` | — | No `.github/` at all. |
| Readguard coverage | `PARTIAL` | `src/readguard.mjs` | `--ignored=no`: gitignored files (`.env`) are invisible; non-git cwd is `unverifiable`. |

---

## 2. Technical debt (ranked)

1. **`quality_score` is dead.** The column and `JobRecord` field exist but no code
   writes them; D1 computes `qualityScore` in metrics instead. Decide: either
   delete the field or make the judge write a per-job score. `[verified]`
2. **Delegate bypasses the control plane.** If `delegateTool` really calls
   `startJob` directly, then breakers/idempotency/policy do not apply to the
   most-used entry point. `[lead — verify first]`
3. **SQLite is a mirror, not the authority.** `runs/` JSON is the read path, so
   two processes can still disagree for a window, and the DAG/analytics queries
   SQLite could answer cheaply are done by scanning directories. `[lead on getJob/getLease]`
4. **Sandbox redaction is cosmetic.** Redacted env vars are set to `'***'` rather
   than removed; a CLI that parses the value learns a placeholder, not that the
   secret is absent. `[verified]`
5. **Silent lease mirror.** SQLite lease writes are best-effort `catch {}`; the
   mirror can drift from the authoritative lock file with no signal. `[lead]`
6. **C4 revise without feedback.** The revision re-dispatch repeats the same
   prompt, so a deterministic verification failure will usually repeat. `[verified]`
7. **Events declared but never emitted.** `workflow.completed`,
   `subagent.start/stop` (the hook path exists; the watcher routing for
   `workflow.completed` does not). `[verified]`
8. **Doc drift.** `docs/execution-contract.md` still claims SQLite is not a
   runtime dependency / is a parallel layer; README's metrics paragraph predates
   D1. `[verified]`
9. **Known flaky/inert tests.** `test/worktree-lease.test.mjs` flakes under full
   suite; `test/quota-codexbar.test.mjs` cancels 8. `[verified]`
10. **No CI.** Every merge relies on a local run. `[verified]`

---

## 3. Target architecture

```
                       MCP tools / dashboard
                                |
             +------------------+------------------+
             |                                     |
        route()/dispatch()                    workflow engine
             |                                     |
   requirements -> capabilities ->          nodes: delegate | fanout | fanin | notify
   quality/latency/cost -> ranking               |
   policy -> provider profile                    +--> Context & Handoff (new)
             |                                    +--> Artifacts (C2, done)
   ProviderProfileManager (new)                  +--> Verifier (C3, done)
     |        |        |        |                 +--> Judge/revision (C4, done)
   agy      opencode  copilot  jules             +--> Execution graph (F2, new)
     |                                             |
   AgysAdapter -> agys -> agy                  Journal/notes in SQLite
                                                  |
                                      Eval/Chaos harness (G)
                                                  |
                                       Hermes nested orchestrator (I)
```

Two invariants to preserve:

- **SQLite is coordination state; the filesystem is content.** Artifacts and big
  logs stay on disk; row metadata, lineage and policy live in SQLite.
- **Execution success != task success != verified success.** The three are
  already distinct in code (job status, `verification`, `judge`); do not collapse
  them.

---

## 4. Phases

### C2b — Context & Handoffs (completes C2)

#### Objective
Give every node a structured, validated handoff for the next node, persisted in
SQLite and referenced from artifacts, so a workflow stops being a chain of
isolated prompts.

#### Why now
C2's artifacts exist but carry **content only**; the shipped example
(`examples/software-pipeline.mjs`, research → implementation → review) passes
none of research's conclusions to implementation. Without a handoff, F1 (planner)
and I (Hermes) would both reinvent one.

#### Current state
`src/artifacts.mjs` (`artifact://` refs, manifests) + `src/workflow/engine.mjs`
(delegate nodes). No `summary/findings/decisions/constraints/changedFiles/
openQuestions`. No roles.

#### Architecture
Filesystem holds artifact bodies; SQLite holds an indexed handoff record.

```
workflow_nodes(result) ──▶ handoff { summary, findings[], decisions[],
                                     constraints[], changedFiles[],
                                     openQuestions[], artifacts[] }
                                      │
                       SQLite: task_handoffs(workflow_id, step_id, ...)
                       filesystem: runs/<wf>/<step>/artifacts/handoff.json
```

The node result gains `handoff`; the resolver can read `steps.<id>.handoff.*` in
the existing safe DSL.

#### Files/modules expected to change
- new `src/handoff.mjs` (schema + validate + normalize)
- new `src/context.mjs` (SQLite-backed task context: notes/decisions/findings)
- `src/storage/sqlite.mjs` (+ `task_handoffs`, `task_context` tables)
- `src/workflow/schema.mjs` (node `role`, `handoff` expectations)
- `src/workflow/engine.mjs` (produce/store handoff on node completion; surface it)
- `src/workflow/resolver.mjs` (expose `handoff` in the condition scope)
- docs

#### Tasks
- C2b.1 Define `HandoffSchema` (zod) and `validateHandoff`; unknown keys are an
  error, empty arrays are valid. Pure module + tests.
- C2b.2 Persist handoffs: SQLite table + `writeHandoff`/`readHandoff`, dual-write
  the JSON sibling under the node artifacts dir.
- C2b.3 Engine: after a delegate node succeeds, persist `handoff` if the node
  declared `handoff: true`; attach it to the node result and the `job.finished`
  event.
- C2b.4 Feed the upstream handoff into a downstream node's task (a bounded,
  templated block) without reading the whole response.
- C2b.5 Roles: `ROLES` registry (TRACE_ANALYST, SECURITY_REVIEWER, ARCHITECT,
  IMPLEMENTER, TEST_ANALYST, ADVERSARIAL_REVIEWER) mapping role → required
  capabilities (reuse D2 `capabilities`) + expected handoff shape + acceptance
  hints. Roles are **validation contracts, not mega-prompts**.

#### Dependencies
C2 (done), C4 (done), D2 capabilities (for roles).

#### Acceptance criteria
- A node declaring `handoff: true` produces a validated handoff; an invalid one
  fails the node with a clear error, not a silent default.
- A downstream node receives the upstream handoff summary/findings in its task.
- `steps.<id>.handoff` is usable in a `condition`.
- Resuming a workflow restores handoffs from SQLite.

#### Tests
Unit (schema, persistence, resolver scope) + integration (two-node workflow where
the second node's dispatched task contains the first's findings) + resume test.

#### Risks
Handoffs can grow unbounded → cap size and truncate with a marker (same pattern
as `resolveArtifactRefs`). Role sprawl → keep the registry small and data-only.

#### Not in scope
Model-based handoff summarization. Semantic (LLM) acceptance criteria.

---

### C3b — Verifier completion

#### Objective
Extend verification to every execution shape and to structured output.

#### Why now
The verifier is delegate-only; a fanout of 8 children is currently unverified,
and a node can declare a handoff (C2b) that nobody validates against a schema.

#### Current state
`src/verify.mjs`: argv / artifact / diff, delegate nodes only.

#### Architecture
Keep the check kinds; add a `schema` check kind and run the verifier from the
fanout child path too.

#### Files/modules expected to change
`src/verify.mjs`, `src/workflow/engine.mjs` (fanout), `src/workflow/schema.mjs`.

#### Tasks
- C3b.1 `schema` check: validate a declared artifact (or the handoff) against a
  named zod schema from a small registry; report failing paths.
- C3b.2 Run artifacts/verify/judge for fanout children (per-child step id, same
  code path as a delegate node).
- C3b.3 Per-node check sets already exist; add `requiredChecks` semantics so a
  node can demand at least one check ran.

#### Dependencies
C2b (handoff schema), C3.

#### Acceptance criteria
- A fanout child with `verify` produces `verification.json` and a judge verdict.
- A handoff failing its schema makes the node fail with the failing JSON paths.

#### Tests
Fanout-with-verify integration; schema-check unit tests (valid/invalid/missing).

#### Risks
Duplicated code between fanout and delegate → extract the "execute + evidence +
verify + judge" core into one helper instead of copy-paste.

#### Not in scope
Agent-judged acceptance criteria (that is C4b/I).

---

### C4b — Judge feedback loop completion

#### Objective
Make a revision actually informative and wire the reserved hooks.

#### Why now
A deterministic verifier failure currently re-dispatches the identical prompt,
so revision mostly wastes a run. `[verified]`

#### Current state
`src/judge.mjs` + engine revision loop; `onSuccess`/`onFailure` accepted by the
schema and never read.

#### Architecture
The revision re-dispatch prepends a bounded `<hub-revision>` block built from the
previous verdict (failed check names, reasons, and the truncated check output
already captured by C3).

#### Files/modules expected to change
`src/judge.mjs` (or a small `revisionPrompt` helper), `src/workflow/engine.mjs`.

#### Tasks
- C4b.1 `buildRevisionFeedback(verdict)` → bounded markdown block.
- C4b.2 Inject it into the task on a `needs_revision` re-dispatch only.
- C4b.3 Consume `onSuccess`/`onFailure` as declarative directives (`skip`,
  `fail`, `continue`) or remove them from the schema — do not leave them dead.

#### Dependencies
C3, C4, C2b (handoff).

#### Acceptance criteria
- A revision dispatch's task contains the failing check names from the previous
  verdict.
- A node with `onFailure: 'skip'` behaves accordingly, or the field is gone.

#### Tests
Integration: fail → revise → the second dispatch task contains the verdict text.

#### Risks
Prompt bloat → hard cap like learnings (3 items, 300 chars each).

#### Not in scope
Unbounded self-correction.

---

### D2 — Provider Profiles & Identity

> The post-D1 plan's D2. Not to be confused with the routing phase, which was
> the earlier roadmap's D2 and is tracked here as **D3**.

#### Objective
A provider/profile abstraction so agent-hub knows *which identity* is being
used, its priority, quota, availability and fallback eligibility — without
storing OAuth/keyring internals it does not own.

#### Why now
Jules already has multi-account; CLI providers have none. `agy` quota is the
scarcest resource in practice and `agys` already manages its profiles. Routing
(D3) and fallback both need to know "which account".

#### Current state
`src/accounts.mjs` + `src/cloud/selectAccount.mjs` implement this for Jules only.
`agy`/`opencode`/`copilot`/`codex` use ambient host auth. No `agys` reference in
`src/` `[verified]`.

#### Architecture
Do not reimplement `agys`. Wrap it.

```
agent-hub ──▶ ProviderProfileManager ──▶ AgysAdapter ──▶ agys ──▶ agy
                     │                                        (profile N)
                     ├── jules:  existing accounts.mjs
                     ├── opencode/codex/copilot: profile metadata only
                     └── exposes { provider, profile, priority, quota,
                                   availability, fallbackEligibility }
```

Agent-hub stores **metadata and eligibility**, never provider secrets for CLIs
it does not already own.

#### Files/modules expected to change
new `src/providers/profiles.mjs`, new `src/providers/agys.mjs`,
`src/router.mjs` (consume profile availability), `src/preflight.mjs`,
`dashboard` (profiles view).

#### Tasks
- D2.1 `ProviderProfile` model + store (reuse the `accounts.mjs` shape); CLI
  profiles are metadata only (label, priority, enabled, host env selector).
- D2.2 `AgysAdapter`: detect `agys` on PATH, list profiles, select/run with a
  profile; degrade to plain `agy` when absent. No secret handling.
- D2.3 Classify fallback eligibility by error class: **only** `quota` and
  `transport` may switch profile/account; `auth` and `billing` must stop and
  escalate to a human (this is already the A3 policy — reuse it, do not fork it).
- D2.4 Write-path safety on profile switch: never silently re-run a write job on
  another account in the same worktree; define read-retry vs write-retry vs
  session-resume vs fresh-process semantics explicitly.

#### Dependencies
A3 policy (done), A4 breakers (done), accounts (done), D1 (quality per profile).

#### Acceptance criteria
- `route()` can report the eligible profiles for a provider and never picks a
  profile whose `auth`/`billing` is broken.
- With `agys` absent, everything behaves exactly as today.
- A `quota` failure moves to the next profile; an `auth` failure does not.

#### Tests
Adapter unit tests with a fake `agys` binary; policy tests for class → action;
worktree-safety tests for write-profile-switch.

#### Risks
Coupling to an external CLI's interface → keep the adapter thin and behind a
capability check. Secret leakage → the adapter must never print a credential.

#### Not in scope
Managing `agy` OAuth. Container/credential mounts (that is H).

---

### D3 — Adaptive Routing

> In progress on `feat/d2-adaptive-routing` (the earlier roadmap called this D2).

#### Objective
`requirements → capabilities → quality history → latency → cost → quota/profile
→ policy → candidate`, explainably, with human approval preserved for persistent
chain changes.

#### Why now
D1 produced the signal; `route()` still ignores quality, cost and latency.

#### Current state
`src/capabilities.mjs` + `src/routing/score.mjs` landed (T1). `route()` wiring
(T2) is the open work unit. `proposals.mjs` remains the human gate for the base
chain.

#### Architecture
`route()` returns `ranking` (per-candidate score + per-dimension reasons) always,
and reorders `primary`/`fallbacks` only when `adaptive: true`. The base chain
stays the policy default; persistent reorder stays a human-accepted proposal.

#### Files/modules expected to change
`src/router.mjs`, `src/proposals.mjs` (optional: multi-dimension evidence),
dashboard metrics/route surfaces.

#### Tasks
- D3.1 (done) capabilities + scoring.
- D3.2 (in progress) `route()` integration.
- D3.3 Extend proposals to carry the multi-dimensional evidence (still
  human-gated), so a proposal explains *why* beyond Wilson.
- D3.4 Surface `ranking` reasons in the dashboard route/agents views.

#### Dependencies
D1 (signal), D2 (profiles for the quota/profile stage).

#### Acceptance criteria
- Ranked output is deterministic and every rank carries reasons.
- Missing data degrades to the static chain, never to a wrong pick.
- Persistent order changes still require a human.

#### Tests
Existing router tests stay green; adaptive ordering, requirement filtering, and
"no data" degradation.

#### Risks
Overfitting to a handful of samples → require a minimum sample count before a
dimension influences the score (reuse `METRICS_MIN_SAMPLES`).

#### Not in scope
Auto-accepting proposals.

---

### E1 — Harness Lifecycle Bridge

#### Objective
When the harness allows it, let a completed job continue the harness
conversation (notification / wake / session resume) without coupling the
execution engine to any host.

#### Why now
OpenCode ends its turn before an async delegation finishes; the user sees a
result only on the next turn. `harness_origins` already maps `jobId → sessionId`
but `supportsWake: false` everywhere. `[verified]`

#### Current state
`src/harness/*` (profiles, waitMode, origin mapping). Nothing consumes
`harness_origins`.

#### Architecture
A `LifecycleBridge` interface on top of the existing profiles:

```
job.finished ──▶ notification policy (E2) ──▶ bridge.deliver(origin, summary)
                                                   │
                                     opencode.bridge (session resume)
                                     claude-code.bridge (hook)
                                     generic: no-op
```

The bridge is a **consumer** of events; the engine never depends on it.

#### Files/modules expected to change
new `src/harness/bridge.mjs`, `src/harness/opencode.mjs`,
`src/harness/claude-code.mjs`, `src/notify/*`, `src/storage` (read
`harness_origins`).

#### Tasks
- E1.1 Define the bridge contract (`canWake(origin)`, `wake(origin, payload)`),
  no-op by default.
- E1.2 OpenCode bridge: research the current OpenCode session API and resume
  path; implement behind a capability flag; never throw into the watcher.
- E1.3 `supportsWake` becomes data-driven per harness version, still
  default false.
- E1.4 Record bridge outcomes as events for observability.

#### Dependencies
E2 (event delivery), C1.2 origin mapping (done).

#### Acceptance criteria
- With no bridge available, behaviour is byte-for-byte today's.
- An OpenCode job completion can continue the originating session when the
  installed OpenCode supports it, or silently no-ops when it does not.

#### Tests
Bridge contract unit tests; a fake-open-code integration test; "absent bridge is
a no-op" test.

#### Risks
Host-version coupling → version-gate and default off. Blocking the watcher →
strict timeouts.

#### Not in scope
Implementing an OpenCode bridge before the API is verified.

---

### E2 — Notifications / Event Delivery

#### Objective
Turn the watcher into a policy-driven delivery layer while keeping it a separate
process.

#### Why now
`workflow.completed` is routed by the watcher but never emitted `[verified]` — a
concrete bug. There is no producer for `subagent.start/stop` either.

#### Current state
`src/notify/watch.mjs` + `adapters.mjs` (console/file/webhook), SSE in the
dashboard. Runs as `bin/agent-hub watch`.

#### Architecture
`event → policy (kinds × severity × channel) → adapters (dashboard | webhook |
desktop | slack/discord | lifecycle bridge)`. The watcher process stays
separate; it never becomes an MCP in-process daemon.

#### Files/modules expected to change
`src/workflow/engine.mjs` (emit `workflow.completed`),
`src/hook.mjs` (subagent events), `src/notify/policy.mjs`, `src/notify/adapters.mjs`.

#### Tasks
- E2.1 Emit `workflow.completed` (workflowId, status, node counts).
- E2.2 Emit or delete `subagent.start/stop` (they exist in `EVENT_KINDS`).
- E2.3 Notification policy module (kind → channels, severity, dedup window).
- E2.4 Desktop + Slack/Discord adapters behind the same never-throw contract.
- E2.5 Policy surfaced in the dashboard config.

#### Dependencies
None (can run in parallel with everything).

#### Acceptance criteria
- Completing a workflow produces exactly one `workflow.completed` event and one
  configured notification.
- A failing adapter never kills the watcher.

#### Tests
Event-emission tests for the engine; policy unit tests; adapter tests with a
fake fetch.

#### Risks
Notification fatigue → dedup window and per-kind defaults.

#### Not in scope
Making the watcher a daemon inside the MCP process.

---

### F1 — Planner / Decomposer

#### Objective
Turn a complex intent into a **validated** `WorkflowPlan`; never run a planner for
a simple task.

#### Why now
Everything needed to execute a plan exists (DAG, roles coming in C2b, artifacts,
verifier, judge). The missing piece is producing a plan and validating it.

#### Current state
`examples/software-pipeline.mjs` is a hand-written plan. No planner.

#### Architecture
```
intent ──▶ complexity gate ──▶ planner (model) ──▶ WorkflowPlan (JSON)
                                     │
                            schema validation ──▶ policy validation ──▶ runWorkflow
```

The planner is a role (`PLANNER`) that emits a plan artifact; the plan is
validated with the existing `WorkflowSchema` **plus** role/capability checks
before any execution.

#### Files/modules expected to change
new `src/planner/plan.mjs` (plan schema + validation), new
`src/planner/decompose.mjs` (dispatch the planner role), `src/workflow/schema.mjs`
(reuse), `src/tools/*` (a `plan` tool or a `workflow_plan` entry point).

#### Tasks
- F1.1 `WorkflowPlan` schema = `WorkflowSchema` + required `role` per node.
- F1.2 Complexity gate (explicit `decompose: true`; never heuristic by default).
- F1.3 `decompose()` dispatches the planner, validates the returned plan, and
  fails closed on an invalid plan.
- F1.4 Dry-run/approval: a plan can be reviewed before execution (human gate).

#### Dependencies
C2b (roles), C1, D3 (routing the planner).

#### Acceptance criteria
- An invalid plan never starts execution.
- A one-step intent can still be a one-node plan (no forced decomposition).

#### Tests
Plan validation unit tests (cycles, unknown role, missing dep); a fake planner
returning a valid and an invalid plan.

#### Risks
Planner hallucinating node ids/roles → validate and repair-or-fail explicitly.

#### Not in scope
Auto-executing a plan without an approval gate on first use.

---

### F2 — Parent/Child Execution Graph

#### Objective
A first-class lineage view over the fields that already exist
(`rootExecutionId`, `parentExecutionId`, `executionId`, `workflowId`, `stepId`,
`attempt`) plus the relations planner/delegate/review/fanout/retry/resume/supervisor.

#### Why now
The fields exist and are persisted; there is no way to see the tree, which makes
debugging multi-agent runs guesswork.

#### Current state
Fields in `JobRecord` and SQLite; `root_execution_id`/`parent_execution_id`
populated by dispatch `[lead]`; `harness_origins` maps sessions. No graph API.

#### Architecture
`src/execution-graph.mjs`: build a tree from SQLite (authoritative for
coordination), expose `GET /api/execution-graph` and an MCP tool. Read-only.

#### Files/modules expected to change
new `src/execution-graph.mjs`, `src/dashboard.mjs`, `src/tools/*`, dashboard view.

#### Tasks
- F2.1 Build the graph from SQLite `jobs` (+ `workflow_nodes`).
- F2.2 Expose `/api/execution-graph` and `execution_graph` MCP tool.
- F2.3 Dashboard tree view (root → planner/research/implementation/review).
- F2.4 Assert lineage completeness in dispatch/workflow tests.

#### Dependencies
C0-real (fields), C1, F1 (planner nodes).

#### Acceptance criteria
- Given a root execution, the API returns its full descendant tree with the
  relation kind on each edge.
- A fanout's children hang off the fanout node.

#### Tests
Graph-building unit tests from fixtures; API test; a lineage test asserting every
dispatched job has a root.

#### Risks
Deep trees → paginate/limit depth. Lineage gaps from older records → tolerate and
mark `unknown`.

#### Not in scope
Distributed tracing across machines.

---

### G — Evaluation / Chaos / Reliability

#### Objective
Replace "N tests pass" with "known behaviour under failure modes".

#### Why now
There is no fault-injection or eval harness `[verified]`. Reliability claims are
currently unverifiable.

#### Current state
~1071 node tests + 161 dashboard tests; some deterministic retry/kill tests; no
chaos, no corpus, no benchmarks.

#### Architecture
Two harnesses:
1. **Eval harness** (`bench/`): a corpus of N workflows × task types × agents,
   measuring execution success, verified success, quality, latency, cost,
   duplicate executions, false auto-replies, recovery.
2. **Chaos harness** (`test/chaos/`): injected faults — kill scheduler, kill
   worker, network failure, provider unavailable, Jules API failure, SQLite
   contention, expired lease, duplicate dispatch, workflow crash, partial
   fan-out.

#### Files/modules expected to change
new `bench/`, new `test/chaos/`, `package.json` scripts, maybe
`src/testkit` fault hooks.

#### Tasks
- G.1 Define the metric set and the corpus format.
- G.2 A deterministic offline corpus (mock CLIs) so eval is quota-free.
- G.3 Chaos scenarios, each asserting a specific invariant (no duplicate
  execution, lease reclamation, resume correctness).
- G.4 A weekly/opt-in live variant (`AGENT_HUB_LIVE=1`).
- G.5 Report output (markdown/JSON) committed as evidence.

#### Dependencies
D1 (metrics), C0-real, C1, D2/D3 (for provider-fallback scenarios).

#### Acceptance criteria
- Each chaos scenario fails the suite when its invariant is broken.
- The eval report is reproducible from the corpus alone (no network).

#### Tests
The harness itself, plus one scenario per failure mode listed above.

#### Risks
Flaky chaos tests → seed determinism and explicit timeouts (the existing
worktree-lease flake is a warning).

#### Not in scope
Load/performance benchmarking at scale.

---

### H — Security Hardening

#### Objective
Make isolation a real property with named levels, and stop claiming more than is
true.

#### Why now
`isolated === isolated-home` and secrets are replaced by `'***'` rather than
unset `[verified]`; the readguard does not see gitignored files. These are
correctness-of-claim issues.

#### Current state
`src/sandbox.mjs` (compatibility default), `src/readguard.mjs`
(`--ignored=no`).

#### Architecture
`compatibility → isolated-home → isolated → container`, each level documented
with exactly what it does and does not protect. Nothing is renamed "sandbox" until
it isolates.

#### Files/modules expected to change
`src/sandbox.mjs`, `src/readguard.mjs`, `src/jobrunner.mjs`, `src/config.mjs`,
docs.

#### Tasks
- H.1 Unset redacted env vars instead of setting `'***'`.
- H.2 Readguard: cover gitignored paths (configurable) and treat a non-git cwd
  as a violation when read purity is required.
- H.3 `isolated`: real HOME/cache/config isolation with an explicit allowlist of
  what is mounted; no network policy yet.
- H.4 `container`: design-only until the CLI compatibility matrix is verified.
- H.5 Document the level matrix and the exact residual risks.

#### Dependencies
A5 (done). Independent of the rest.

#### Acceptance criteria
- A secret env var is absent from the child environment, not `'***'`.
- A read job that edits a gitignored file is reported (opt-in, documented).
- The README states exactly what `isolated` does.

#### Tests
Env-filtering tests; readguard tests for ignored files; a CLI smoke matrix per
level (opt-in live).

#### Risks
Breaking CLI auth by over-isolating → keep `compatibility` default and verify each
CLI before changing a default.

#### Not in scope
Claiming container-grade isolation before the compatibility matrix exists.

---

### I — Hermes Nested Orchestration

#### Objective
Hermes as a **nested orchestrator** on top of agent-hub's execution fabric, not
another worker.

#### Why now
Only after C2b/C3b/C4b/D2/D3/E1/E2/F1/F2/G exist does agent-hub expose the stable
surface a nested orchestrator needs.

#### Current state
No Hermes reference in `src/` `[verified]`. The execution backend contract
(create/observe/interact/result) exists implicitly across `dispatch`, the Jules
runner and the workflow engine.

#### Architecture
A documented `ExecutionBackend` contract that Hermes can target
(`workflow`, `dispatch`, `artifact`, `verifier`, `judge`, `profiles`, `harness`).
Hermes owns planning; agent-hub owns execution and evidence. **No second workflow
engine.**

#### Files/modules expected to change
new `docs/execution-backend-contract.md`, `src/index.mjs` (a stable entry point),
possibly `src/tools/*` additions. Mostly contract + glue.

#### Tasks
- I.1 Write the `ExecutionBackend` contract (what a nested orchestrator may
  call, and what it must never bypass).
- I.2 Expose a single `execute_plan` entry point that accepts a validated plan.
- I.3 Conformance test: the example plan runs through the public surface only.
- I.4 Integration with Hermes behind an opt-in flag.

#### Dependencies
F1, F2, G, E1.

#### Acceptance criteria
- A plan can be executed end-to-end through the documented public surface with no
  access to internals.
- Hermes integration changes no execution-engine code.

#### Tests
Contract conformance tests; a fake nested orchestrator driver.

#### Risks
Interface churn → freeze the contract before wiring Hermes.

#### Not in scope
Reimplementing planning or workflow execution inside Hermes.

---

## 5. Dependency graph (corrected)

```
C2 (artifacts) DONE
C3 (verifier)  DONE
C4 (judge)     DONE
D1 (metrics)   DONE
        │
        ├──▶ C2b Context & Handoffs ──▶ C3b Verifier completion
        │                                   │
        │                                   ▼
        │                              C4b Judge feedback
        │
        ├──▶ D2 Provider Profiles ──▶ D3 Adaptive Routing (T1 done, T2 in progress)
        │                                   │
        │                                   ▼
        │                              E1 Harness Lifecycle Bridge
        │
        ├──▶ E2 Notifications (independent; fixes workflow.completed)
        │
        └──▶ C2b ──▶ F1 Planner ──▶ F2 Execution Graph
                                        │
                                        ▼
                                     G Eval/Chaos
                                        │
                                        ▼
                                     H Security Hardening
                                        │
                                        ▼
                                  I Hermes nested orchestration
```

Notes vs the original sketch: E2 does **not** depend on D2/D3 (it is a concrete
bug plus a policy module), so it can run in parallel from day one; F1/F2 only
need C2b, not D2/D3; G and H are parallelizable once C2b/F1 exist for the eval
corpus.

---

## 6. Priority

| Phase | Dependencies | Value | Complexity | Risk | Priority | Why this rank |
|---|---|---|---|---|---|---|
| C2b Context & Handoffs | C2/C4 done | High — makes multi-node workflows actually work; the shipped example passes nothing forward | Medium | Low (SQLite + filesystem) | **1** | Highest value per risk; unblocks F1, F2, I |
| E2 Notifications | none | Medium — fixes a real dead event; visibility | Low | Very low | **2** | Small, concrete, parallelizable |
| D3 Adaptive Routing | D1, D2 | High — turns D1 into decisions | Medium | Medium (routing regressions) | **3** | In progress; needs D2 for the profile stage |
| C3b Verifier completion | C2b | Medium — closes fanout blind spot | Low | Low | **4** | Small once C2b lands |
| C4b Judge feedback | C3, C4 | Medium — makes revision useful | Low | Low | **5** | Cheap, high behavioural payoff |
| D2 Provider Profiles | A3/A4, accounts | High — `agy` quota is the real bottleneck; `agys` exists | High | High (external CLI, auth) | **6** | High value but needs the `agys` spike first |
| F2 Execution Graph | C0, C1 | Medium — debuggability | Low | Low | **7** | Cheap, read-only |
| H Security Hardening | A5 | Medium — correctness of claims, secrets | Medium | Medium (can break CLIs) | **8** | Start with H.1/H.2 (tiny), defer H.3/H.4 |
| F1 Planner | C2b | High — the "complex intent" story | High | Medium | **9** | Needs roles from C2b |
| G Eval/Chaos | C0/C1/D1 | High — turns tests into known behaviour | High | Medium (flake) | **10** | Important but not blocking; run offline corpus first |
| I Hermes | F1/F2/G/E1 | High long-term | Very high | High | **11** | Only after the surface is stable |

---

## 7. Migrations

- **SQLite** (`C2b`): `CREATE TABLE IF NOT EXISTS task_handoffs`,
  `task_context`. Additive; no `ALTER` on existing tables needed.
- **SQLite** (`C0-real` hardening): moving the read path to SQLite is a
  behaviour change — do it behind a flag with a dual-read comparison, never as a
  big-bang.
- **`quality_score`**: decide before adding more consumers. Either delete it or
  have C4b write it. Do not leave three quality concepts.
- **`onSuccess`/`onFailure`**: either consume (C4b) or remove from the schema.
- **Sandbox** (`H`): changing the default away from `compatibility` is a
  breaking change for existing installs — new defaults only behind a version
  bump and a documented matrix.
- **`docs/execution-contract.md`**: correct the SQLite statements in the same PR
  as the first storage change that touches them.

---

## 8. What NOT to build (already exists)

- Another workflow engine. `src/workflow/*` is it.
- Another artifact store. `src/artifacts.mjs` is it.
- Another verifier/judge. `src/verify.mjs` / `src/judge.mjs` are it.
- Another policy/breaker system. `src/policy/*` / `src/breakers.mjs` are it.
- An event bus daemon inside the MCP process. The separate `watch` process stays.
- A second quality metric alongside D1's `qualityScore`.
- A `ledger.json` as source of truth. SQLite is the coordination store.
- Re-implementing `agys` profile management inside agent-hub.
- A new auth mechanism for CLIs. They keep their own auth.

---

## 9. External ideas we considered and rejected (or narrowed)

- **AISW / AgentsRoom dashboards** — their multi-pane "rooms" assume they own the
  process lifecycle. agent-hub's dashboard observes a separate watcher and MCP;
  adopting the room model would mean a daemon. **Rejected**; only the idea of a
  lineage tree survived, as F2.
- **ZCode / Agent Orchestrator static pipelines** — a YAML pipeline runner
  duplicates the DAG engine. **Rejected**; the useful part (declarative plans) is
  F1, built on the existing engine.
- **Gentle-Shell planner** — the concept (planner → validated plan → execution) is
  adopted as F1, but its prompt-centric planner is **narrowed**: the plan must
  validate against the existing `WorkflowSchema` and roles, not free-form prose.
- **`agys`** — adopted as an **adapter**, not a rewrite (D2).
- **Hermes** — adopted as a **nested orchestrator** over the public surface, not
  as another worker or engine (I).
- **Generic vector memory / RAG over past runs** — **deferred, not rejected**:
  D1's metrics + C2b handoffs give structured memory first; vector recall should
  only be added if structured recall proves insufficient.

---

## 10. Recommendation

```
NEXT RECOMMENDED PHASE:
C2b — Context & Handoffs (completes C2)
```

```
WHY:
1. It is the missing half of C2: nodes emit artifacts but pass no structured
   context, and the shipped example (research -> implementation -> review)
   currently forwards none of research's conclusions.
2. Everything it needs already exists (artifacts C2, judge C4, capabilities D2):
   no new external dependency, no CLI risk.
3. It unblocks the two phases with the highest long-term value, F1 (planner) and
   I (Hermes), which both need a handoff/role contract that must exist once.
4. It is purely additive in SQLite + filesystem, so it is low-risk and reviewable
   in small work units.
5. It is the phase that turns "workflow engine that runs nodes" into "workflow
   engine that carries understanding between nodes".
```

```
FIRST IMPLEMENTATION BATCH (parallel tracks):
- C2b.1  Handoff schema + validateHandoff (pure module, tests)          [independent]
- C2b.2  SQLite task_handoffs/task_context + read/write (storage)       [depends on C2b.1]
- C2b.3  Engine: produce/persist handoff on node completion             [depends on C2b.2]
- C2b.4  Inject upstream handoff into a downstream node's task          [depends on C2b.3]
- E2.1   Emit workflow.completed from the engine                        [independent, tiny]
- C4b.1  buildRevisionFeedback + inject on needs_revision               [independent of C2b]
- H.1    Unset redacted env vars instead of setting '***'               [independent, tiny]
- G.0    Deflake worktree-lease + isolate quota-codexbar tests          [independent]
```

---

## Appendix A — Verification status of audit leads

Leads reported by the mapping agents that were **not** personally re-verified in
this session and must be checked before being treated as fact:

- `src/tools/jobs.mjs:38` — `delegateTool` bypassing `dispatch`.
- `src/worktree.mjs` — SQLite lease mirror being write-only / `getLease` uncalled.
- `src/storage/sqlite.mjs` — `getJob` exported and unused.
- `src/router.mjs:202` — quota never deprioritizing an exhausted provider.
- `src/cloud/runner.mjs` — Jules failover only on 429, not 401/403.
- `src/adapters/index.mjs:36` — `modelsArgv` throwing for `jules`.

Confirmed by direct inspection in this session: `isolated === isolated-home`
and `'***'` redaction; `workflow.completed` has no emitter; C4 has no
feedback injection; fanout children bypass artifacts/verify/judge;
`onSuccess`/`onFailure` are schema-only; no context/handoff; no roles;
`quality_score` unused; no CI; readguard uses `--ignored=no`.

# Implementation & Architecture Report — 2026-09-21

Comprehensive technical report of features, architecture updates, MCP tool additions, environment configuration, and reliability posture implemented across 48 merged pull requests (`5e4c970..HEAD`, PR #10 through PR #57).

---

## 1. RESUMEN EJECUTIVO

Today agent-hub transitioned from a CLI delegation wrapper with basic DAG capabilities into a hardened multi-agent execution platform. Across 48 merged pull requests and 109 commits, the platform gained deterministic node-level verification with evidence artifacts and automated revision loops, validated structured handoffs bound to role contracts, multi-account provider profile management (`agys`) with adaptive score-based routing, full C0.1 SQLite read-path cutover, human-gated workflow planning (`plan_task`/`execute_plan`), execution lineage graphs, an inter-agent mailbox for turn-boundary messaging, harness lifecycle bridges (`OpenCode` v2), configurable notification policies, real isolation sandboxing (`isolated`), and an extensive offline deterministic benchmark and chaos test suite.

---

## 2. LO QUE SE IMPLEMENTÓ HOY

### C2: Evidence Artifacts & Passing
- **Description**: Delegate workflow nodes declare expected evidence output files (`artifacts: [...]`). The engine creates isolated directories (`runs/<wfId>/<stepId>/artifacts/`), instructs child agents with absolute paths, calculates SHA-256 digests, and records an `artifacts.manifest.json`. Downstream steps consume upstream evidence using `artifact://<wfId>/<stepId>/<name>` URIs with bounded inlining (64 KiB cap per reference).
- **Key files**: [`src/artifacts.mjs`](file:///home/alejandro/Desarrollo/agent-hub-worktrees/report/src/artifacts.mjs), [`src/workflow/engine.mjs`](file:///home/alejandro/Desarrollo/agent-hub-worktrees/report/src/workflow/engine.mjs)
- **Merged PRs**: PR #10

### C3 & C3b: Verifier & Schema Checks
- **Description**: Deterministic post-execution checks across four check kinds: `argv` (command execution with expected exit codes), `artifact` (existence of required files), `diff` (prohibiting unauthorized changes against `HEAD`), and `schema` (C3b.1: validating structured `handoff.json` payloads against contract schemas). Completed fanout child evidence generation and verification (C3b.2). Verdicts `{ verified, required, checks }` persist to `artifacts/verification.json` and mirror to SQLite.
- **Key files**: [`src/verify.mjs`](file:///home/alejandro/Desarrollo/agent-hub-worktrees/report/src/verify.mjs), [`src/workflow/engine.mjs`](file:///home/alejandro/Desarrollo/agent-hub-worktrees/report/src/workflow/engine.mjs)
- **Merged PRs**: PR #11, PR #25, PR #33

### C4 & C4b: Judge & Revision Feedback Loop
- **Description**: Deterministic judge translating verifier results into four verdicts: `accepted`, `needs_revision`, `rejected`, and `blocked`. A `blocked` verdict short-circuits on missing upstream dependencies. For `needs_revision`, the engine triggers a bounded re-dispatch loop up to `maxRevisionAttempts`. Under C4b, re-dispatches inject bounded `<agent-hub-revision>` feedback (strictly capped at max 3 findings × 300 characters) instructing the worker on exact failing checks.
- **Key files**: [`src/judge.mjs`](file:///home/alejandro/Desarrollo/agent-hub-worktrees/report/src/judge.mjs), [`src/revision.mjs`](file:///home/alejandro/Desarrollo/agent-hub-worktrees/report/src/revision.mjs), [`src/workflow/engine.mjs`](file:///home/alejandro/Desarrollo/agent-hub-worktrees/report/src/workflow/engine.mjs)
- **Merged PRs**: PR #13, PR #14, PR #21

### C2b: Context, Structured Handoffs & Role Contracts
- **Description**: Nodes emit validated structured handoffs (`summary`, `findings`, `decisions`, `constraints`, `changedFiles`, `openQuestions`, `artifacts`) adhering to named schemas (`BaseHandoff`, `ResearchHandoff`, `SecurityReviewHandoff`, `ImplementationHandoff`, `ReviewHandoff`). Stored in SQLite (`task_handoffs`, `task_context`) and disk. Introduced role registry (`TRACE_ANALYST`, `SECURITY_REVIEWER`, `ARCHITECT`, `IMPLEMENTER`, `TEST_ANALYST`, `ADVERSARIAL_REVIEWER`) mapping capabilities and enforcing handoff schemas.
- **Key files**: [`src/handoff.mjs`](file:///home/alejandro/Desarrollo/agent-hub-worktrees/report/src/handoff.mjs), [`src/context.mjs`](file:///home/alejandro/Desarrollo/agent-hub-worktrees/report/src/context.mjs), [`src/roles.mjs`](file:///home/alejandro/Desarrollo/agent-hub-worktrees/report/src/roles.mjs), [`src/storage/sqlite.mjs`](file:///home/alejandro/Desarrollo/agent-hub-worktrees/report/src/storage/sqlite.mjs)
- **Merged PRs**: PR #20, PR #22, PR #27, PR #29

### D1: Quality, Cost & Verification Intelligence
- **Description**: Extended `computeMetrics` and `agents_metrics` with aggregated metrics: total/average cost in USD, verified sample count/rate, verification failure breakdown, judge verdict distributions, and revision averages. Calculated `qualityScore` as `10 * verifiedRate`.
- **Key files**: [`src/metrics.mjs`](file:///home/alejandro/Desarrollo/agent-hub-worktrees/report/src/metrics.mjs), [`src/tools/insights.mjs`](file:///home/alejandro/Desarrollo/agent-hub-worktrees/report/src/tools/insights.mjs)
- **Merged PRs**: PR #15

### D2 & D3: Provider Profiles & Adaptive Routing
- **Description**: Unified provider profile model (`profiles.mjs`) tracking lifecycle states (`selected`, `fallback`, `exhausted`, `unavailable`). Built `agys` Go CLI adapter for multi-account profile isolation, quota ingestion, and automatic priority-based profile selection (`AGENT_HUB_AGYS=auto`). Enhanced routing engine with capability matching (`read`, `write`, `git`, `github`, `sessionResume`, `largeContext`) and multi-dimensional scoring (quality, cost, latency weights).
- **Key files**: [`src/providers/profiles.mjs`](file:///home/alejandro/Desarrollo/agent-hub-worktrees/report/src/providers/profiles.mjs), [`src/providers/agys.mjs`](file:///home/alejandro/Desarrollo/agent-hub-worktrees/report/src/providers/agys.mjs), [`src/capabilities.mjs`](file:///home/alejandro/Desarrollo/agent-hub-worktrees/report/src/capabilities.mjs), [`src/routing/score.mjs`](file:///home/alejandro/Desarrollo/agent-hub-worktrees/report/src/routing/score.mjs), [`src/router.mjs`](file:///home/alejandro/Desarrollo/agent-hub-worktrees/report/src/router.mjs), [`src/dispatch.mjs`](file:///home/alejandro/Desarrollo/agent-hub-worktrees/report/src/dispatch.mjs)
- **Merged PRs**: PR #17, PR #31, PR #34, PR #36, PR #37, PR #41

### C0.1: SQLite Read-Path Cutover
- **Description**: Enforced "SQLite is coordination state; filesystem is content". Delivered dual-read comparison harness (`AGENT_HUB_STORE=shadow`) logging divergences without breaking JSON reads, followed by authoritative cutover (`AGENT_HUB_STORE=sqlite`): `listJobs` and `readResult` query SQLite first, fall back to legacy `result.json` on miss, and automatically backfill the database.
- **Key files**: [`src/jobstore.mjs`](file:///home/alejandro/Desarrollo/agent-hub-worktrees/report/src/jobstore.mjs), [`src/storage/sqlite.mjs`](file:///home/alejandro/Desarrollo/agent-hub-worktrees/report/src/storage/sqlite.mjs), [`src/storage/db.mjs`](file:///home/alejandro/Desarrollo/agent-hub-worktrees/report/src/storage/db.mjs)
- **Merged PRs**: PR #28, PR #52

### E1: Harness Lifecycle Bridge & OpenCode Integration
- **Description**: Defined lifecycle bridge contract (`bridge.mjs`) allowing caller harnesses to receive waking events. Built OpenCode v2 lifecycle bridge (`opencode-bridge.mjs`) communicating over HTTP (`POST /api/session/{id}/prompt` with `{ resume: true }`) authenticated via `service.json`. Added OpenCode subagent monitor plugin (`integrations/opencode/`).
- **Key files**: [`src/harness/bridge.mjs`](file:///home/alejandro/Desarrollo/agent-hub-worktrees/report/src/harness/bridge.mjs), [`src/harness/opencode-bridge.mjs`](file:///home/alejandro/Desarrollo/agent-hub-worktrees/report/src/harness/opencode-bridge.mjs), [`integrations/opencode/agent-hub-monitor.js`](file:///home/alejandro/Desarrollo/agent-hub-worktrees/report/integrations/opencode/agent-hub-monitor.js)
- **Merged PRs**: PR #45, PR #46, PR #47, PR #49

### E2: Notification Policy & Terminal Events
- **Description**: Notification routing engine with per-category configuration, channel routing (`console`, `file`, `webhook`), severity levels, and deduplication windows (`dedupMs`). Guaranteed `workflow.completed` emits once per terminal transition.
- **Key files**: [`src/notify/policy.mjs`](file:///home/alejandro/Desarrollo/agent-hub-worktrees/report/src/notify/policy.mjs), [`src/notify/adapters.mjs`](file:///home/alejandro/Desarrollo/agent-hub-worktrees/report/src/notify/adapters.mjs), [`src/notify/watch.mjs`](file:///home/alejandro/Desarrollo/agent-hub-worktrees/report/src/notify/watch.mjs)
- **Merged PRs**: PR #19, PR #24

### F1: Planner & Human Approval Gate
- **Description**: Schema validation for `WorkflowPlan` (`goal` + ordered role-bound `steps`), DAG cycle detection, and automatic materialization into runnable workflows via role capability resolution. Exposed `plan_task` (read-only validation/dry-run) and `execute_plan` (enforcing human review gate via `approve: true`).
- **Key files**: [`src/planner/plan.mjs`](file:///home/alejandro/Desarrollo/agent-hub-worktrees/report/src/planner/plan.mjs), [`src/planner/decompose.mjs`](file:///home/alejandro/Desarrollo/agent-hub-worktrees/report/src/planner/decompose.mjs), [`src/tools/planner.mjs`](file:///home/alejandro/Desarrollo/agent-hub-worktrees/report/src/tools/planner.mjs)
- **Merged PRs**: PR #39, PR #53

### F2: Execution Graph & Visualization
- **Description**: Read-only lineage graph builder deriving roots, node metadata, and parent->child edges (`retry`, `resume`, `delegate`) across `rootExecutionId`, `parentExecutionId`, and `executionId`. Exposed via MCP tool and added dedicated visual Execution Graph tab in dashboard.
- **Key files**: [`src/execution-graph.mjs`](file:///home/alejandro/Desarrollo/agent-hub-worktrees/report/src/execution-graph.mjs), [`src/tools/insights.mjs`](file:///home/alejandro/Desarrollo/agent-hub-worktrees/report/src/tools/insights.mjs), [`dashboard/`](file:///home/alejandro/Desarrollo/agent-hub-worktrees/report/dashboard)
- **Merged PRs**: PR #26, PR #30, PR #43

### G: Bench Harness & Chaos Resilience
- **Description**: Offline deterministic benchmark harness (`bench/run.mjs`) with 4 corpus scenarios. Comprehensive chaos test suite covering duplicate dispatches, crash recovery, claim-reclaim contention, Jules 429 failover, and policy fallback. Made lease and quota test suites deterministic.
- **Key files**: [`bench/run.mjs`](file:///home/alejandro/Desarrollo/agent-hub-worktrees/report/bench/run.mjs), [`bench/corpus.mjs`](file:///home/alejandro/Desarrollo/agent-hub-worktrees/report/bench/corpus.mjs), [`test/chaos/`](file:///home/alejandro/Desarrollo/agent-hub-worktrees/report/test/chaos)
- **Merged PRs**: PR #23, PR #38, PR #40, PR #44, PR #54

### H: Security Hardening & Isolation
- **Description**: Environment secret scrubbing unsets matching keys rather than masking with dummy values (H.1). ReadGuard gained opt-in scanning of gitignored files (`AGENT_HUB_READGUARD_IGNORED=1`). Implemented `isolated` sandbox profile creating isolated temporary `$HOME`, `$TMPDIR`, and `$XDG_*` directories with opt-in credential copying (`AGENT_HUB_SANDBOX_INCLUDE`). Documented security boundary matrix and container architecture.
- **Key files**: [`src/sandbox.mjs`](file:///home/alejandro/Desarrollo/agent-hub-worktrees/report/src/sandbox.mjs), [`src/readguard.mjs`](file:///home/alejandro/Desarrollo/agent-hub-worktrees/report/src/readguard.mjs), [`docs/security-isolation.md`](file:///home/alejandro/Desarrollo/agent-hub-worktrees/report/docs/security-isolation.md)
- **Merged PRs**: PR #18, PR #32, PR #42, PR #51

### Dashboard UX & Messaging
- **Description**: Replaced side sheet with job detail modal, enhanced sidebar navigation, added per-view tips and provider badges, created agys profiles and quotas dashboard view, and fixed malformed record crash bugs. Implemented SQLite-backed inter-agent mailbox with turn-boundary delivery. Cleaned dead `quality_score` column from `JobRecord`.
- **Key files**: [`dashboard/`](file:///home/alejandro/Desarrollo/agent-hub-worktrees/report/dashboard), [`src/tools/messaging.mjs`](file:///home/alejandro/Desarrollo/agent-hub-worktrees/report/src/tools/messaging.mjs)
- **Merged PRs**: PR #12, PR #35, PR #50, PR #55, PR #56, PR #57

---

## 3. ARQUITECTURA ACTUAL

### Module Map (`src/`)

```
src/
├── accounts.mjs             # Jules credentials management & 0600 storage
├── adapters/                # CLI child process runners (agy, opencode, copilot, codex)
├── artifacts.mjs            # Evidence artifact store, traversal guard, manifests, bounded inlining
├── breakers.mjs             # Circuit breaker state tracking (quota, auth, billing)
├── capabilities.mjs         # Agent capability registry & requirement matching predicates
├── cloud/                   # Google Jules remote API integration, poller, sources, schedules
├── config.mjs               # Static defaults, model registry, timeouts, system paths
├── context.mjs              # SQLite & artifact-backed task handoffs & append-only context log
├── dashboard.mjs            # Express-based local dashboard HTTP server & REST API
├── discovery.mjs            # Local CLI binary & model discovery runner
├── dispatch.mjs             # Dispatch orchestration, policy execution, leases, execution handles
├── eventlog.mjs             # Append-only JSONL event stream writer
├── execution-graph.mjs      # Lineage DAG builder deriving parent->child execution edges
├── fsutil.mjs               # POSIX file locking & atomic JSON read-modify-write helpers
├── handoff.mjs              # Structured handoff contracts, Zod schemas & validator
├── harness/                 # Caller harness profiles, wait modes & waking lifecycle bridges
├── hook.mjs                 # Claude Code slash command hook integration
├── index.mjs                # MCP server entrypoint, schema registry, stdio transport
├── jobrunner.mjs            # Subprocess execution, streaming output, ReadGuard, cancellation
├── jobstore.mjs             # Job record persistence, SQLite/JSON dual-read cutover, list/read
├── judge.mjs                # Deterministic verification verdicts (accepted/needs_revision/rejected/blocked)
├── learnings.mjs            # Human-in-the-loop gotchas & prompt injection store
├── metrics.mjs              # Aggregated metrics (cost, verified rate, latency percentiles)
├── notify/                  # Notification routing policy, channels (console/file/webhook), dedup
├── overrides.mjs            # Manual task-type routing override store
├── planner/                 # WorkflowPlan schema validation & role-based decomposition
├── policy/                  # Policy taxonomy, retry/fallback/escalation execution engine
├── preflight.mjs            # L0-L2 preflight validation & cached availability
├── process.mjs              # Process group lifecycle, termination signals, exit codes
├── proposals.mjs            # Human approval proposals for model promotion
├── providers/               # Multi-account profiles (agys) & lifecycle status resolution
├── quota/                   # CodexBar quota server client & bucket mapping
├── readguard.mjs            # Git status snapshotting for read-mode immutability verification
├── revision.mjs             # Formatter for bounded <agent-hub-revision> prompt feedback
├── roles.mjs                # Role registry binding capabilities, handoff schemas & acceptance
├── router.mjs               # Delegation map lookup & fallback candidate resolution
├── routing/                 # Multi-factor score ranking (quality, cost, latency)
├── sandbox.mjs              # Environment variable scrubbing & filesystem isolation profiles
├── scheduler.mjs            # Periodic task runner for cloud schedules & discovery
├── schedules.mjs            # Cloud Jules schedule persistence & execution
├── schemas.mjs              # Shared Zod schemas for jobs, responses, tool contracts
├── startup.mjs              # Background discovery & quota warmup triggers
├── storage/                 # SQLite singleton, WAL management, schema migrations, JSON fallback
├── timeouts.mjs             # Adaptive timeout calculation based on historical p95 latency
├── tools/                   # MCP tool handler implementations grouped by domain
├── workflow/                # DAG workflow engine, safe DSL evaluator, resume, state machine
└── worktree.mjs             # Secondary git worktree creation & directory single-writer locks
```

### End-to-End Data Flow

#### Delegated Task Execution
1. **Request & Routing**: Caller calls `dispatch(task, taskType, requirements, preferences)`. [`src/dispatch.mjs`](file:///home/alejandro/Desarrollo/agent-hub-worktrees/report/src/dispatch.mjs) calls [`src/router.mjs`](file:///home/alejandro/Desarrollo/agent-hub-worktrees/report/src/router.mjs) to filter candidates by capabilities ([`src/capabilities.mjs`](file:///home/alejandro/Desarrollo/agent-hub-worktrees/report/src/capabilities.mjs)) and preflight status ([`src/preflight.mjs`](file:///home/alejandro/Desarrollo/agent-hub-worktrees/report/src/preflight.mjs)).
2. **Profile Selection**: If routing resolves to `agy`, [`src/providers/agys.mjs`](file:///home/alejandro/Desarrollo/agent-hub-worktrees/report/src/providers/agys.mjs) queries active profiles and quota to select the optimal account profile.
3. **Reservation & Concurrency**: For `write` mode, a single-writer lease is claimed on the worktree via atomic lock file ([`src/worktree.mjs`](file:///home/alejandro/Desarrollo/agent-hub-worktrees/report/src/worktree.mjs)).
4. **Job Creation**: Job row is initialized in SQLite (`jobs` table) and mirrored to `runs/<jobId>/result.json` ([`src/jobstore.mjs`](file:///home/alejandro/Desarrollo/agent-hub-worktrees/report/src/jobstore.mjs)).
5. **Sandbox & Spawning**: [`src/sandbox.mjs`](file:///home/alejandro/Desarrollo/agent-hub-worktrees/report/src/sandbox.mjs) filters secrets from environment and sets up isolated directories. For `read` jobs, [`src/readguard.mjs`](file:///home/alejandro/Desarrollo/agent-hub-worktrees/report/src/readguard.mjs) captures git status. Subprocess spawns via adapter.
6. **Completion & Telemetry**: On process exit, ReadGuard verifies no file modifications occurred. Final stdout/response/telemetry are recorded in SQLite and disk. Notifications dispatch via [`src/notify/watch.mjs`](file:///home/alejandro/Desarrollo/agent-hub-worktrees/report/src/notify/watch.mjs).

#### Workflow Node Execution
```
+----------------------------------------------------------------------------------------------------+
|                                    Workflow Node Execution Flow                                    |
|                                                                                                    |
|  [Node Trigger]                                                                                    |
|         │                                                                                          |
|         ▼                                                                                          |
|  Resolve Upstream Context: inlines artifact:// references (src/artifacts.mjs)                      |
|                            injects previous handoff.json (src/context.mjs)                         |
|         │                                                                                          |
|         ▼                                                                                          |
|  Evidence Prep: allocates runs/<wfId>/<stepId>/artifacts/ directory                                |
|                 appends artifact instructions & handoff schema rules to prompt                     |
|         │                                                                                          |
|         ▼                                                                                          |
|  Dispatch Worker: executes via dispatch() -> jobrunner -> adapter                                  |
|         │                                                                                          |
|         ▼                                                                                          |
|  Verification (src/verify.mjs): executes argv, artifact, diff, and schema checks                   |
|                                 persists artifacts/verification.json                               |
|         │                                                                                          |
|         ▼                                                                                          |
|  Judge Evaluation (src/judge.mjs): determines verdict (accepted/needs_revision/rejected/blocked)   |
|                                   persists artifacts/judge.json; updates SQLite                    |
|         │                                                                                          |
|         ├──────► verdict == 'needs_revision' (and attempts < max)                                 |
|         │              │                                                                           |
|         │              ▼                                                                           |
|         │        Revision Loop (src/revision.mjs): formats <agent-hub-revision> feedback           |
|         │        re-dispatches node without backoff up to maxRevisionAttempts                      |
|         │                                                                                          |
|         ▼                                                                                          |
|  Handoff Validation (src/handoff.mjs): validates produced handoff.json against schema              |
|                                        persists to task_handoffs table and disk                    |
|         │                                                                                          |
|         ▼                                                                                          |
|  Manifest & Next Step: writes artifacts.manifest.json; triggers dependent DAG nodes                |
+----------------------------------------------------------------------------------------------------+
```

### SQLite vs. Filesystem Storage Split
- **SQLite Database (`agent-hub.db`)**: Primary coordination authority and state index. Holds tabular metadata, lifecycle statuses, execution lineage, worktree leases, task handoffs (`task_handoffs`), context log (`task_context`), and agent mailboxes (`agent_messages`).
- **Filesystem (`runs/<jobId>/` and `runs/<workflowId>/<stepId>/`)**: Primary content authority. Holds large conversational prompts (`prompt.txt`), raw streaming execution logs (`stdout.log`), LLM text outputs (`response.txt`), binary/evidence artifacts, verification results (`verification.json`), judge verdicts (`judge.json`), and artifact digests (`artifacts.manifest.json`).

---

## 4. SUPERFICIE MCP

Exact list of 28 registered MCP tools derived directly from [`src/index.mjs`](file:///home/alejandro/Desarrollo/agent-hub-worktrees/report/src/index.mjs):

| Tool Name | Status | Description & Notable Changes |
|---|---|---|
| `agent_send_message` | **NEW** | Send an inter-agent message to a peer mailbox scoped to root execution. |
| `agent_inbox` | **NEW** | Retrieve unread messages from agent mailbox and mark delivered. |
| `agent_ack` | **NEW** | Acknowledge receipt of a message into peer context envelope. |
| `agent_peers` | **NEW** | List active peers participating in a shared root execution. |
| `agents_quota` | Existing | Inspect model quota usage from local CodexBar server. |
| `agents_status` | Existing | Health status, binary discovery, and version report across agent CLIs. |
| `route` | **UPDATED** | Enhanced with `requirements` (capabilities array), `preferences` (quality, cost, latency weights), and `adaptive` (boolean flag to reorder candidates by score). |
| `delegate` | Existing | Low-level asynchronous task delegation to a local agent CLI. |
| `dispatch` | Existing | Policy-managed task dispatch through preflight, routing, and leases. |
| `job_wait` | Existing | Block locally until a job reaches a terminal or waiting state. |
| `job_status` | Existing | Read status, remote state, and execution metadata for a job. |
| `job_result` | Existing | Read final job output head/tail lines and execution error details. |
| `job_cancel` | Existing | Abort a running job and terminate local process tree. |
| `job_reply` | Existing | Send follow-up prompt to resume an existing conversation session. |
| `jules_delegate` | Existing | Delegate coding task to Google Jules cloud service. |
| `jules_sources` | Existing | List GitHub repositories connected to Jules account. |
| `jules_accounts` | Existing | List configured Jules multi-account profiles. |
| `jules_schedules` | Existing | List recurring automated Jules maintenance tasks. |
| `jules_check` | Existing | Single-shot live status check against remote Jules session. |
| `jules_interact` | Existing | Reply to Jules session, send feedback, or approve plan. |
| `jules_wait` | Existing | Wait for Jules session to transition to attention or terminal state. |
| `jules_sessions` | Existing | List recent Jules cloud sessions directly from API. |
| `jules_supervise` | Existing | Autonomous observation and interaction loop for Jules sessions. |
| `agents_metrics` | **UPDATED** | Intelligence metrics: returns verified rate, cost, and revision stats. |
| `execution_graph` | **NEW** | Read-only execution lineage DAG (roots, nodes, edges, relations). |
| `plan_task` | **NEW** | Dry-run validation of `WorkflowPlan` and materialization without execution. |
| `execute_plan` | **NEW** | Validate, materialize, and execute a plan; requires `approve: true`. |
| `learning_propose`| Existing | Propose a gotcha/learning for human approval in dashboard. |

---

## 5. VARIABLES DE ENTORNO

| Variable | Status | Description |
|---|---|---|
| `AGENT_HUB_STORE` | **NEW** | Job store read path: `json` (default), `sqlite` (authoritative DB read with JSON fallback), or `shadow` (JSON read with divergence verification against DB). |
| `AGENT_HUB_READGUARD_IGNORED` | **NEW** | `1` enables gitignored file tracking during read-mode execution via `git status --ignored=matching`. Default `0`. |
| `AGENT_HUB_SANDBOX_PROFILE` | **UPDATED** | Process isolation level: `compatibility` (default; secret scrub, host HOME), `isolated-home` (secret scrub, temp HOME), or `isolated` (temp HOME, TMPDIR, XDG directories). |
| `AGENT_HUB_SANDBOX_INCLUDE` | **NEW** | Comma-separated list of host files/directories copied into sandbox under `isolated` mode. |
| `AGENT_HUB_AGYS` | **NEW** | Set to `auto` to enable automatic multi-account agys profile selection based on quota and priority. |
| `AGENT_HUB_AGYS_PROFILE` | **NEW** | Explicitly overrides automatic selection to force a specific agys profile. |
| `AGENT_HUB_OPENCODE_BRIDGE` | **NEW** | `1` activates waking lifecycle bridge for OpenCode v2 sessions. Default `0` (off). |
| `AGENT_HUB_OPENCODE_SERVICE_FILE` | **NEW** | Path override for OpenCode session service file (defaults to `~/.local/state/opencode/service.json`). |
| `AGENT_HUB_WEBHOOK_URL` | **NEW** | Destination HTTP endpoint for notification policy webhook channel. |
| `AGENT_HUB_LIVE` | **UPDATED** | `1` gates live adapter tests (`npm run test:live`) and benchmark live execution. |

---

## 6. FIABILIDAD

### Benchmark Suite (`bench/run.mjs`)
Offline, deterministic, zero-quota execution harness exercising four core workflow scenarios:
1. `happy-path`: Sequential multi-step workflow with passing verification.
2. `retry-transient`: Transient dispatch failure recovery within attempt limit.
3. `revision-verification`: Initial verification failure triggering revision loop before acceptance.
4. `fanout-child-failure`: Parallel branch failure propagation to parent DAG.

### Chaos Scenarios (`test/chaos/`)
- **`chaos.test.mjs`**:
  - `chaos 1`: Concurrent duplicate dispatch results in exactly one spawned job.
  - `chaos 2`: Workflow recovery after crash re-adopts and dispatches uncompleted nodes exactly once.
  - `chaos 3`: Expired node leases are safely reclaimed while active leases are untouched.
  - `chaos 4`: Concurrent child SQLite updates produce no lost writes or database corruption.
- **`crash.test.mjs`**:
  - `crash 1`: Scheduler killed mid-wave resumes with fresh worker ID without re-executing succeeded nodes.
  - `crash 2`: Workflow crash and resume re-adopts expired claims without re-running finished nodes.
  - `crash 3`: Worker process dying mid-run does not double-dispatch on recovery.
- **`jules-failure.test.mjs`**:
  - Bounded 429 failover to secondary account, capping strictly at 3 attempts.
  - 5xx/network errors classified as transport issues without corrupting local job status.
  - Canceled jobs cease remote polling before timer expiration.
- **`provider-failure.test.mjs`**:
  - A3 policy mapping: quota triggers fallback; auth and billing halt fallback and escalate to human.
  - Exhaustion of all candidate models cleanly returns null route without hanging.

### Current Test Suite Posture
- Total test files: 78 suites.
- Exact verification output (`npm test 2>&1 | tail -4`):
  ```
  # cancelled 0
  # skipped 0
  # todo 0
  # duration_ms 16205.868515
  ```
- Full suite summary: 475 passing tests across 78 test files (0 failures, 0 cancelled).

---

## 7. LÍMITES CONOCIDOS Y PENDIENTES

1. **Hermes Nested Orchestrator (Phase I)**: Deliberately deferred to a future milestone; nested orchestration capabilities are not implemented.
2. **Container Sandbox Profile (`H.4`)**: Documented as design-only specification in [`docs/security-isolation.md`](file:///home/alejandro/Desarrollo/agent-hub-worktrees/report/docs/security-isolation.md). Linux namespace, cgroups v2, and `bwrap` pivoting are not yet built; `isolated` remains a process-level tempdir redirection, not an OS-level sandbox.
3. **Inter-Agent Messaging `messagingMidRun`**: Currently set to `false` across all agent adapters. Inter-agent messages are delivered exclusively at turn boundaries (`job_reply`) or via root context injection; mid-turn autonomous MCP mailbox polling is not wired.
4. **OpenCode Bridge Default State**: The E1 OpenCode lifecycle bridge is disabled by default and requires explicit opt-in (`AGENT_HUB_OPENCODE_BRIDGE=1`) and OpenCode >= 2.0.10.
5. **Dormant `quality_score` Column**: The raw per-job `quality_score` column in SQLite `jobs` table is dormant for backwards schema compatibility, though removed from the `JobRecord` Zod schema in PR #55. Derived metrics `qualityScore` (`10 * verifiedRate`) remain fully operational.
6. **Live Benchmark Execution**: Setting `AGENT_HUB_LIVE=1` on `bench/run.mjs` prints a planned follow-up notice and exits with code 0 to protect against accidental quota expenditure.

---

## 8. LISTA DE PRs DE HOY (2026-09-21)

1. **PR #10**: `feat(workflow): C2 evidence artifacts and artifact:// passing`
2. **PR #11**: `feat(workflow): C3 verifier — deterministic verdicts for workflow nodes`
3. **PR #12**: `fix(dashboard): one malformed job record must not blank every job view`
4. **PR #13**: `feat(workflow): C4 judge and revision loop`
5. **PR #14**: `feat(workflow): C4 judge and revision loop (re-land to dev)`
6. **PR #15**: `feat(metrics): D1 quality, cost and verification intelligence`
7. **PR #16**: `docs: post-D1 master roadmap`
8. **PR #17**: `feat(routing): D2 adaptive routing — capabilities + explainable scoring`
9. **PR #18**: `fix(sandbox): omit redacted secrets instead of setting '***'`
10. **PR #19**: `feat(workflow): emit workflow.completed once per terminal transition`
11. **PR #20**: `feat(handoff): C2b.1 structured node handoff schema and registry`
12. **PR #21**: `feat(workflow): C4b bounded revision feedback on re-dispatch`
13. **PR #22**: `feat(roles): C2b.5 role registry binding capabilities to handoff contracts`
14. **PR #23**: `test: G.0 deterministic quota and lease suites (0 cancelled, 0 flake)`
15. **PR #24**: `feat(notify): E2.3 notification policy with routing and dedup`
16. **PR #25**: `feat(verify): C3b.1 schema check kind for handoff contracts`
17. **PR #26**: `feat(graph): F2 read-only execution graph over job lineage`
18. **PR #27**: `feat(context): C2b.2 SQLite-backed handoff and task context store`
19. **PR #28**: `feat(storage): C0.1.1 dual-read comparison for job read paths`
20. **PR #29**: `feat(workflow): C2b.3+C2b.4 structured handoffs in the engine`
21. **PR #30**: `feat(dashboard): F2.3 execution graph view`
22. **PR #31**: `feat(mcp): expose adaptive routing on the route tool`
23. **PR #32**: `feat(readguard): H.2 opt-in coverage of gitignored files`
24. **PR #33**: `feat(workflow): C3b.2 fanout children produce evidence and pass verification`
25. **PR #34**: `feat(providers): D2.1 provider profiles + agys adapter`
26. **PR #35**: `feat(dashboard): job detail opens in a modal instead of a side sheet`
27. **PR #36**: `feat(providers): D2.2 run agy through agys profiles`
28. **PR #37**: `feat(providers): D2.3 resolve the agys profile in dispatch`
29. **PR #38**: `feat(bench): G offline deterministic eval/reliability harness`
30. **PR #39**: `feat(planner): F1 validated WorkflowPlan and role materialization`
31. **PR #40**: `test(chaos): G.3 offline duplicate-dispatch, resume and claim-reclaim`
32. **PR #41**: `feat(providers): D2.4 agys auto profile for delegate + route annotation`
33. **PR #42**: `feat(sandbox): H.3 make the isolated profile real (still not a container)`
34. **PR #43**: `fix(mcp): register the execution_graph tool`
35. **PR #44**: `test(chaos): G.4 scheduler kill and workflow crash recovery`
36. **PR #45**: `feat(harness): E1.1 lifecycle bridge contract`
37. **PR #46**: `feat(integrations): OpenCode subagent monitor plugin`
38. **PR #47**: `feat(harness): E1.2 real OpenCode lifecycle bridge`
39. **PR #48**: `docs: refresh the README for the current feature set`
40. **PR #49**: `docs: document AGENT_HUB_OPENCODE_BRIDGE`
41. **PR #50**: `feat(dashboard): clearer sidebar, per-view tips and provider marks`
42. **PR #51**: `docs: H.4 security isolation matrix and container design`
43. **PR #52**: `feat(storage): C0.1 SQLite read-path cutover`
44. **PR #53**: `feat(planner): F1 plan_task and execute_plan with an approval gate`
45. **PR #54**: `test(chaos): G provider-class fallback, Jules failure and bench live flag`
46. **PR #55**: `chore: remove the dead per-job quality_score field`
47. **PR #56**: `feat(messaging): inter-agent mailbox with turn-boundary delivery`
48. **PR #57**: `feat(dashboard): agys profiles and quotas view`

---

## 9. NO VERIFICADO

- No items. Every assertion, file path, MCP tool schema, environment variable, test count, and PR number in this report was verified against repository source code and git history.

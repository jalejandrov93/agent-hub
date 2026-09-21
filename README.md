# agent-hub

A local [MCP](https://modelcontextprotocol.io) server and execution/orchestration
layer that lets Claude Code, OpenCode, and external orchestrators delegate bounded
tasks (recon, call-chain tracing, summarizing large artifacts, second opinions,
adversarial review, mechanical edits) to other agent CLIs — Antigravity (`agy`),
`opencode`, GitHub `copilot`, and OpenAI `codex` — as well as cloud agents
(Google Jules), without exhausting primary model quota.

Beyond simple dispatch, agent-hub is a resilient execution engine: it executes
DAG workflows with parallel wave scheduling and step dependency resolution,
enforces evidence-based task verification (`artifacts` + `artifact://` refs,
deterministic `verify` checks, and judge-mediated revision loops), manages
structured role-based handoffs, provides capability-aware adaptive routing with
explainable scoring, manages multi-account provider profiles (`agys`), tracks
execution graph lineage, stores coordination state in SQLite with JSON fallback,
recovers from process crashes, fences concurrent writers, and offers an
append-only event log and a local monitoring dashboard.

**Requirements**

- Node.js >= 20.19.0
- At least one of `agy`, `opencode`, `copilot`, or `codex` on `PATH`, already
  authenticated with that CLI's own login flow. agent-hub does not manage
  credentials — it only spawns the CLI you already use.
- Optional, for the Jules cloud agent: one or more Jules API keys (generate them
  at jules.google.com/settings), added as accounts in the dashboard or given as
  `JULES_API_KEY`. There is no binary to install — Jules is a REST API. See
  [Cloud delegation (Jules)](#cloud-delegation-jules).
- Optional, to see agent activity in a Windows notch: [Quota Arc](#quota-arc-and-codexbar).

## Layout

```
src/
  index.mjs          MCP bootstrap (stdio) + --selftest/--version, tool registry
  config.mjs         paths, TTLs, model registry, timeouts, breaker constants, sandbox config
  schemas.mjs        shared zod contracts (tool outputSchema + dashboard types); browser-safe
  eventlog.mjs       appendEvent() (one atomic append per line) / readTail()
  fsutil.mjs         writeJsonAtomic()/updateJsonLocked() (lock + tmp + rename)
  jobstore.mjs       runs/<jobId>/{prompt.txt,stdout.log,response.txt,result.json}, AGENT_HUB_STORE
  artifacts.mjs      runs/<workflowId>/<stepId>/artifacts/ evidence store + artifact:// refs (C2)
  verify.mjs         declarative argv/artifact/diff checks -> { verified, checks } (C3)
  judge.mjs          verification verdict -> accepted | needs_revision | rejected | blocked (C4)
  revision.mjs       buildRevisionFeedback() (<agent-hub-revision> capped at 3 findings x 300 chars)
  context.mjs        workflow context & handoff persistence (task_context / task_handoffs)
  handoff.mjs        structured handoff schemas (Base, Research, Security, Implementation, Review)
  roles.mjs          role definitions (TRACE_ANALYST, SECURITY_REVIEWER, ARCHITECT, IMPLEMENTER, etc.)
  process.mjs        spawn argv, SIGTERM->SIGKILL ladder, runCommand()
  jobrunner.mjs      ties process+jobstore+worktree+timeouts+learnings+readguard+sandbox into startJob/cancelJob
  dispatch.mjs       atomic decide+execute: preflight revalidation, policy recovery, idempotency CAS
  execution-graph.mjs pure execution graph builder (roots, nodes, retry/resume/delegate edges)
  sandbox.mjs        environment filtering & sandbox profiles (compatibility, isolated-home, isolated)
  preflight.mjs      L0-L3 ladder, TTL cache, circuit breaker
  preflight-cli.mjs  `agent-hub preflight` table printer
  discovery.mjs      CLI discovery (binPath/version/models), startup + on-demand
  overrides.mjs      manual per-pair hold / breaker-reset overrides
  startup.mjs        non-blocking startup discovery scheduler + quota warmup
  router.mjs         delegation map + availability filtering, applies accepted proposals + agys
  capabilities.mjs   per agent/model capabilities derived from adapter + registry signals
  routing/score.mjs  preference-weighted, explainable candidate ranking
  worktree.mjs       write-mode gate (secondary git worktree) + single-writer lock
  metrics.mjs        job-history aggregation (success, p50/p95, tokens, cost, verified, quality, revisions)
  timeouts.mjs       effective timeout: explicit > adaptive (p95 x 1.5) > static default
  proposals.mjs      Wilson-bound chain-reorder proposals, human-accepted before they apply
  learnings.mjs      curated pending/approved gotchas, sanitized and injected into root turns
  readguard.mjs      git snapshot for read jobs -> read_mode_violation (AGENT_HUB_READGUARD_IGNORED)
  hook.mjs           SubagentStart/SubagentStop -> events
  dashboard.mjs      node:http dashboard: serves dashboard/dist, SSE /events, JSON API
  accounts.mjs       Jules accounts management (0600 permissions, key masking)
  breakers.mjs       per-class circuit breaker evaluation
  scheduler.mjs      recurring Jules schedule runner
  schedules.mjs      recurring schedule storage and CRUD
  storage/
    db.mjs           database connection lifecycle & migrations
    sqlite.mjs       SQLite tables (workflows, workflow_nodes, jobs, leases, harness_origins, task_handoffs, task_context) + JSON fallback
    index.mjs        storage facade (getDb, upsertJob, upsertHandoff, etc.)
  adapters/{base,agy,opencode,copilot,codex,index}.mjs
  cloud/
    jules/{client,adapter,supervisor}.mjs
    {check,credentials,gitContext,poller,remote-observation,runner,selectAccount,sources}.mjs
  harness/
    bridge.mjs       lifecycle bridge contract (supportsWake, resolveBridge)
    lifecycle.mjs    deliverCompletion() back to originating harness
    origin.mjs       recordDispatchOrigin / getOrigin mapping
    registry.mjs     harness profile registry (generic, claude-code, opencode)
    {generic,claude-code,opencode}.mjs
  notify/
    policy.mjs       notification routing & dedup policy
    adapters.mjs     console, file, webhook notification sinks
    watch.mjs        events.jsonl follower
    cli.mjs          `agent-hub watch` CLI
  planner/
    plan.mjs         WorkflowPlanSchema, validatePlan, materializePlan
    decompose.mjs    decompose({ intent, runPlanner, routeFn, maxSteps })
  policy/
    taxonomy.mjs     failure classification (billing, auth, quota, timeout, transport, crash, quality)
    registry.mjs     declarative policy table mapping failure classes to retry/resume/fallback/escalate
    executor.mjs     executeWithPolicy() loop
  providers/
    profiles.mjs     normalizeProfile, selectProfile, profileStateFor (selected, fallback, exhausted, unavailable)
    agys.mjs         agys CLI multi-account profile integration (list, quota, auto/explicit selection)
  quota/{codexbar,mapping}.mjs
  tools/{agents,jobs,insights,jules,learnings}.mjs
  workflow/
    schema.mjs       NodeSchema, WorkflowSchema, DAG cycle detection
    engine.mjs       parallel wave execution, claims, transitions, artifact/verify/judge/handoff lifecycle
    dsl.mjs          safe condition expression parser (==, !=, AND, OR, NOT, exists)
    execution.mjs    execution handle management and waitExecution
    resolver.mjs     resolves artifact:// and handoff context for node dispatch
    resume.mjs       resumeWorkflowNodeFromExecution (WAITING -> RUNNING)
    state.mjs        in-memory & SQLite workflow state management
bench/               benchmark runner (run.mjs) & corpus scenarios (corpus.mjs)
dashboard/           React 19 + TS + Vite + Tailwind v4 + Base UI workspace, builds dist/
scripts/             build-dashboard.mjs — prepare hook; install-local.mjs
bin/agent-hub        dispatch: mcp | hook | dashboard | preflight | selftest | watch
skills/              multi-agent-orchestrator and agy-delegate skills (see Install)
test/                node --test; fixtures/ has real+synthetic CLI output;
                     test/chaos/ (chaos & crash tests); live/ (gated by AGENT_HUB_LIVE=1)
systemd/agent-hub-dashboard.service   NOT installed — copy it yourself if wanted
```

Runtime state (never committed) lives in `AGENT_HUB_HOME`, default
`~/.local/share/agent-hub/`: `events.jsonl`, `agent-hub.db` (SQLite WAL database
with tables `workflows`, `workflow_nodes`, `jobs`, `leases`, `harness_origins`,
`task_handoffs`, `task_context`), `preflight-cache.json`, `discovery.json`,
`overrides.json`, `proposals.json`, `learnings.json`, `accounts.json` (mode
`0600`), `schedules.json`, `sources-cache.json`, `quota-cache.json`,
`runs/<jobId>/` (`prompt.txt`, `stdout.log`, `response.txt`, `result.json`),
`runs/<workflowId>/<stepId>/artifacts/` (with `artifacts.manifest.json`,
`verification.json`, `judge.json`, `handoff.json`, and declared artifacts),
and `runs/.locks/`.

## Install

```bash
git clone https://github.com/jalejandrov93/agent-hub.git ~/.claude/mcp-servers/agent-hub
cd ~/.claude/mcp-servers/agent-hub
npm install
npm test
node bin/agent-hub selftest
```

`npm install` also builds the dashboard workspace through the `prepare`
script: `scripts/build-dashboard.mjs` runs `npm run -w dashboard build` and
always exits 0. The MCP server does not need the bundle, so a failed build
only prints a hint and never fails the install; run `npm run build` to rebuild
it on demand. When `dashboard/dist/` is missing, the dashboard server answers
`/` with a 503 page naming the repo path and the `npm run build` command.
Rebuilds are picked up without restarting the dashboard process (it re-reads
the built `index.html` when its mtime changes).

### Keep the checkout outside `~/.claude` (optional)

Cloning straight into `~/.claude/mcp-servers/agent-hub` is the quickest path,
but that directory then holds the whole development tree (`node_modules`,
tests and the dashboard sources — a few hundred MB). To keep the checkout
wherever you develop and leave only the runtime there:

```bash
git clone https://github.com/jalejandrov93/agent-hub.git ~/Desarrollo/agent-hub
cd ~/Desarrollo/agent-hub
npm install
npm run install:local -- --restart
```

`npm run install:local` builds the dashboard, then copies `bin/`, `src/`,
`skills/`, `systemd/` and `dashboard/dist/` into the install directory
(`--target <dir>`, or `AGENT_HUB_INSTALL_DIR`, default
`~/.claude/mcp-servers/agent-hub`), writes a runtime `package.json` with no
workspaces, dev dependencies or `prepare` hook, installs production
dependencies there, and records `INSTALL.json` with the version and commit it
came from. `--restart` also restarts the dashboard unit. Because the install
directory keeps its usual path, the MCP registration, the hooks, the systemd
unit and the skill symlinks below need no changes; re-run the command after
every `git pull` and restart Claude Code. Runtime state stays in
`AGENT_HUB_HOME` and is never touched. `--skip-build` reuses the current
`dashboard/dist/`.

### Register the MCP server

Use an absolute `node` path, not a bare `node` / `#!/usr/bin/env node`: on a
machine where `node` comes from an ephemeral version-manager shim (for
example fnm's per-shell multishell directory), that path only exists inside a
shell that ran the manager's `use`/`env` step, and Claude Code's own process
environment may not have it on `PATH`. Pin to the manager's stable,
version-pinned alias instead — for fnm that is
`~/.local/share/fnm/aliases/default/bin/node`:

```bash
claude mcp add --scope user agent-hub -- \
  /path/to/node /path/to/agent-hub/bin/agent-hub mcp
```

`claude mcp add [options] <name> <commandOrUrl> [args...]` defaults to a
stdio transport, so no `--transport` flag is needed for this. `--scope user`
registers it for every project; use `--scope local` (the default) to
register it only in the current project instead.

### Install the skills

Two skills ship in `skills/` and are picked up by Claude Code once symlinked
into its skills directory:

```bash
ln -s /path/to/agent-hub/skills/multi-agent-orchestrator ~/.claude/skills/multi-agent-orchestrator
ln -s /path/to/agent-hub/skills/agy-delegate ~/.claude/skills/agy-delegate
```

`multi-agent-orchestrator` documents the full delegation loop
(`agents_status → route → delegate → job_wait/job_status → job_result →
synthesize`) and the break-even rule for when delegating is worth it.
`agy-delegate` is a thin pointer to it plus a no-MCP fallback script
(`scripts/agy-run.sh`) for delegating directly to `agy` when the
MCP server is not registered in the current session.

### Optional: Claude Code hooks

`SubagentStart` and `SubagentStop` both run the same binary, using the same
absolute node path as above, to record Claude Code's own subagents into the
same event log the dashboard reads:

```bash
/path/to/node /path/to/agent-hub/bin/agent-hub hook
```

Wire these through the `update-config` skill (or by hand in
`~/.claude/settings.json`) — agent-hub does not register its own hooks. The
hook reads the event JSON from stdin, enriches `SubagentStop` with the
model/description from the agent's `meta.json` and summed token usage from
its own transcript, and always exits 0.

### Optional: run the dashboard as a systemd --user unit

```bash
mkdir -p ~/.config/systemd/user
cp /path/to/agent-hub/systemd/agent-hub-dashboard.service ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now agent-hub-dashboard
```

**Give the unit the same `PATH` as your shell.** `systemd --user` starts services
with a minimal `PATH` that usually lacks `~/.local/bin`, `~/.opencode/bin` or a
Node version manager's bin directory. Without this step the dashboard cannot find
`agy`, `opencode` or `copilot`, and a Revalidate click would record them as
unavailable in the cache the MCP server also reads. The unit loads an optional
environment file for this:

```bash
mkdir -p ~/.config/agent-hub
# Absolute paths only: systemd does not expand $HOME or %h inside this file.
# List stable directories; do not paste a PATH containing per-shell dirs such
# as fnm_multishells, which disappear when that shell exits.
printf 'PATH=%s\n' "$HOME/.local/bin:$HOME/.opencode/bin:/usr/local/bin:/usr/bin:/bin" \
  > ~/.config/agent-hub/env
systemctl --user restart agent-hub-dashboard
```

The Config panel shows the `PATH` and resolved CLI binaries the dashboard
process actually sees. If a CLI is missing there, the Agents panel shows a
warning and disables Revalidate and Ping for it, and the API returns a
`skipped` result instead of recording that agent as unavailable in the state
the MCP server reads.

Its `ExecStart` uses the same absolute node-path reasoning as above — a
systemd `--user` unit does not inherit a shell's version-manager `PATH`
either.

## How it works

### Preflight ladder

Every agent+model pair is checked through an ordered ladder before a job is
routed to it. Each rung short-circuits on failure, and results are cached
for `PREFLIGHT_TTL_MS` (15 minutes):

| Level | Check | When it runs |
|---|---|---|
| L0 | `--version` succeeds | `agents_status`, `route`, startup discovery |
| L1 | The requested model appears in the CLI's own model catalog | `agents_status`, `route`, startup discovery |
| L2 | Quota signal + circuit-breaker state | `agents_status`, `route` |
| L3 | A real `PONG` prompt round-trip | Only on an explicit dashboard "Ping" action — never at startup, never in bulk |

### Startup discovery

`scheduleStartupDiscovery()` runs in the background via `setImmediate` right
after the MCP process starts, so it never delays the stdio handshake with
Claude Code. It runs L0 + L1 only (never L3) for every CLI referenced in the
delegation map, prunes preflight-cache rows for agent:model pairs no longer
reachable from the map, and writes the merged result to `discovery.json`
(`{ [agent]: {agent, cmd, binPath, version, models, checkedAt, error,
note?} }`). It is TTL-gated the same 15 minutes as the preflight cache, and
can be disabled entirely with `AGENT_HUB_DISABLE_STARTUP_DISCOVERY=1`.

State writes (preflight cache, discovery, overrides) use atomic tmp+rename
writes because the MCP process and the dashboard process both write the same
files. The model list is fetched once per agent, not once per agent+model
pair; the three agents are probed in parallel, but pairs within one agent
are probed serially to avoid more than one live CLI process per agent at a
time.

### Delegation map

`route({taskType})` looks up an ordered candidate chain in
`DELEGATION_MAP` (`src/router.mjs`) and returns the first candidate that
passes availability filtering, plus the rest as fallbacks:

| Task type | Primary | Fallbacks | Why |
|---|---|---|---|
| `recon` | agy gemini-3.8-flash-low | opencode muse-spark-1.3 → claude haiku | proven context compression, cheap refreshable quota |
| `call-chain-trace` | agy gemini-3.8-flash-high | opencode nemotron-3-ultra → claude sonnet | needs multi-hop reasoning, 1M ctx |
| `research` | opencode muse-spark-1.3 | opencode mimo-v2.5 → agy gemini-3.8-flash-medium | zero cost, 1M ctx |
| `triage` | opencode muse-spark-1.3 | copilot auto → codex default | lowest latency |
| `second-opinion` | agy gemini-3.1-pro-high | copilot auto | different model lineage than Claude Code |
| `adversarial-review` | agy claude-sonnet-4-6 (parallel with copilot auto) | agy claude-opus-4-6-thinking | dual blind review off the Claude Code quota |
| `github-context` | copilot auto | — | built-in GitHub MCP; cheap models keep premium quota |
| `mechanical-edit` | opencode deepseek-v4-flash (write) | copilot auto (write) → codex default (write) | cheap write-capable; single writer |
| `implementation-with-repo-rules` | claude sonnet | — | only Claude Code loads CLAUDE.md + skills + hooks |
| `architecture` | claude opus | agy claude-opus-4-6-thinking | highest reasoning |
| `structured-mechanical` | claude haiku | — | cheapest Claude tier |

Codex is only ever a last fallback, for small bounded tasks: its plan quota is
limited, and every call carries a baseline of about 17,000 input tokens (its own
system prompt), even for a one-word reply. Batch questions into one task. Model
`default` means the CLI's own default model, so no model name is guessed.

A `{agent: 'claude', model: 'haiku'|'sonnet'|'opus'}` candidate is a Claude
Code subagent tier, run by the caller through its own Agent tool — it is
never CLI-preflighted or breaker-checked. A candidate is filtered out of the
chain (and reported in the result's `skipped` list, with a reason) when it
is manually held, its CLI was not found on `PATH`, its cached preflight is
`unavailable`, or its circuit breaker is open. `route()` is advisory: it
never blocks the caller from delegating to a skipped pair directly.

### Cloud delegation (Jules)

Every other agent here is a local CLI: agent-hub spawns it, streams its stdout
and reaps it. [Jules](https://jules.google) is not. It is a REST API
(`v1alpha`, **alpha — shapes may change**) and the work runs on Google's
servers, against a GitHub repository you connected in the Jules web UI. The
result is a pull request, never a change to your `cwd`. That difference drives
every design decision below.

Jules is reachable only through its own tools (`jules_delegate`,
`jules_sources`, `jules_check`, `jules_sessions`, `jules_interact`,
`jules_wait`, `jules_supervise`). It is deliberately absent
from the delegation map, so `route` never picks it and `delegate` cannot reach
it — you get a cloud session only when you ask for one.

**It survives your machine being off.** This is the point of the feature: hand
over a task, close the laptop, come back later. Because the MCP server is a
per-session stdio process and the dashboard is a local service, both die with
the machine while the Jules session keeps going, so polling can never be the
only way to learn the outcome:

- While the server is up, a poll loop streams Jules' activity into the job's
  `stdout.log`, so `job_result` and the dashboard show progress live. Activities
  are deduplicated by identity, not by page token, and the interval backs off to
  60s when nothing moves.
- On startup the server resumes polling any job still marked `running`. If its
  deadline elapsed while nothing was watching, it does one final read before
  deciding — a session that finished overnight lands as `succeeded` with its
  pull-request link, not as a timeout.
- Whenever you want, `jules_check` answers "did it finish, and on which branch"
  with a single live read and no poll loop at all. If the session ended while
  the machine was off, it finalizes the local job so `job_result` returns the
  real answer. `jules_sessions` lists what Jules has even when this machine has
  no record of it, so a reinstall or a session started elsewhere is still
  recoverable.

**Cancel is local only.** The Jules API exposes no cancel endpoint — and no
`pause`/`resume` endpoints either. `job_cancel`
marks the job canceled and stops this server's polling; the session keeps
running on Google's side. The tool says so.

**Waiting is a state, not a stall.** A Jules session can sit in
`AWAITING_PLAN_APPROVAL`, `AWAITING_USER_FEEDBACK` or `PAUSED` indefinitely,
and the hub no longer polls those blindly: the poll interval is semantic per
state (`QUEUED`/`PLANNING` 5s, `IN_PROGRESS` 5–15s backoff, `AWAITING_*`
30–60s, `PAUSED` 5min), a waiting tick skips re-draining `listActivities`,
and the job record carries `pollingStoppedReason: 'awaiting_interaction'`
until new activity resumes it. `jules_check` now also answers
`attentionRequired` / `attentionReason` (`user_feedback` | `plan_approval` |
`paused`) / `recommendedAction` (`send_message` | `approve_plan`) /
`canAutoResolve` / `attempts`, and `jules_interact` (`reply` |
`approve_plan`) is the interaction API — `pause`/`resume`/`cancel` remotes
are explicitly rejected because the backend does not offer them. See
`src/cloud/poller.mjs` (`STATE_INTERVALS`, `intervalForState`),
`src/cloud/jules/adapter.mjs` (`ALL_JULES_STATES`, `isWaitingState`) and
`src/cloud/check.mjs` (`computeAttention`).

**Model A: interacting never restarts polling.** After `jules_interact`
(or `job_reply` on a Jules parent) nothing observes the session again on its
own — the local record freezes at `running` until *you* observe it. So the
three observation tools have distinct jobs, and mixing them up loses
completions:

- `job_wait` — waits on the **local record**: returns on terminal, or
  immediately on `done`+`waiting` with attention fields. It does *not* poll
  Jules itself, so after an interaction it will *not* see the session finish.
- `jules_wait` — **actively observes** one session for a bounded local budget
  (`timeoutS≤600`); never a watch daemon.
- `jules_check` — one **punctual inspection** plus reconciliation (finalizes
  the local job if the session already ended).

Post-interaction rule: `jules_interact` → observe with `jules_wait` (or
`jules_check`), never `job_wait` alone. Continuous supervision belongs to
`jules_supervise` (B4), which owns observation through a
`remote.watch = {owner, generation}` lease so two watchers never drive the
same session: it loops observe → decide → interact → resume-observation,
auto-replies only through 6 hard gates with `maxAutoReplies=2` counted on
`autoReplyCount` (never `turnDepth`), and escalates anything else as
`REQUEST_USER`. `PAUSED` is never approved/replied.

**Several accounts.** Quotas are per Jules account, so agent-hub can hold more
than one. Add them in the dashboard; they live in `accounts.json` under
`AGENT_HUB_HOME`, written with mode `0600`, and no API response ever returns a
raw key. A policy (`round_robin`, `least_used` or `priority`) picks the account
for each new session, a `429` fails over to the next eligible account, and a job
keeps the account that started it for its whole life. Account health is judged
by `GET /sessions`, never `GET /sources`: a valid key can be refused `/sources`
with a 401 while working normally. With no accounts configured, `JULES_API_KEY`
is used as before. All key resolution lives in `src/cloud/credentials.mjs`.

**Recurring tasks.** The Jules API has no scheduling, so agent-hub owns it.
Schedules run inside the dashboard service, the only long-lived process here,
and fire at most one run at a time per schedule. With the machine off, no
schedule fires; sessions already started keep running on Google's side.

**The key never leaves this process.** `JULES_API_KEY` travels only in the
`X-Goog-Api-Key` header. It is never written to a job record, an event, a log
line or a response, and it is stripped from the environment handed to the local
agent CLIs, which are third-party programs agent-hub does not control.

**Sources are read-only.** Repositories are connected to Jules through its
GitHub App in the web UI. The API can list them (`jules_sources`) but cannot add
one. `jules_delegate` accepts an explicit `source`, or infers it from `cwd` via
the `origin` remote.

### Quota state before delegating

agent-hub can show how much of each agent's usage limit is left before you
delegate, read from a local [CodexBar](https://github.com/steipete/CodexBar)
server (`codexbar serve`, default `http://127.0.0.1:8787`, override with
`AGENT_HUB_CODEXBAR_URL`). It appears as a `quota` field on `agents_status`
rows and on `route()`'s primary and fallbacks, in the `agents_quota` tool, at
`GET /api/quota`, and in the dashboard's Agents view.

**It never decides anything.** Quota data does not choose, skip, reorder or
block an agent, and `route()` returns the same chain with or without it — a test
pins that. An exhausted agent stays in its place; the point is that you see it
before a job fails, and decide.

Each pair maps to the CodexBar windows that actually limit it. agy splits by
model family: `gemini-*` models read the Gemini windows, while `claude-*` and
`gpt-*` models read the shared Claude/GPT windows, which are exhausted
independently. copilot and codex read their own provider, `opencode-go/*`
models read OpenCode Go, and the free opencode models and `deepseek/*` are not
metered by CodexBar. A window CodexBar reports with `usageKnown: false` is shown
as unknown, never as 0%. Readings are cached for five minutes, requested one
provider at a time (`/usage?provider=all` probes about 69 providers and is
slow), and a missing CodexBar never blocks or slows a delegation.

### Circuit breaker

A per-agent+model breaker opens after `failureThreshold` (2) matching
failures (`quota`, `canceled`, `billing`) within a 30-minute window, or
immediately on a single `billing` failure (a billing failure such as an
insufficient-balance error does not clear on retry). A manual
`breakerReset` override (dashboard "Reset breaker" button, or `POST
/api/overrides`) makes earlier failures at or before that instant stop
counting.

Per-class breakers extend this without replacing it: `src/policy/taxonomy.mjs`
classifies failures (`billing`, `auth`, `quota`, `timeout`, `transport`,
`crash`, `quality`), `CIRCUIT_BREAKER_BY_CLASS` in `src/config.mjs` sets a
window/threshold per class, and `src/breakers.mjs` evaluates them
(`circuitBreakerOpenByClass`, `matchingFailuresByClass`, `breakerStatus`).
`src/policy/registry.mjs` (`POLICY_TABLE`, `policyFor`) then maps each class
to an explicit `{retry, resume, fallback, escalation}` policy executed by
`executeWithPolicy()` in `src/policy/executor.mjs` — one declarative loop,
not a chain of `if/else`. The table covers every taxonomy category
(`billing`/`auth` never retry and escalate to human; `quota` retries bounded
then falls back; `crash` gets one retry then an alternate adapter), and
`ctx.recoveryOrder` lets a remote adapter run resume/reconcile before any
retry that could duplicate a session (escalation always stays last).

### Execution contract

`docs/execution-contract.md` is the normative spec for job execution
(deadline, cancellation, retry/resume/fallback/escalation, idempotency, read
purity, write ownership, local-vs-remote state). The two invariants to
remember: a **local deadline is never a remote failure** (a timed-out watcher
stops polling with `pollingStoppedReason: local_deadline`; only the remote
session's own state finalizes the job), and **local cancel always wins**
while **remote cancel is never guaranteed**. Dispatch idempotency
(`dispatchKey = sha256(task + cwd + taskType + workflowStep)`,
`executionId`/`attempt`/`parentExecutionId`/`rootExecutionId`) is separate
from remote-creation reconciliation (fingerprint `repo/branch/task/title/window`
plus a `listSessions` search before creating).

### Workflow-ready job records

`JobRecord` carries nullable workflow columns from the start (`workflow_id`,
`step_id`, `parent_execution_id`, `root_execution_id`, `attempt`,
`remote_state`, `quality_score`, `verified`, `judge_verdict`) so the later
workflow engine never needs a breaking migration.

### C0-real: SQLite as coordination state

`better-sqlite3` is a runtime dependency; `initDb()` runs at MCP and
dashboard startup (`AGENT_HUB_HOME/agent-hub.db`, WAL, singleton per state
dir). Coordination state is partitioned across seven tables:
- `workflows`: DAG definitions (`definition_json`), run status, and timestamps.
- `workflow_nodes`: step status (`pending`, `running`, `waiting`, `succeeded`, `failed`, `skipped`, `canceled`), CAS `claimed_by` leases, and result JSON.
- `jobs`: mirrors execution records, workflow links (`workflow_id`, `step_id`, `parent_execution_id`, `root_execution_id`), `attempt`, `remote_state`, `quality_score`, `verified`, and `judge_verdict`.
- `leases`: distributed single-writer locks for write-mode checkouts (`job_id`, `owner`, `expires_at`).
- `harness_origins`: maps dispatched jobs to their originating harness sessions for completion waking.
- `task_handoffs`: structured cross-step handoff payloads per step.
- `task_context`: append-only workflow-scoped notes, findings, and decisions.

Dual-mode storage writes to both SQLite and the filesystem: `createJob`/`updateResult`
persist `runs/<jobId>/result.json` for filesystem compatibility, while SQLite
serves as the authority for state transitions and cross-process coordination.
The read path is configurable via `AGENT_HUB_STORE`: `json` (default; reads
`result.json`), `sqlite` (reads SQLite first with JSON fallback), or `shadow`
(reads JSON, verifies against SQLite, and logs divergences without blocking).
If `better-sqlite3` is unavailable, storage falls back to `storage.json` under
`AGENT_HUB_HOME` with a one-time warning.

### Event watcher and notifications policy (`src/notify/`)

`bin/agent-hub watch [--once|--follow] [--sink console|file|webhook]`
tails `events.jsonl` (`src/notify/watch.mjs`, offset-tracked) and routes events
according to a declarative notification policy (`src/notify/policy.mjs`):

| Category | Channels | Severity | Default Dedup Window |
|---|---|---|---|
| `job.finished` | `console` | `info` | 0 ms (immediate) |
| `job.failed` | `console`, `file` | `error` | 0 ms (immediate) |
| `jules.waiting` | `console`, `file` | `warn` | 60,000 ms (1 min) |
| `jules.attention_required` | `console`, `file`, `webhook` | `error` | 300,000 ms (5 min) |
| `workflow.completed` | `console`, `file` | `info` | 0 ms (immediate) |

Sinks (`src/notify/adapters.mjs`) dispatch to `console`, file
(`<AGENT_HUB_HOME>/notifications.jsonl`), or an external HTTP webhook
(`AGENT_HUB_WEBHOOK_URL`). Adapters never throw, sanitize secrets before
logging, and suppress duplicate notifications within the category's `dedupMs`
window. The watcher runs as a standalone process outside the MCP stdio lifecycle.

### C1 workflow DAG (`src/workflow/`)

`runWorkflow({workflow, ctx})` executes delegate/fanout/fanin/notify nodes in
parallel waves (`Promise.all` per wave), persisting every transition
(`pending → ready → running → succeeded | failed | skipped | canceled`) to
SQLite so `runWorkflow({workflowId})` resumes after a restart without
re-running `succeeded` nodes. Dependencies resolve via `dependsOn` +
`condition` (safe expression over sibling results) with `onFailure` skip
propagation by default; `fanout` fans N children with distinct `dispatchKey`s
and `fanin` aggregates them. Per-node `maxAttempts` (backoff) and `timeoutS`;
concurrent schedulers can't double-claim a node (`claimed_by` CAS in
`claimWorkflowNode`). No quality/cost/adaptive scoring yet — nodes carry
`onSuccess`/`onFailure` hooks for the future judge (C4). Example:
`examples/software-pipeline.mjs` (research → implementation → review).

### C1.1 execution hardening (`src/workflow/dsl.mjs`, `execution.mjs`)

- `dispatch()` also returns an `ExecutionHandle {jobId, sessionId, abort()}`;
  the engine awaits real completion via `waitExecution()` — a node succeeds
  only on terminal job state, never on dispatch return. Timeout aborts first
  (`cancelJob` locally, stop-wait remotely), then retries.
- Nodes understand `waiting` (`user_feedback|plan_approval|external_event`):
  `running→waiting→running→succeeded`, resumed without duplicating execution.
- Conditions and fan-out `items` use a small safe DSL (`==,!=,===,!==,AND,
  OR,NOT,exists` over `steps.*`) — no `new Function`/`eval` anywhere in `src/`.
- All mutations go through `claimNode()` (sole `ready→running`) and
  `transitionNode()` (`assertValidTransition` always); resume only revives a
  `running` node whose lease expired *and* whose owner is dead, else it
  re-adopts. A `fork()`-based test pins cross-process single execution.
A dispatch result carrying a `jobId` is always waited on (`pendingJobHandle`;
a bare pending record never counts as success), and `dispatchKey` is scoped
by `workflowId` so identical steps in different runs never share a job.

### C1.2 workflow↔supervisor link (`src/workflow/resume.mjs`)

A waiting node resumes only via `resumeWorkflowNodeFromExecution(jobId)`:
it reads the record's `workflow_id/step_id` (C0), no-ops unless the node is
`WAITING` (`not-waiting:<estado>`), and CASes `WAITING→RUNNING` without
stealing a live owner's claim (`owned-elsewhere` otherwise). Both
`jules_supervise` and `jules_interact` call it best-effort after every
successful interaction — the engine never polls Jules itself. Harness
session origin (`_meta.sessionId` → `harness_origins`, mapping only,
`supportsWake:false`) is recorded for the future lifecycle bridge.

### C2 evidence artifacts (`src/artifacts.mjs`)

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

### C3 verifier (`src/verify.mjs`)

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

### C4 judge and revision loop (`src/judge.mjs`)

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

### Context, handoffs, and roles (`src/context.mjs`, `src/handoff.mjs`, `src/roles.mjs`)

Multi-step workflows require structured state transfer between nodes without
forcing downstream models to parse unstructured conversational logs. Agent-hub
provides role definitions and schema-validated handoffs backed by SQLite and
disk artifacts.

**Roles (`src/roles.mjs`)** define responsibilities, required capabilities,
acceptance criteria, and default handoff schemas:

| Role | Default Task Type | Capabilities | Handoff Schema | Required? | Acceptance Rule |
|---|---|---|---|---|---|
| `TRACE_ANALYST` | `recon` | none | `ResearchHandoff` | No | Findings cite file:line |
| `SECURITY_REVIEWER` | `adversarial-review` | `read` | `SecurityReviewHandoff` | Yes | Every finding names the risk and the evidence |
| `ARCHITECT` | `architecture` | `read` | `BaseHandoff` | No | Decisions list tradeoffs |
| `IMPLEMENTER` | `mechanical-edit` | `read`, `write` | `ImplementationHandoff` | Yes | `changedFiles` matches the diff |
| `TEST_ANALYST` | `mechanical-edit` | `read`, `write` | `BaseHandoff` | No | Findings include the failing test |
| `ADVERSARIAL_REVIEWER` | `adversarial-review` | `read` | `ReviewHandoff` | Yes | Decisions explain what must change |
| `PLANNER` | `architecture` | none | `BaseHandoff` | No | The plan validates against `WorkflowPlan` |

**Structured handoffs (`src/handoff.mjs`)** enforce typed contract schemas:
- `BaseHandoff`: requires non-empty `summary`.
- `ResearchHandoff`: requires `summary` and `findings`.
- `SecurityReviewHandoff`: requires `summary`, `findings`, and `constraints`.
- `ImplementationHandoff`: requires `summary` and `changedFiles`.
- `ReviewHandoff`: requires `summary` and `decisions`.

Handoff payloads contain standard fields: `summary`, `findings`, `decisions`,
`constraints`, `changedFiles`, `openQuestions`, `artifacts`. String-only items
are enforced, bounded by `HANDOFF_LIMITS` (max 20 items per field, max 2000
chars per item, max 4000 chars for summary).

**Persistence & consumption (`src/context.mjs`)**:
- A node declares `handoff: { schema: 'ImplementationHandoff', required: true }`
  (or shorthand `handoff: true`). The engine directs the worker to write
  `handoff.json` into its artifacts directory.
- On completion, `validateHandoff` validates the payload. Valid handoffs are
  persisted to SQLite table `task_handoffs` (`workflow_id`, `step_id`,
  `handoff_json`, `updated_at`) and mirrored to `artifacts/handoff.json`.
- When `required: true`, schema validation failure fails the node.
- Downstream steps receive upstream dependency handoffs pre-formatted into their
  dispatched prompt context.
- Fine-grained workflow notes, decisions, and findings are captured in SQLite
  table `task_context` (`workflow_id`, `step_id`, `kind`, `text`, `created_at`).

### Adaptive routing (`src/capabilities.mjs`, `src/routing/score.mjs`)

`route()` used to order a task's chain only by availability and an accepted
proposal. It can now rank candidates by measured quality, latency and cost, and
filter them by required capabilities — while staying explainable:

```js
const r = await route({
  taskType: 'recon',
  requirements: ['sessionResume'],          // hard capability filter
  preferences: { quality: 0.6, cost: 0.2, latency: 0.2 },
  adaptive: true,                            // reorder primary/fallbacks
})
// r.ranking: [{ agent, model, score, reasons: [{dimension, raw, weight, ...}] }]
```

- `src/capabilities.mjs` derives capabilities from signals that already exist:
  `sessionResume` from each adapter's resume argv (`agy --conversation`,
  `opencode -s`, `codex exec resume`; copilot has none), `github` where the CLI
  has built-in GitHub access or works through PRs, `largeContext` from
  `MODEL_REGISTRY` strengths (`1M ctx`). `web` is a reserved key, false
  everywhere today.
- Scoring is a weighted sum over quality (`qualityScore`, else `verifiedRate`,
  else `successRate`), latency (`p95Ms`) and cost (`costUsdAvg`), normalized
  within the eligible set. A dimension with no data is dropped and its weight
  redistributed — an unmeasured pair is **not** ranked as bad.
- `adaptive: false` (default) keeps today's order and still returns `ranking`
  for transparency. Persistent chain changes remain a human-accepted proposal;
  a candidate missing a required capability appears in `skipped` with
  `missing_capabilities:<keys>`.
- With no metrics at all, every score is 0 and the order is the static chain —
  routing degrades to today's behaviour, never to a wrong pick.

### Provider profiles and agys (`src/providers/`)

To prevent quota exhaustion on single accounts, agent-hub supports multi-account
provider profiles (`src/providers/profiles.mjs`) and integrates with the `agys`
Go CLI (`src/providers/agys.mjs`):

- **Profile lifecycle states**: `selected` (active default), `fallback`
  (eligible alternate), `exhausted` (quota exhausted, errorClass `quota`, or
  bucket >= 100%), and `unavailable` (auth/billing failure).
- **Selection policies**: `priority`, `least_used`, and `round_robin`.
- **agys integration**: `agys` (`~/.local/bin/agys`) isolates multi-account
  profiles under `~/.agys/profiles/<name>/` by overriding `HOME`.
  - When `AGENT_HUB_AGYS='auto'`, the hub inspects `agys list` and `agys quota --json`
    to automatically route tasks to non-exhausted accounts by priority.
  - `AGENT_HUB_AGYS_PROFILE` explicitly forces a specific profile name.
  - Synchronous profile resolution (`resolveAgyProfileSync`) caches profile
    state in memory with a 60-second TTL (`SYNC_PROFILE_CACHE_TTL_MS`), ensuring
    synchronous `startJob` and `delegate` calls never block on external CLI runs.

### Execution graph (`src/execution-graph.mjs`)

The `execution_graph` tool and `GET /api/execution-graph` construct a
deterministic DAG of agent executions across workflows, retries, and sessions:

- **Identity**: Nodes identify by `executionId` (falling back to `execution_id`
  or `jobId`). Each node records `id`, `jobId`, `agent`, `model`, `status`,
  `workflow_id`, `step_id`, `attempt`, `parent`, `root`, and `relation`.
- **Relation classification**:
  - `delegate`: standard dispatch invocation.
  - `retry`: when `attempt > 1`.
  - `resume`: when child `sessionId` matches the parent's `sessionId`.
- **Subtree querying**: passing `rootExecutionId` filters the graph to return
  only the directed subtree rooted at that execution.

### Workflow planner and task decomposition (`src/planner/`)

Agent-hub can decompose high-level user goals into structured, executable
workflow DAGs without manual node authoring:

- **Plan schema (`WorkflowPlanSchema`)**: validates a plan with `goal` and `steps`
  (`id`, `role`, `dependsOn`, optional `task` and `taskType`).
- **Validation (`validatePlan`)**:
  - Confirms each step's `role` exists in `ROLES`.
  - Ensures unique step IDs and that all `dependsOn` references exist.
  - Detects dependency cycles using depth-first graph traversal (`findCycleInGraph`).
- **Materialization (`materializePlan`)**:
  - Resolves each step's `role` to capability requirements and default task types.
  - Invokes `route()` to select the optimal `agent` and `model`.
  - Produces a fully validated, runnable `WorkflowSchema` object.
- **Decomposition (`decompose`)**:
  - Accepts `{ intent, runPlanner, routeFn, maxSteps = 12 }`.
  - Executes a provided planner function (e.g. LLM-backed), validates the plan,
    enforces maximum step limits (`maxSteps`), and materializes the workflow.

### Harness profiles and lifecycle bridge (`src/harness/`)

Profiles model caller orchestration strategy without coupling the engine to any
specific client: `generic` (`waitMode: none`), `claude-code` (`attention`), and
`opencode` (`attention`).

- **Priority**: explicit `waitMode`/`harness` arg > `AGENT_HUB_HARNESS` env > MCP
  `clientInfo` handshake hint > `generic`.
- **Wait modes**: `none` returns immediately at create/start; `attention` returns
  on terminal status or interactive waiting (`AWAITING_*`/`PAUSED`); `terminal`
  waits for terminal status only.
- **Lifecycle bridge (`src/harness/bridge.mjs`, `lifecycle.mjs`)**:
  - Data-driven completion notification back to the originating caller session.
  - `recordDispatchOrigin()` captures incoming session metadata into the
    SQLite `harness_origins` table (`job_id`, `harness_session_id`, `harness`).
  - `deliverCompletion({ jobId, event, summary })` queries the resolved bridge
    for `supportsWake()`. When supported, it delivers completion payloads
    (bounded summary up to 300 chars) and emits `harness.wake` events.
  - All registered bridges (`generic`, `claude-code`, `opencode`) currently
    declare `supportsWake: false` (a wakeable OpenCode bridge is planned for a
    future version). Delivery never throws.

### Write-mode gate

A `delegate()`/`job_reply()` call with `mode: 'write'` requires `cwd` to be
a secondary `git worktree add` checkout (see `src/worktree.mjs`), plus a
per-cwd single-writer lock — this keeps an agent CLI from editing the same
working tree Claude Code (or another job) is using, and keeps two write jobs
from racing on the same worktree.

### Metrics and adaptive timeouts

`computeMetrics()` reads the job records under `runs/`, drops non-terminal jobs
and the operational `errorKind`s (`locked`, `worktree_denied`, `orphaned`,
`canceled_by_user`), and aggregates the rest per
`(agent, model, mode, taskType)`: sample count, succeeded/failed/canceled,
success rate, p50/p95 latency over **succeeded** runs, an `errorKind`
histogram and token totals. It backs the `agents_metrics` tool and
`GET /api/metrics`.

Each row also carries the quality/cost/latency intelligence:

- `costUsdTotal` / `costUsdAvg` — summed and averaged over the jobs that carry
  a finite `costUsd` (null when none do).
- `verifiedCount` / `verifiedSamples` / `verifiedRate` / `verificationFailures`
  — from the C3/C4 `verified` verdict on the job record. `verifiedSamples` is
  the denominator: only jobs with an actual boolean verdict count, so an agent
  that was never verified has `verifiedRate: null`, not 0.
- `judgeVerdicts` — histogram of the C4 `judge_verdict`
  (`accepted`/`needs_revision`/`rejected`/`blocked`), mirrored onto the job as
  soon as the judge decides.
- `revisionTotal` / `revisionAvg` and `retryCount` — how much rework a pair
  needed (integer `revision` values; jobs with `attempt > 1`).
- `qualityScore` — `10 * verifiedRate` rounded to one decimal, and `null` when
  there is no verification evidence. Quality is only claimed when it was
  measured; an unverified agent is shown as unknown (`unverified` in the
  dashboard), never as perfect.

Non-finite values are skipped exactly like tokens, so a malformed record can
never turn a row into `NaN`.

`resolveEffectiveTimeoutS()` picks the timeout for a job: an explicit
`timeoutS` always wins (`source: 'explicit'`). Otherwise the static default
from `config.mjs` is **raised, never lowered** — to `ceil(p95s x 1.5)`, capped
at 3600 s — once a row has at least `METRICS_MIN_SAMPLES` (10) samples; thin
`taskType` data falls back to the general (`taskType: null`) row. The job
record keeps the value used and its `timeoutSource` (`adaptive` or `default`).

### Routing proposals

`refreshProposals()` compares a task type's current primary CLI candidate
against the other CLI candidates in its chain. It proposes promoting the
candidate with the strictly better 95% Wilson score lower bound — its lower
bound beats the primary's upper bound — once both have at least 10 samples.
New proposals stay `pending`: nothing changes until a human accepts one at
`#/approvals?tab=proposals`. Accepting one supersedes any other accepted
proposal for the same task type, and a stored proposal whose chain no longer
matches the delegation map (its chain hash changed) is marked `superseded`.
After a rejection, no new proposal for that task type for 7 days. `route()`
applies an accepted proposal to the chain and returns it as `appliedProposal`.

### Learnings

`learning_propose` records a short gotcha about an agent, model or task type as
`pending`; a human approves or rejects it in the dashboard. Approved learnings
that match a job are prepended, most specific first, to the prompt of a
**root** turn only — at most 3, each up to 300 characters — as a
`<hub-learnings>` advisory block; a reply turn continues a conversation that
already has it. Text is sanitized on write and again on every read (control
characters, backticks and `<hub-learnings>` tags stripped, whitespace
collapsed) before it can reach another model's prompt.

### Read-mode guard

Before a `read`-mode job starts, the hub snapshots the git-visible state of
`cwd` (`git status --porcelain=v1 -z` plus `HEAD`) and re-snapshots it when the
job reaches a terminal state. If the tree changed, a job the CLI reported as
succeeded is failed with `errorKind: read_mode_violation` naming the changed
paths; the response text and tokens are still kept. The guard exists because
read mode is not actually enforced by the CLIs: verified, `agy --mode plan`
writes files with or without `--dangerously-skip-permissions` (opencode's plan
agent did respect read mode in testing). A `cwd` outside a git work tree
produces no snapshot and is reported unverifiable rather than clean, and
because the guard is a tree diff it also flags changes other processes make in
the same `cwd` while the job runs.

Files ignored by git (for example `.env` or build output) are skipped by default.
Setting `AGENT_HUB_READGUARD_IGNORED=1` enables snapshotting of ignored files
via `git status --ignored=matching`. Note the documented residual limits:
in-place edits to existing files inside an already-ignored directory without
altering directory mtime or entry count are not detected because `git status`
reports only `!! dir/`. Run read jobs from a disposable worktree when strict
isolation is required.

### Sandbox level matrix (`src/sandbox.mjs`)

When spawning local agent CLIs, agent-hub filters the process environment
according to the profile selected by `AGENT_HUB_SANDBOX_PROFILE` (default
`compatibility`):

| Profile | Host HOME | Environment | Temp & XDG Directories | Isolation Boundary |
|---|---|---|---|---|
| `compatibility` (default) | Inherited | Scrubbed (secret patterns redacted) | Standard host paths (`/tmp`, `~/.cache`, etc.) | None (standard process privileges & network) |
| `isolated-home` | Redirected to temp dir (`/tmp/agent-hub-sandbox-home-*`) | Scrubbed (secret patterns redacted) | Standard host paths (`/tmp`, host XDG) | None (standard process privileges & network) |
| `isolated` | Redirected to sandbox dir (`/tmp/agent-hub-isolated-*`) | Scrubbed; `AGENT_HUB_SANDBOX_DIR` exposed; opt-in copy via `AGENT_HUB_SANDBOX_INCLUDE` | Redirected into sandbox (`tmp/`, `.cache/`, `.config/`, `.local/share/`) | None (standard process privileges & network) |

**What sandbox levels do and do NOT protect:**
- **Secret scrubbing**: All profiles scrub environment variables matching
  `*_TOKEN`, `*_SECRET`, `*_API_KEY`, `AWS_*`, `GH_TOKEN`, `ANTHROPIC_*`,
  `OPENAI_*`, and `JULES_API_KEY`.
- **Credential inclusion (`AGENT_HUB_SANDBOX_INCLUDE`)**: In `isolated` mode,
  specified comma-separated paths are copied into the sandbox directory (relative
  paths preserve their relative layout; absolute paths copy to the sandbox root;
  missing paths are skipped).
- **No container security**: None of these profiles use OS containers, Linux
  namespaces, cgroups, chroot, or network policies. Child processes retain standard
  user privileges and unrestricted network access. `isolated` provides environment
  and path hygiene, not protection against untrusted or hostile code execution.

### Reliability: Benchmarks and chaos testing

Agent-hub includes automated benchmark suites and fault-injection chaos tests
to guarantee correctness, determinism, and crash recovery:

**Benchmark runner (`bench/run.mjs`, `npm run bench`)**:
Executes reproducible workflow scenarios defined in `bench/corpus.mjs`:
- `happy-path`: sequential workflow (`plan` -> `execute`), verifying artifact
  production, command verification pass, and judge acceptance.
- `retry-transient`: transient dispatch failure retrying within `maxAttempts: 2`
  with exponential backoff.
- `revision-verification`: failing verification triggering bounded judge revision
  (`maxRevisionAttempts: 2`) with feedback injection until passing.
- `fanout-child-failure`: failing child node in a parallel fanout step, verifying
  failure propagation to parent and workflow without hanging.

Asserts that all dispatches are deterministic and records zero duplicate dispatches.

**Chaos and crash recovery (`test/chaos/`)**:
- `test/chaos/chaos.test.mjs`: validates duplicate dispatch deduplication via
  `dispatchKey` CAS (exactly one job created for concurrent identical dispatches),
  expired claim re-adoption, live claim protection (live owner claims cannot be
  stolen), and cross-process SQLite write contention with zero lost updates.
- `test/chaos/crash.test.mjs`: simulates mid-wave process death (killing scheduler
  and worker processes), verifying that on workflow resumption, expired claims
  are re-adopted and completed nodes are never re-dispatched.

## MCP tools

| Tool | Input | Notes |
|---|---|---|
| `agents_quota` | `{refresh?: boolean}` | Each delegation pair's quota state, read from a local [CodexBar](#quota-arc-and-codexbar) server: every applicable window with used percent and reset time, `exhausted`, and a reason when CodexBar is unreachable or the pair is not metered. **Information only** — see [Quota state before delegating](#quota-state-before-delegating). |
| `agents_status` | `{refresh?: boolean}` | L0-L2 for every pair in the delegation map. Never pings. Rows include `binPath`/`cliVersion` from `discovery.json`. |
| `route` | `{taskType: enum, mode?: 'read'\|'write', includeCatalog?: boolean, requirements?: string[], preferences?: {quality?, cost?, latency?}, adaptive?: boolean}` | Skips unavailable/breaker-open/held pairs; filters by hard `requirements` capabilities; ranks candidates using preference weights; reorders primary/fallbacks when `adaptive: true`; returns `{primary, fallbacks, skipped, discovery, reason, appliedProposal, ranking}`. `appliedProposal` names the accepted proposal whose order was applied, or `null`. |
| `delegate` | `{agent, model, task, cwd, mode?, timeoutS?, title?, variant?, taskType?}` | Returns `{jobId, status:'queued'}` immediately. `variant` is opencode's reasoning effort (minimal/low/medium/high/max); ignored by agy/copilot. For opencode this is folded into the model ID (`<model>#<variant>`). Pass the same `taskType` given to `route` so metrics, adaptive timeouts, and learnings apply. |
| `dispatch` | `{task, cwd, taskType?, mode?, workflowStep?, dispatchKey?, attempt?, parentExecutionId?, rootExecutionId?, timeoutS?, waitMode?, harness?}` | Atomic decide+execute: revalidates preflight/breaker at execution time, applies per-class recovery policies, deduplicates by `dispatchKey` (concurrent same-key dispatches share one job), reserves write lock lease, and defaults `waitMode` (`none`\|`attention`\|`terminal`) from the caller harness profile. |
| `job_wait` | `{jobId, timeoutS?<=60}` | Polls until terminal (`done`, `waiting:false`), until a remote session waits for interaction (`done` + `waiting:true` with attention fields — act via `jules_interact`, no timeout burned), or until the local budget elapses (`done:false`, `timedOut:true`; job/session keep running). |
| `job_status` | `{jobId}` | Current status, no waiting. |
| `job_result` | `{jobId, maxLines?, tailLines?}` | Head of the response (default 20 lines) plus extra `tailLines` from the end (default 10, never repeating a head line) and `fullPath`, `truncated`, `tailTruncated`. |
| `job_cancel` | `{jobId}` | Kills the whole process group; marks `canceled`. |
| `job_reply` | `{jobId, message?, mode?, timeoutS?, title?, taskType?, action?}` | Starts a new turn in a **terminal** agy/opencode job's conversation, using its recorded `sessionId`. `mode` and `taskType` default to parent job's; switching to `write` goes through worktree gate + lock. Relays to active Jules sessions via `action` (`message`\|`approve_plan`). Copilot unsupported. |
| `agents_metrics` | `{groupBy?: ('agent'\|'model'\|'mode'\|'taskType')[]}` | Success rate, p50/p95 latency, error kinds, tokens, cost (`costUsdTotal`/`costUsdAvg`), verification rate, judge verdicts histogram, revision count, and quality score from job history. |
| `execution_graph` | `{rootExecutionId?: string}` | Read-only execution lineage DAG: roots, nodes (`id`, `agent`, `model`, `status`, `workflow_id`, `step_id`, `attempt`, `parent`, `root`), and edges (`delegate`, `retry`, `resume`). Pass `rootExecutionId` to return a directed subtree. |
| `jules_delegate` | `{task, cwd?, source?, startingBranch?, title?, requirePlanApproval?, automationMode?, account?, timeoutS?, taskType?}` | Starts a Jules cloud session on Google's servers against a connected GitHub repo. Returns `{jobId, status:'queued'}`; the result is a GitHub pull request. |
| `jules_sources` | `{account?}` | The GitHub repos connected to the Jules account. Connect new ones in the Jules web UI. |
| `jules_accounts` | `{}` | Configured Jules accounts, read-only: masked keys, rolling 24-hour and concurrent usage, and sources cache status. |
| `jules_schedules` | `{}` | Recurring Jules tasks, read-only, with next run and last result. Schedules run in the dashboard service. |
| `jules_check` | `{jobId?, sessionId?}` | One live read of a session without poller: `state`, `prUrl`, `branch`, `sessionUrl`, attention fields. Finalizes a local job whose remote session finished while the machine was off. |
| `jules_interact` | `{jobId?, sessionId?, action: 'reply'\|'approve_plan', message?}` | Talk to a live Jules session: `reply` (needs `message`) or `approve_plan`. Interacting does not restart background polling — observe outcome via `jules_wait` or `jules_check`. |
| `jules_wait` | `{jobId?, sessionId?, timeoutS?<=600, pollIntervalS?}` | Local orchestration wait until terminal or waiting state (`AWAITING_*`/`PAUSED`). Remote session unaffected on timeout. |
| `jules_sessions` | `{limit?, state?, account?}` | Lists sessions directly from the Jules API, newest first, with local `jobId` linkage when present. Recovery path when local records are missing. |
| `jules_supervise` | `{jobId?, sessionId?, autoApprovePlan? (=true), autoResolveFeedback?, maxAutoReplies? (=2), maxSafeContinues? (=3), pauseAfterAmbiguity?, timeoutS?, pollIntervalS?}` | Supervised autonomy loop: acquires watcher lease, continuously observes, auto-approves plans, and auto-replies to unambiguous feedback under strict mechanical allowlists. |
| `learning_propose` | `{text, agent?, model?, taskType?, sourceJobId?}` | Records a gotcha as **pending**; a human must approve it in the dashboard before it is injected into a matching prompt. Returns `{learning, note}`. |

Every tool also declares a zod `outputSchema` and returns the same payload as
`structuredContent` for clients that want typed output (the text content stays
JSON for compatibility).

### Resources

| URI | Contents |
|---|---|
| `agent-hub://jobs/{jobId}` | A job's full `result.json` record (the template also lists the 20 most recent jobs) |
| `agent-hub://jobs/{jobId}/response` | A job's `response.txt` as plain text, or empty until the CLI produces text |

### Prompts

| Prompt | Args | Purpose |
|---|---|---|
| `recon` | `{goal, cwd, files?}` | Delegate a bounded, read-only recon task off Claude quota |
| `adversarial-review` | `{goal, cwd, files?}` | Get a second, independently-hosted opinion in parallel with a third CLI |
| `guided-write` | `{goal, cwd, files?}` | Plan → review → execute → delivery-review a non-trivial write, staying in one session via `job_reply` |

## Dashboard

```bash
node bin/agent-hub dashboard --port 7777
# open http://127.0.0.1:7777
```

Binds to `127.0.0.1` only. The page is a sidebar app with deep-linkable hash
routes, so a link can open the exact filtered view:

| Group | Route | Shows |
|---|---|---|
| Monitor | `#/overview` | What needs attention: unhealthy agents, open breakers, failures in the last 24h, unresolved CLIs, recent activity |
| Monitor | `#/agents?filter=all\|unhealthy\|held\|breaker&q=` | Agents grouped by CLI; filter, free-text search, row menu, detail panel |
| Monitor | `#/jobs` | Running and queued jobs with live elapsed time and Cancel |
| Monitor | `#/history?status=&agent=&q=` | Terminal jobs; `status=failed\|succeeded\|canceled`, agent filter, free-text search, error detail, reply chains |
| Monitor | `#/metrics?taskType=` | Success-rate chart and per-pair table; `taskType` filters the rows |
| Activity | `#/subagents` | Claude Code subagent runs recorded by the hooks |
| Activity | `#/timeline?source=&q=` | Last 200 events over SSE, filtered by source and free text |
| System | `#/approvals?tab=proposals\|learnings` | Routing proposals and learnings awaiting a human accept/reject |
| System | `#/tools` | MCP tool inventory (`GET /api/tools`): every registered tool with title and description — validates the loaded build exposes what you expect after each change. |
| System | `#/config?section=delegation\|process\|breaker\|overrides\|paths` | Delegation map, process PATH and CLIs, breaker and TTL, overrides, paths |

Sidebar badges show unhealthy agents, running jobs, failures in the last 24h,
unseen timeline events and unresolved CLIs. Agent row actions are Revalidate,
Ping (an L3 round-trip for that one agent+model), Hold / Release and Reset
breaker; the Agents header adds Revalidate all and Rediscover CLIs. Ping,
Reset breaker and Cancel job ask for confirmation first. The theme follows the
system by default and can be set to light or dark. `preflight` events
(`phase: discovery|agent|ping`) stream over the same SSE feed as job events.

The UI is a React 19 + TypeScript + Vite + Tailwind v4 app in the `dashboard/`
workspace, using shadcn/ui components on Base UI, with TanStack Router (hash
history) and TanStack Query. It is built to `dashboard/dist/` and served
read-only from there — see Install for the build step.

| Route | Method | Body | Notes |
|---|---|---|---|
| `/` and dashboard assets | GET | — | Built app (`index.html` + hashed assets), served from an exact-match allowlist; 503 with a build hint when `dashboard/dist/` is missing |
| `/api/state` | GET | — | `{agents, jobs, subagents, events}` |
| `/api/config` | GET | — | `{delegationMap, discovery, timeouts, breaker, ttlMs, agentHubHome, writeAllowlist, breakerState, overrides, process}` |
| `/api/metrics` | GET | — | Same rows as `agents_metrics`; `?groupBy=agent,model,mode,taskType` |
| `/api/proposals` | GET | — | `{proposals}` |
| `/api/proposals/refresh` | POST | — | Recompute proposals from current metrics and store new pending ones |
| `/api/proposals/:id/accept` | POST | — | Accept a pending proposal (supersedes the previous accepted one for that task type) |
| `/api/proposals/:id/reject` | POST | — | Reject a pending proposal (7-day cooldown before the same task type is proposed again) |
| `/api/learnings` | GET | — | `{learnings}`; `?status=pending\|approved\|rejected` |
| `/api/learnings` | POST | `{text, agent?, model?, taskType?, sourceJobId?}` | Creates a **pending** learning (201) |
| `/api/learnings/:id/approve` | POST | — | Approves a learning so matching root turns get it |
| `/api/learnings/:id/reject` | POST | — | Rejects a learning |
| `/api/learnings/:id` | DELETE | — | Deletes a learning |
| `/events` | GET | — | SSE stream of `events.jsonl` |
| `/api/jobs/:id/cancel` | POST | — | Cancels a running job |
| `/api/jobs/:id/result` | GET | — | Same payload as `job_result`; `?maxLines=&tailLines=` |
| `/api/agents/refresh` | POST | `{agent?, model?, ping?}` | No body = all pairs, L0-L2. `ping:true` runs L3 for exactly one agent+model. |
| `/api/discovery/refresh` | POST | — | Forces a fresh discovery pass, ignoring the TTL |
| `/api/overrides` | POST | `{agent, model, hold?, breakerReset?:true}` | Sets a manual hold and/or clears breaker history |
| `/api/overrides/:agent/:model` | DELETE | — | `model` must be URL-encoded (model ids contain `/`) |

**Security**: the dashboard binds only to `127.0.0.1` and is meant for the
local user. It also defends against a hostile web page open in the same
browser, because that browser connects from loopback too:

- Every request must carry a loopback `Host` header (`127.0.0.1`,
  `localhost` or `[::1]`, any port). This blocks DNS rebinding. Otherwise 403.
- Every state-changing request must come from a loopback address and use
  `Content-Type: application/json`, so a cross-origin browser request needs a
  CORS preflight the server never grants (415 otherwise). When an `Origin`
  header is present it must be the dashboard's own loopback origin (403).
- Request bodies are capped at 64 KiB (413) and must be valid JSON (400).
- Pages and assets send `Content-Security-Policy: default-src 'self';
  script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'
  data:` with no inline script or style, plus `X-Content-Type-Options:
  nosniff`. `style-src 'self'` is still enforced: the app runs Base UI with
  `CSPProvider disableStyleElements`, and chart colors come from CSS variables
  instead of injected styles.

There is no authentication: any local process can call the API. Do not
expose the port beyond loopback (no reverse proxy, no port-forward to a
shared network).

## Quota Arc and CodexBar

[Quota Arc](https://github.com/jalejandrov93/Quota-Arc) is a small notch pinned
to a screen edge that shows how much of each coding assistant's quota is used.
On Windows it can also show an **Agent Hub** cell, read from this dashboard:
jobs running and queued, open circuit breakers and human holds. When the
assistants live inside WSL, Quota Arc reads their quotas from
[CodexBar](https://github.com/steipete/CodexBar) running there.

Nothing needs configuring on the agent-hub side beyond running the dashboard
service ([Optional: run the dashboard as a systemd --user unit](#optional-run-the-dashboard-as-a-systemd---user-unit)).
Setup on the other two sides lives in Quota Arc's
[WSL remote mode guide](https://github.com/jalejandrov93/Quota-Arc/blob/main/docs/wsl-remote-mode.md),
which starts with a quick start. In short:

```sh
# inside WSL, from a Quota-Arc checkout
./wsl/install.sh                    # CodexBar: prints the sudo commands for its systemd unit
systemctl --user enable --now agent-hub-dashboard
```

```powershell
# on Windows
curl.exe http://127.0.0.1:8787/health          # CodexBar
curl.exe http://127.0.0.1:7777/api/state       # agent-hub dashboard
setx QUOTAARC_CODEXBAR_URL http://127.0.0.1:8787
```

**Always use `127.0.0.1`, never `localhost`, from Windows.** Windows resolves
`localhost` to `::1` first, and both this dashboard and CodexBar listen on IPv4
only, so a `localhost` request hangs until it times out rather than falling back.

## Configuration

| Env var | Effect |
|---|---|
| `AGENT_HUB_HOME` | Overrides the state directory (default `~/.local/share/agent-hub`). Tests always override this. |
| `AGENT_HUB_STORE` | Job store read path: `json` (default; reads `result.json`), `sqlite` (reads SQLite first with JSON fallback), or `shadow` (reads JSON, verifies against SQLite, and logs divergences). |
| `AGENT_HUB_READGUARD_IGNORED` | `1` includes gitignored files in read-mode change detection via `git status --ignored=matching`. Default `0`. |
| `AGENT_HUB_SANDBOX_PROFILE` | Spawning sandbox profile: `compatibility` (default; redacts secret env vars, inherits host HOME), `isolated-home` (redacts secrets, redirects HOME to a temporary directory), or `isolated` (redacts secrets, isolates HOME, TMPDIR, and XDG_* directories). |
| `AGENT_HUB_SANDBOX_INCLUDE` | Comma-separated paths to copy into the sandbox directory under `isolated` mode (relative paths maintain structure; absolute paths copy to root). |
| `AGENT_HUB_AGYS` | Enables agys multi-account profile integration. Set to `auto` to query `agys list` and `agys quota --json` for automatic profile selection based on quota/priority. |
| `AGENT_HUB_AGYS_PROFILE` | Explicitly forces a named agys profile, overriding automatic profile selection. |
| `AGENT_HUB_HARNESS` | Default caller harness profile: `generic` (waitMode: `none`), `claude-code` (waitMode: `attention`), or `opencode` (waitMode: `attention`). |
| `AGENT_HUB_LEASE_TTL_MS` | Lease TTL in milliseconds for write-mode worktree locks (default 120,000 ms / 2 min). |
| `AGENT_HUB_DISABLE_STARTUP_DISCOVERY` | `1` skips the background discovery pass on MCP startup. Used by tests that boot the real stdio server and must not spawn a real CLI as a side effect. |
| `AGENT_HUB_CODEXBAR_URL` | Base URL for the local CodexBar quota server (default `http://127.0.0.1:8787`). |
| `AGENT_HUB_CODEX_IGNORE_USER_CONFIG` | `1` passes `--ignore-user-config` to Codex CLI invocations to ignore user-level configuration files. |
| `AGENT_HUB_SCHEDULER` | `0` disables recurring Jules schedule evaluation in the dashboard service. |
| `AGENT_HUB_DB_INIT_RETRIES` | Number of retry attempts when initializing the SQLite database under file-lock contention (default 10). |
| `AGENT_HUB_POST_EDIT_CHECK` | Read by `skills/agy-delegate/scripts/agy-run.sh`: printed as the reminder command to run after a `--write` run, so it names your project's actual type-check/lint/test command instead of a placeholder. |
| `AGENT_HUB_LIVE` | `1` enables `npm run test:live` (one real ping per adapter, uses real quota). |
| `JULES_API_KEY` | API key for Google Jules cloud agent delegation (used when no accounts are configured in `accounts.json`). |

| State file (under `AGENT_HUB_HOME`) | Contents |
|---|---|
| `events.jsonl` | Append-only event log: jobs, preflight, hook-recorded subagents, harness wake events |
| `agent-hub.db` | SQLite database (coordination authority: `workflows`, `workflow_nodes`, `jobs`, `leases`, `harness_origins`, `task_handoffs`, `task_context`) |
| `preflight-cache.json` | L0-L2 results per agent:model pair, TTL-gated (15 min) |
| `discovery.json` | CLI binPath/version/model catalog per agent, from startup + on-demand discovery |
| `overrides.json` | Manual per-pair `hold`/`breakerReset` entries |
| `proposals.json` | Routing proposals (`pending`/`accepted`/`rejected`/`superseded`) with their evidence |
| `learnings.json` | Curated agent/model/taskType learnings (`pending`/`approved`/`rejected`) |
| `accounts.json` | Jules accounts and masked API keys (mode `0600`) |
| `schedules.json` | Recurring Jules tasks evaluated by the dashboard service |
| `sources-cache.json` | Cached GitHub repositories connected to Jules accounts |
| `quota-cache.json` | Cached CodexBar quota readings (5 min TTL) |
| `runs/<jobId>/` | `prompt.txt`, `stdout.log`, `response.txt`, `result.json` per job |
| `runs/<workflowId>/<stepId>/artifacts/` | Step evidence directory: `artifacts.manifest.json`, `verification.json`, `judge.json`, `handoff.json`, and step-declared artifact files |
| `runs/.locks/` | Per-cwd single-writer locks for write-mode jobs |

## Comparison with ai-dispatch

[ai-dispatch](https://github.com/agent-tools-org/ai-dispatch) is a Rust,
CLI-first tool in the same family — dispatching bounded tasks to other agent
CLIs — with an embedded `aid mcp` server as one entry point among several.
agent-hub is MCP-first: it has no standalone CLI dispatch mode, only the MCP
tools above plus the `agent-hub preflight`/`dashboard`/`selftest`
subcommands. Functional differences: agent-hub adds task-type fallback
chains (a delegation map with an ordered chain per task type, not a single
target), a per-pair circuit breaker, session resume for follow-up turns
(`job_reply`), and a worktree-based write-mode gate. Ideas borrowed from
ai-dispatch: a two-tier discovery/preflight cache, pruning stale state
before rendering it, and externally inspectable hold markers (`overrides.json`
here, read and writable by hand, not only through the dashboard).

## Testing

```bash
npm test                                                      # server, node --test; fast, hermetic, no real CLI calls
npm run bench                                                 # workflow benchmark runner across corpus scenarios
npm run test:live                                             # AGENT_HUB_LIVE=1; real CLI pings across adapters (uses real quota)
npm run -w dashboard test                                     # dashboard, Vitest + Testing Library
npm run -w dashboard typecheck                                # dashboard, tsc --noEmit
node --test test/chaos/chaos.test.mjs test/chaos/crash.test.mjs # chaos concurrency and crash recovery suite
```

See `test/fixtures/README.md` for exactly which adapter fixtures are real CLI
output versus hand-built synthetic shapes, and why.

## Versioning

This project follows [Semantic Versioning](https://semver.org/) and
[Conventional Commits](https://www.conventionalcommits.org/). See
[CHANGELOG.md](./CHANGELOG.md) for release history.

## License

[Apache-2.0](./LICENSE)

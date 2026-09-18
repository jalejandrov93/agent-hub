# agent-hub

A local [MCP](https://modelcontextprotocol.io) server that lets Claude Code
delegate bounded, read-heavy tasks (recon, call-chain tracing, summarizing
large artifacts, second opinions, adversarial review) to other agent CLIs —
Antigravity (`agy`), `opencode`, and GitHub `copilot` — instead of spending
Claude Code's own quota on them. It adds a real preflight ladder (so a job is
never handed to a CLI that is missing, broken, or already circuit-broken), an
append-only event log, and a local dashboard that also shows Claude Code's
own subagents.

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
  index.mjs          MCP bootstrap (stdio) + --selftest/--version
  config.mjs         paths, TTLs, model registry, timeouts, adaptive-timeout and breaker constants
  schemas.mjs        shared zod contracts (tool outputSchema + dashboard types); browser-safe
  eventlog.mjs        appendEvent() (one atomic append per line) / readTail()
  fsutil.mjs           writeJsonAtomic()/updateJsonLocked() (lock + tmp + rename) for state shared by two processes
  jobstore.mjs        runs/<jobId>/{prompt.txt,stdout.log,response.txt,result.json}
  process.mjs         spawn argv, SIGTERM->SIGKILL ladder, runCommand()
  jobrunner.mjs        ties process+jobstore+worktree+timeouts+learnings+readguard into startJob/cancelJob
  preflight.mjs        L0-L3 ladder, TTL cache, circuit breaker
  preflight-cli.mjs    `agent-hub preflight` table printer
  discovery.mjs        CLI discovery (binPath/version/models), startup + on-demand
  overrides.mjs        manual per-pair hold / breaker-reset overrides
  startup.mjs          non-blocking startup discovery scheduler
  router.mjs           delegation map + availability filtering, applies accepted proposals
  worktree.mjs         write-mode gate (secondary git worktree) + single-writer lock
  metrics.mjs          job-history aggregation (success rate, p50/p95, tokens) per agent/model/mode/taskType
  timeouts.mjs         effective timeout: explicit > adaptive (p95 x 1.5) > static default
  proposals.mjs        Wilson-bound chain-reorder proposals, human-accepted before they apply
  cloud/
    jules/client.mjs   Jules v1alpha REST client (injectable fetch, 30s deadline, JulesApiError)
    jules/adapter.mjs  tolerant parsing of the alpha session/activity shapes
    gitContext.mjs     infers sources/github/{owner}/{repo} + branch from a checkout
    poller.mjs         the remote session poll loop (dedup by activity identity, backoff)
    runner.mjs         startRemoteJob/finishRemoteJob/resumeRemoteJobs
    check.mjs          one-shot live read of a session, no poller required
  learnings.mjs        curated pending/approved gotchas, sanitized and injected into root turns
  readguard.mjs        git before/after snapshot for read jobs -> read_mode_violation
  hook.mjs             SubagentStart/SubagentStop -> events
  dashboard.mjs        node:http dashboard: serves dashboard/dist, SSE /events, JSON API
  adapters/{base,agy,opencode,copilot,index}.mjs
  tools/{agents,jobs,insights,learnings}.mjs
dashboard/             React 19 + TS + Vite + Tailwind v4 + shadcn/Base UI workspace, builds dist/
scripts/               build-dashboard.mjs — the `prepare` hook (never fails npm install)
bin/agent-hub          dispatch: mcp | hook | dashboard | preflight | selftest
skills/                multi-agent-orchestrator and agy-delegate skills (see Install)
test/                  node --test; fixtures/ has real+synthetic CLI output;
                        live/ is real-CLI, gated by AGENT_HUB_LIVE=1
systemd/agent-hub-dashboard.service   NOT installed — copy it yourself if wanted
```

Runtime state (never committed) lives in `AGENT_HUB_HOME`, default
`~/.local/share/agent-hub/`: `events.jsonl`, `preflight-cache.json`,
`discovery.json`, `overrides.json`, `proposals.json`, `learnings.json`,
`runs/<jobId>/`, `runs/.locks/`.

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
workflow engine never needs a breaking migration. `src/storage/sqlite.mjs`
provides the minimal C0 store (SQLite WAL when `better-sqlite3` is present,
JSON fallback otherwise) with `workflows`, `workflow_nodes`, `jobs` and
`leases` tables; `runs/<jobId>/result.json` stays the source of truth until
the engine lands.

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
the same `cwd` while the job runs. Files ignored by git (for example `.env` or
build output) are outside the snapshot, so edits to them are not detected: run
read jobs from a disposable worktree when that matters.

## MCP tools

| Tool | Input | Notes |
|---|---|---|
| `agents_status` | `{refresh?: boolean}` | L0-L2 for every pair in the delegation map. Never pings. Rows include `binPath`/`cliVersion` from `discovery.json`. |
| `route` | `{taskType: enum, mode?: 'read'\|'write', includeCatalog?: boolean}` | Skips unavailable/breaker-open/held pairs; returns `{primary, fallbacks, skipped, discovery, reason, appliedProposal}`. `discovery` holds `{binPath, version, modelCount, checkedAt, error}` per CLI; `includeCatalog: true` returns the full model catalog instead. `appliedProposal` names the accepted proposal whose order was applied, or `null`. |
| `delegate` | `{agent, model, task, cwd, mode?, timeoutS?, title?, variant?, taskType?}` | Returns `{jobId, status:'queued'}` immediately. `variant` is opencode's reasoning effort (minimal/low/medium/high/max); ignored by agy/copilot. Pass the same `taskType` you gave `route` so metrics, adaptive timeouts and learnings apply. |
| `dispatch` | `{task, cwd, taskType?, mode?, workflowStep?, dispatchKey?, attempt?, parentExecutionId?, rootExecutionId?, timeoutS?}` | Atomic decide+execute: revalidates preflight/breaker at execution time (closes the `route`→`delegate` TOCTOU gap), applies the per-class policy with adapter-aware recovery (remote candidates resume/reconcile before retry; policy resolved from the real error, not the caller's guess), and deduplicates by `dispatchKey` (concurrent same-key dispatches share one job). Write mode reserves a lease token that `startJob` adopts. `route` stays recommendation-only, `delegate` exact-execution. |
| `job_wait` | `{jobId, timeoutS?<=60}` | Polls until terminal (`done`, `waiting:false`), until a remote session waits for interaction (`done` + `waiting:true` with `attentionRequired`, `attentionReason`, `recommendedAction` — act via `jules_interact`, no timeout burned), or until the local budget elapses (`done:false`, `timedOut:true`; job/session keep running). |
| `job_status` | `{jobId}` | Current status, no waiting. |
| `job_result` | `{jobId, maxLines?, tailLines?}` | Head of the response (default 20 lines) plus extra `tailLines` from the end (default 10, never repeating a head line) and `fullPath`, `truncated`, `tailTruncated`. |
| `job_cancel` | `{jobId}` | Kills the whole process group; marks `canceled`. |
| `job_reply` | `{jobId, message?, mode?, timeoutS?, title?, taskType?, action?}` | Starts a new turn in a **terminal** agy/opencode job's conversation, using its recorded `sessionId`. `mode` and `taskType` default to the parent job's; switching to `write` goes through the same worktree gate + lock as `delegate`. copilot has no session resume and returns `{status:'failed', errorKind:'unsupported'}` without spawning anything. A non-terminal parent gets `errorKind:'not_terminal'`; a parent with no `sessionId` gets `errorKind:'no_session'`. Returns `turnDepth` and, from 5 turns deep, a `warning` to start a fresh `delegate` with a short summary. |
| `agents_quota` | `{refresh?}` | Each delegation pair's quota state, read from a local [CodexBar](#quota-arc-and-codexbar) server: every applicable window with used percent and reset time, `exhausted`, and a reason when CodexBar is unreachable or the pair is not metered. **Information only** — see [Quota state before delegating](#quota-state-before-delegating). |
| `agents_metrics` | `{groupBy?: ('agent'\|'model'\|'mode'\|'taskType')[]}` | Success rate, p50/p95 latency, error kinds and tokens per group (default: all four dimensions) from job history. |
| `jules_delegate` | `{task, cwd?, source?, startingBranch?, title?, requirePlanApproval?, automationMode?, account?, timeoutS?, taskType?}` | Starts a Jules cloud session. Needs `JULES_API_KEY` and either `cwd` (infers the source and branch from the `origin` remote) or an explicit `source`. Returns `{jobId, status:'queued'}`; the job behaves like any other for `job_status`/`job_wait`/`job_result`. The result is a GitHub pull request. |
| `jules_sources` | `{account?}` | The GitHub repos connected to the Jules account. Connect new ones in the Jules web UI — the API cannot add them. |
| `jules_check` | `{jobId?, sessionId?}` | One live read of a session: `state`, `prUrl`, `branch`, `sessionUrl`, last message — plus `attentionRequired`, `attentionReason`, `recommendedAction`, `canAutoResolve`, `attempts` when the session is waiting (`AWAITING_*`/`PAUSED`). Needs no poller, so it works after a reboot, and it finalizes a local job whose session ended while the machine was off. |
| `jules_interact` | `{jobId?, sessionId?, action: 'reply'\|'approve_plan', message?}` | Talk to a live Jules session: `reply` (needs `message`) or `approve_plan`. Remote `pause`/`resume`/`cancel` are rejected — the API does not offer them; a `PAUSED` session is observed with backoff, not resumed by call. Bumps `attempts`/`interventionCount` (`autoReplyCount` for replies, `planApprovalCount` for approvals — never `turnDepth`, so approvals don't consume the auto-reply budget) but deliberately leaves `pollingStoppedReason` untouched — only an observation that sees a non-waiting state clears it, and interacting never restarts polling. `job_reply` on a Jules parent runs the same shared implementation (`interactWithSession`). |
| `jules_wait` | `{jobId?, sessionId?, timeoutS?<=600, pollIntervalS?}` | Local orchestration only (the API has no wait endpoint). Waits until terminal (`done`+`terminal`) or waiting (`done`+`waiting` with attention fields), else `done:false`+`timedOut:true` on budget expiry. Remote session unaffected. |
| `jules_sessions` | `{limit?, state?, account?}` | Lists sessions straight from the Jules API, newest first, each with the local `jobId` when this machine has one and `null` when it does not. Without `account` it merges every enabled account, tags each session with its `accountId`, and reports an account that fails in `accountErrors` without failing the call. The recovery path when the local record is gone. |
| `jules_accounts` | `{}` | The configured Jules accounts, read-only: masked keys (`keyLast4` only), rolling 24-hour and concurrent usage, and each account's source-cache status. Accounts are created and edited in the dashboard. |
| `jules_schedules` | `{}` | The recurring Jules tasks, read-only, with their next run and last result. Schedules are created and edited in the dashboard. |
| `jules_supervise` | `{jobId?, sessionId?, autoApprovePlan? (=true), autoResolveFeedback?, maxAutoReplies? (=2), maxSafeContinues? (=3), pauseAfterAmbiguity?, timeoutS?, pollIntervalS?}` | Supervised autonomy for a Jules session: acquires the `remote.watch` lease (atomic CAS, UUID owner, monotonic generation) and loops observe → decide → interact → resume-observation. Decisions are three-level with evidence: `AUTO_REPLY` (strict mechanical allowlist), `SAFE_CONTINUE` (conditional operational blockers, e.g. stale dep only without API change), `REQUEST_USER` (10 escalation classes) — budgets `maxAutoReplies` / `maxSafeContinues` on separate counters. Outcomes: `terminal`, `attention`, `paused`, `timeout`, `budget_exhausted`. |
| `learning_propose` | `{text, agent?, model?, taskType?, sourceJobId?}` | Records a gotcha as **pending**; a human must approve it in the dashboard before it is injected into a prompt. Returns `{learning, note}`. |

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
| `AGENT_HUB_DISABLE_STARTUP_DISCOVERY` | `1` skips the background discovery pass on MCP startup. Used by tests that boot the real stdio server and must not spawn a real CLI as a side effect. |
| `AGENT_HUB_POST_EDIT_CHECK` | Read by `skills/agy-delegate/scripts/agy-run.sh`: printed as the reminder command to run after a `--write` run, so it names your project's actual type-check/lint/test command instead of a placeholder. |
| `AGENT_HUB_LIVE` | `1` enables `npm run test:live` (one real ping per adapter, uses real quota). |

| State file (under `AGENT_HUB_HOME`) | Contents |
|---|---|
| `events.jsonl` | Append-only event log: jobs, preflight, hook-recorded subagents |
| `preflight-cache.json` | L0-L2 results per agent:model pair, TTL-gated |
| `discovery.json` | CLI binPath/version/model catalog per agent, from startup + on-demand discovery |
| `overrides.json` | Manual per-pair `hold`/`breakerReset` entries |
| `proposals.json` | Routing proposals (`pending`/`accepted`/`rejected`/`superseded`) with their evidence |
| `learnings.json` | Curated agent/model/taskType learnings (`pending`/`approved`/`rejected`) |
| `runs/<jobId>/` | `prompt.txt`, `stdout.log`, `response.txt`, `result.json` per job |
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
npm test                              # server, node --test; fast, hermetic, no real CLI calls
npm run -w dashboard test             # dashboard, Vitest + Testing Library
npm run -w dashboard typecheck        # dashboard, tsc --noEmit
AGENT_HUB_LIVE=1 npm run test:live    # one real PONG per adapter — uses real quota
```

See `test/fixtures/README.md` for exactly which adapter fixtures are real CLI
output versus hand-built synthetic shapes, and why.

## Versioning

This project follows [Semantic Versioning](https://semver.org/) and
[Conventional Commits](https://www.conventionalcommits.org/). See
[CHANGELOG.md](./CHANGELOG.md) for release history.

## License

[Apache-2.0](./LICENSE)

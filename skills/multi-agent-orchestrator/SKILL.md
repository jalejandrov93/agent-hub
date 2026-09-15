---
name: multi-agent-orchestrator
description: >
  Orchestrates delegation of bounded subtasks to the local `agent-hub` MCP server, which runs
  agy (Antigravity), opencode, and GitHub copilot CLIs off Claude's own quota, plus routes
  Claude subagent tiers (haiku/sonnet/opus). Trigger: multi-agent, delegate, orchestrate,
  parallelize, agent team, agent swarm, second opinion, save tokens, don't burn Claude, "agy",
  "antigravity", "gemini flash", "opencode", "muse", "copilot", free model, which agent,
  agent dashboard, adversarial review, distribute this task, use all agents, revalidate agents,
  agent-hub dashboard.
license: Apache-2.0
metadata:
  author: jalejandrov93
  version: "2.1"
---

## When to use / not

Use when a subtask is bounded and read-heavy (recon, call-chain trace, artifact summary,
second opinion, adversarial review) and the useful answer is short relative to what must be
read to produce it. Also use for cheap/free-quota work (triage, GitHub-context calls,
mechanical writes in an isolated worktree) to preserve Claude's own quota.

Do **not** delegate: a judgment you will have to re-verify by reading the code yourself (you
pay twice); anything whose answer is inherently long; anything touching secrets/`.env`/tokens;
work where being wrong is expensive and hard to detect; implementation that needs this repo's
`CLAUDE.md`/skills/hooks (only Claude Code loads those — see `implementation-with-repo-rules`).

## The loop

```
agents_status → route → delegate → job_wait / job_status → job_result → (job_reply)* → synthesize
```

1. `agents_status({refresh?})` — L0-L2 preflight (no ping) for every agy/opencode/copilot
   pair in the delegation map. Returns `ready|degraded|unavailable`, `reason`, `latencyMs`,
   `quotaSignal`, `dataPolicy` badge, and `binPath`/`cliVersion` (null until a discovery row
   exists for that agent). The MCP server fires CLI discovery (L0 `--version` + L1 model list —
   never an L3 ping) in the background at startup, persisted to `discovery.json` under
   `AGENT_HUB_HOME` with a 15-min TTL, so the first `agents_status` call in a session is usually
   already warm. `AGENT_HUB_DISABLE_STARTUP_DISCOVERY=1` opts out (used by the server's own test
   suite). Call `agents_status` once per session or when routing looks stale; `refresh:true`
   bypasses the 15-min cache.
2. `route({taskType, mode?, includeCatalog?})` — `taskType` is one of the keys in the Delegation map below;
   `mode` is `'read'|'write'`. Returns `{primary:{agent,model,mode}, fallbacks[], skipped[],
   discovery, reason, appliedProposal}`, where `discovery` is a per-CLI `{binPath, version, modelCount, checkedAt,
   error}` summary and `appliedProposal` is the accepted proposal whose reorder was applied (or
   `null`) — a human accepted it from the dashboard, so treat that order as intended. Pass
   `includeCatalog:true` only when you need the model ids a CLI actually
   offers (the full catalog costs several KB of context) — route stays advisory, it never blocks you, only orders/filters
   candidates. `skipped` lists every filtered-out chain candidate as `{agent, model, reason}`:
   `held` (a human put this pair on hold from the dashboard — don't silently route around it,
   tell the user), `cli_not_found` (the CLI isn't installed or isn't on PATH — this needs a
   human, not a retry), `cached_unavailable`, or `breaker_open`. `{agent:'claude', model:
   'haiku'|'sonnet'|'opus'}` in the result means run it yourself via the Agent tool — never
   pass it to `delegate`. When the choice matters and the pair has history, call
   `agents_metrics` first (`groupBy` optional) — success rate, p50/p95 latency and error kinds
   per agent/model/mode/taskType beat a guess.
3. `delegate({agent, model, task, cwd, mode?, timeoutS?, title?, variant?, taskType?})` — `agent` is
   `'agy'|'opencode'|'copilot'`. Returns `{jobId, status:'queued'}` immediately. `task` must
   name the output shape and a line budget (see Prompt-shaping below). `mode:'write'` requires
   `cwd` to be a secondary `git worktree add` checkout or an allowlisted path. `variant` is
   opencode's reasoning effort (minimal/low/medium/high/max); ignored by agy/copilot. Muse Spark
   1.3 defaults to `high` from the model registry when `variant` is omitted. Pass the same
   `taskType` you gave `route` — it feeds metrics, adaptive timeouts and learnings.
4. `job_wait({jobId, timeoutS<=60})` to block until terminal, or `job_status({jobId})` to poll
   without blocking. Both return `{status, errorKind, error, ...}`.
5. `job_result({jobId, maxLines?})` — head of the response (default 20 lines) plus
   `{truncated, fullPath, tokens, costUsd, sessionId}`. Read `fullPath` only if the head is
   insufficient — do not default to pulling the whole file into context.
6. `job_reply({jobId, message, mode?, timeoutS?, title?, taskType?})` — optional: start a new turn in a
   **terminal** agy/opencode job's conversation, resuming its recorded `sessionId`. `mode` and
   `taskType` default to the parent job's (so metrics and adaptive timeouts keep grouping the
   conversation's turns together); switching to `write` goes through the same worktree gate +
   lock as `delegate`. copilot has no session resume (`errorKind:'unsupported'`, nothing
   spawned); a non-terminal parent gets `errorKind:'not_terminal'`; a parent with no `sessionId`
   gets `errorKind:'no_session'`. The reply returns `turnDepth` and, once the conversation is 5
   turns deep, a `warning` suggesting a fresh `delegate` with a short summary. See "Guided
   delegation workflow" below for the read → read → write → read pattern this exists for.
7. Synthesize: report what each delegate found, flag disagreements, do not restate raw output.

`job_cancel({jobId})` kills the whole process group (needed for opencode, which ignores
SIGTERM — the hub SIGKILLs it). MCP prompts `recon`, `adversarial-review` and `guided-write`
(args `{goal, cwd, files?}`) package this loop for clients that surface prompts.

## Guided delegation workflow (plan → review → execute → delivery review)

Use this instead of one write-mode `delegate` call whenever the change is non-trivial. It applies
to **both agy and opencode** (both support session resume via `job_reply`; copilot doesn't, so it
can't run this pattern). This mirrors a real manual workflow observed across dozens of delegated
tasks (`notes/gemini*-plan-corrections.md`, `notes/opencode-*-go.md`,
`notes/gemini*-delivery-corrections.md` in a large monorepo migration): plan first, a human (or
Claude) checks the plan against the real tree before any write happens, and the delivery itself
gets one more correction pass before it's considered done — never trust either self-report.

1. **Plan.** `delegate({agent, model, task:'<propose a plan for X, do not edit anything>', cwd:
   <worktree>, mode:'read'})` — read mode. **Do not assume the CLI honors it.** Verified:
   `agy --mode plan` writes files with or without `--dangerously-skip-permissions`
   (`opencode`'s plan agent did respect read mode in testing). The hub enforces read mode after
   the fact with its read-mode guard: it diffs the git-visible state of `cwd` before and after
   the turn and fails the job with `errorKind:'read_mode_violation'` if anything changed. Run
   agy read/plan turns in a disposable git worktree you can reset, and treat that failure as
   "the plan turn tried to edit," not as a bad plan.
2. **Plan review.** `job_wait`/`job_result` the plan, and check it against the actual code (not
   just internal consistency) — the real corrections seen in practice were things like "this
   validation schema already exists, reuse it," "that field starts at 0 in the legacy code, keep
   it," "don't touch this other file, a different task owns it." If it needs changes:
   `job_reply({jobId, message:'<specific, numbered feedback>', mode:'read'})` — still read mode,
   same conversation, so the model has the earlier turn's context. Repeat until the plan is right.
3. **Execute.** Once approved: `job_reply({jobId: <the last reply's jobId>, message:'execute the
   approved plan', mode:'write'})` — the one call that can touch the filesystem, through the
   normal write-mode worktree gate + lock.
4. **Delivery review.** Don't stop at "it says it's done." Run the task's own required
   verification commands yourself (see the task header template below) and read the diff. If
   anything is off — a behavior change nobody asked for, missing tests the task actually required,
   leftover dead code, a validation gap — send it back in the **same conversation**, still in
   write mode, without a commit yet: `job_reply({jobId: <execute job's id>, message:'<numbered
   corrections>', mode:'write'})`. Only commit once this comes back clean.

Each `job_reply` call passes the previous job's `sessionId` (agy: `--conversation`; opencode:
`-s`) — that is what lets step 3 (`accept-edits`/`build`) act on exactly what steps 1-2
negotiated, and step 4's corrections land in the same worktree/branch as step 3, instead of
starting cold every time. (The manual version of this workflow re-pastes the corrected plan as a
brand-new message instead of resuming a real session — `job_reply` is strictly better: the model
keeps the actual prior turns, not a human's paraphrase of them.)

## Break-even rule

```
tokens(files the agent would read)  >>  tokens(answer returned) + tokens(verification you still need)
```

The third term is the one people skip. If you cannot trust the answer without opening the same
files, you paid two quotas for one answer. Delegate when the answer is a *location*, *list*,
*count*, or *summary*. Do not delegate a *judgment* you must audit yourself.

## Delegation map (from `router.mjs` `DELEGATION_MAP`)

| taskType | Primary | Fallback(s) | Why |
|---|---|---|---|
| `recon` | agy `gemini-3.8-flash-low` | opencode `muse-spark-1.3-contributor-free` → Claude `haiku` | proven context compression, cheap refreshable quota |
| `call-chain-trace` | agy `gemini-3.8-flash-high` | opencode `nemotron-3-ultra-free` → Claude `sonnet` | needs multi-hop reasoning, 1M ctx |
| `research` | opencode `muse-spark-1.3-contributor-free` | opencode `mimo-v2.5-free` → agy `gemini-3.8-flash-medium` | zero cost, 1M ctx |
| `triage` | opencode `muse-spark-1.3-contributor-free` | copilot `auto` | lowest latency (nemotron-3.5-lightning-free hangs — see opencode.md) |
| `second-opinion` | agy `gemini-3.1-pro-high` | copilot `auto` | different model lineage than Claude Code |
| `adversarial-review` | agy `claude-sonnet-4-6` **parallel with** copilot `auto` | agy `claude-opus-4-6-thinking` | dual blind review off the Claude Code quota |
| `github-context` | copilot `auto` | — | built-in GitHub MCP; no second fallback (see copilot.md) |
| `mechanical-edit` | opencode `deepseek/deepseek-v4-flash` (write) | copilot `auto` (write) | cheap write-capable; single writer |
| `implementation-with-repo-rules` | Claude `sonnet` (Agent tool) | — | only Claude Code loads CLAUDE.md + skills + hooks |
| `architecture` | Claude `opus` (Agent tool) | agy `claude-opus-4-6-thinking` | highest reasoning |
| `structured-mechanical` | Claude `haiku` (Agent tool) | — | cheapest Claude tier |

Unknown `taskType` throws — call `route` with one of the exact strings above.

## What each CLI's models are good for

- **agy** (Antigravity): `gemini-3.8-flash-{low,medium,high}` for recon → call-chain-trace
  by size; `gemini-3.1-pro-{low,high}` for a second architectural opinion; `claude-sonnet-4-6`
  / `claude-opus-4-6-thinking` are Claude models hosted *inside* Antigravity — adversarial
  review and architecture judgment at zero Claude-quota cost. Full detail:
  `references/agents/agy.md`.
- **opencode**: free tier (`opencode/muse-spark-1.3-contributor-free`,
  `opencode/mimo-v2.5-free`, `opencode/big-pickle`) for research/recon fallback — zero cost,
  but Meta trains on prompts (user-accepted, badge stays visible). Paid
  `deepseek/deepseek-v4-flash` for write-mode mechanical edits; `opencode-go/*` is capped
  ($12/5h, $30/wk, $60/mo, no usage API). Full detail: `references/agents/opencode.md`.
- **copilot**: `--model` availability is subscription-specific — an explicit id can be rejected
  with `model_unavailable` even when it's listed in `help config`; treat any explicit id as
  unverified until an L3 ping confirms it, and default to `auto`, which is always accepted.
  `auto` covers triage, second-opinion, github-context, and write-mode mechanical edits. Full
  detail (incl. one verified setup): `references/agents/copilot.md`.
- **Claude subagents** (haiku/sonnet/opus): never called via `delegate` — run through the
  Agent tool. Full detail: `references/agents/claude-subagents.md`.

## Prompt-shaping rules (the `task` field)

- Name the exact output shape and a hard line budget in every `task` — an unshaped prompt to
  agy measured 108s/~27k tokens of `file://` noise vs 4s/233 tokens with a contract. Example:
  `"List files under src/ that define X. One relative path per line. Max 15 lines."`
- Never rely on a structured-output flag (e.g. agy's `--json-schema`) — measured unreliable
  (empty `structured_output` while the free text held the right answer). Shape output through
  the prompt text instead.
- Batch related questions into one `task` as numbered blocks — each call carries a large fixed
  baseline (agy: ~21k tokens from `~/.gemini/GEMINI.md`); three questions in one call cost
  roughly a third of three separate calls.
- Never put secrets, `.env` contents, tokens, or credentials in a `task` string.

### Task header template (write-mode / non-trivial tasks)

For anything past a one-shot read, prepend a fixed header to the `task` — paste the same block
into every task of a batch so nothing has to be re-derived per call. Adapted from a header reused
across dozens of real delegated tasks in this codebase:

```
Repo: <absolute worktree path> (branch <name>). App/package: <target>.
Read first: <AGENTS.md/CLAUDE.md path(s) with the load-bearing rules — see the agy.md gotcha:
  a raw CLI call does not auto-load this repo's rules, restate them>.
Rules: 1) same behavior as <baseline>, except what the framework forces; 2) TDD — failing test
  first; 3) do not touch: <explicit denylist for this task — a different task or a generated
  file>; 4) no commit, no push; 5) do not start a dev server (one may already be running); 6) <any
  other repo-specific rule that would otherwise only live in CLAUDE.md/AGENTS.md>.
Required verification before you report done (paste the summarized output):
  <exact test command>
  <exact type-check command>
  <exact lint command>
  <any project-specific check, e.g. base-path:check>
Delivery: files touched, new tests (what failed before), verification output. Max <N> lines.
```

The "do not touch" list is what keeps two parallel worktrees/tasks from fighting over the same
file (see Parallel work below) — it is policy the hub does not enforce, so it only works if every
task's header states it explicitly.

## Write mode

`mode:'write'` requires `cwd` to be a secondary `git worktree add` checkout (or an entry in
`config.mjs`'s `WRITE_ALLOWLIST`, empty by default) — the hub refuses writes into the primary
checkout (`errorKind:'worktree_denied'`) and serializes writers per cwd with a lock file
(`errorKind:'locked'` if held). The file-pattern denylist is policy, not enforced by the hub —
define your repo's own never-touch list and apply it yourself before delegating a write:
generated/derived files, migration tooling, config that changes build/deploy output, and
anything strict TDD reserves for the user to write (tests) belong on that list by default.

> Example: author's setup (verified 2026-09), a Next.js monorepo — `prisma/` (`migrate dev`
> banned), anything that produces a URL (a repo-specific base-path rule), `src/server/openapi/**`
> (generated), tests (strict TDD), `next.config.ts`, `package.json`, `turbo.json`.

After any delegated write, in this order: `git diff` (review it yourself), your repo's own
type-check/lint/test commands, and any other project-specific check it requires (codegen,
bundle checks — set `AGENT_HUB_POST_EDIT_CHECK` so `agy-run.sh` prints it after a write).

## Parallel work: one worktree per block, serialize within it

The hub's write lock (`errorKind:'locked'`) only serializes jobs targeting the exact same `cwd` —
it has no idea whether two *different* worktrees touch overlapping files. Observed pattern for
running several write-mode delegates at once without them corrupting each other's git index or
breaking each other's tests:

- **One worktree per block of work that touches a distinct set of files** (e.g. one worktree for
  "move shared components," a separate one for "rewrite routing," another for "one feature
  module"). Different worktrees can run fully in parallel.
- **Inside one worktree, tasks that touch overlapping files go one at a time**, oldest first —
  even across different agents/models. Say so explicitly in the task header ("do not start until
  task X above is delivered and merged in this worktree").
- State the exact worktree path and branch in every task header (see the template above) — never
  let a task infer or guess it, and never let two agents write into the primary checkout.
- Give every `delegate`/`job_reply` a `title` that encodes agent+task, e.g. `gemini1-roles`,
  `opencode-D5-people` — with several jobs in flight across worktrees, a consistent short label
  is what lets you (and the dashboard's Job history panel) tell them apart later.
- After a worktree's work is delivered and merged into the integration branch, refresh sibling
  worktrees still in flight (rebase or recreate them) rather than letting them drift further from
  what already landed — the longer they diverge, the more the next delivery-review pass has to
  reconcile by hand.

## Failure handling by `errorKind`

This table is for a `delegate`/`job_*` call that already ran. A candidate `route` filtered out
before you ever called `delegate` shows up in `skipped` instead (see loop step 2) — `held` and
`cli_not_found` there both mean "needs a human," not "retry."

| errorKind | Meaning | Action |
|---|---|---|
| `quota` | 429/RESOURCE_EXHAUSTED or rate limit | retriable; router's next fallback candidate; repeats ≥2 in 30min opens the circuit breaker for that pair |
| `canceled` | agy silently auto-denied a permission prompt (`status:CANCELED`, empty response, exit 0) | retriable once; if it repeats, the task needs a mode/tool the CLI won't grant headless |
| `billing` | opencode provider returned 402/insufficient balance (e.g. DeepSeek) | not retriable on that model; a single occurrence opens the circuit breaker immediately (no threshold wait) — re-route to a free model |
| `model_unavailable` | copilot rejected an explicit `--model` id | not retriable on that id; re-route to `auto` |
| `timeout` | agy's own `--print-timeout` fired (turn abandoned, not just slow) or the hub's hard kill hit (opencode SIGKILLed after ignoring SIGTERM) | the turn is genuinely abandoned — verified live, resuming and asking for the answer returned `UNFINISHED`, not the real answer. `job_result` still returns whatever partial text streamed before the cutoff. Retry via `job_reply({jobId, message:'<retry or narrower ask>'})` on the same `sessionId` rather than re-`delegate`ing cold; latency is highly variable (4s-300s+ measured) |
| `empty` | opencode's JSON stream dropped `text`/`step_finish` (documented, nondeterministic), or agy returned `status:SUCCESS` with an empty response and no streamed text at all | retriable once, same job_reply-on-sessionId pattern as `timeout` |
| `crash` | no valid result envelope / unexpected exit | not retriable without changing the task |
| `read_mode_violation` | a `read`-mode job's git-visible worktree changed during the turn (verified: agy `--mode plan` writes) | the turn edited files despite read mode; inspect/reset the disposable worktree, then re-run the read turn somewhere it cannot touch anything you care about |
| `orphaned` | job's process was gone when the hub restarted | dead; re-delegate |
| `auth` | CLI not authenticated | not retriable; needs a human to log in |
| `not_terminal` | `job_reply` called on a job that has not finished yet | wait for the parent job to reach a terminal status first |
| `no_session` | `job_reply` called on a job with no recorded `sessionId` | that job never produced a resumable conversation; re-`delegate` instead |
| `unsupported` | `job_reply` called on a copilot job | copilot has no session resume; nothing was spawned — re-`delegate` a fresh job instead |

When every candidate in a chain is `unavailable`/breaker-open, `route` returns `primary:null`
— fall back to a Claude subagent (Agent tool) or do the work yourself.

## Deferred-issues ledger

A delegate reviewing or implementing one thing will often surface something real but out of
scope (a pre-existing bug, a legacy quirk deliberately being preserved, a decision that needs a
human/product call). Don't let that block the current task and don't lose it either — keep one
running Markdown table for the whole effort (one row per finding: id, which task/delegate found
it, the problem, file:line evidence, a proposed fix) and file each row as a real issue once the
work merges. This is what kept dozens of delegated tasks in one migration from either stalling on
tangents or quietly losing real findings. See the `issue-creation` skill for turning a ledger row
into an actual issue.

## Self-improvement loop

The hub learns from its own runs, but every mutation is human-gated:

- **Record a gotcha.** When you hit something non-obvious about an agent/model/taskType (a model
  hangs, a mode writes anyway, a flag is unreliable), call
  `learning_propose({text, agent?, model?, taskType?, sourceJobId?})`. It is stored `pending`; a
  human approves it at `#/approvals?tab=learnings`, after which it is prepended (max 3, 300
  chars each, sanitized) to matching root turns.
- **Review routing evidence.** `#/approvals?tab=proposals` lists chain-reorder proposals the hub
  computed from job metrics — an alternative whose 95% Wilson lower bound beats the current
  primary's upper bound, once both have 10+ samples. Accepting one is the only way it applies;
  `route` then reports it as `appliedProposal`. Check `#/metrics` (or `agents_metrics`) first.
- **Timeouts tune themselves.** Adaptive timeouts raise from observed p95 (x1.5, capped at
  3600s) once a pair has 10 samples; `#/metrics` is where to see why a timeout moved.

## No-MCP fallback

If `agent-hub` is not registered in this session (no `agents_status`/`route`/`delegate` tools
available):
- For `agy` specifically: `~/.claude/skills/agy-delegate/scripts/agy-run.sh --task "<question>"
  [--model low|medium|high|pro|sonnet|opus|oss]` — see `~/.claude/skills/agy-delegate/SKILL.md`.
- To check what's actually reachable without the MCP: `agent-hub preflight [--agent X] [--model
  Y] [--ping]` (CLI, same ladder as `agents_status`, `--ping` adds a real L3 PONG check) or
  `agent-hub selftest`.

## Dashboard

`agent-hub-dashboard` (systemd `--user` unit) serves `http://127.0.0.1:7777` as a sidebar app
with deep links — hand the user the exact view instead of describing it: `#/overview` (what
needs attention), `#/agents?filter=all|unhealthy|held|breaker&q=` (grouped by CLI; row menu
**Revalidate**, **Ping (L3)**, **Hold**/**Release**, **Reset breaker**; header **Revalidate all** /
**Rediscover CLIs**), `#/jobs` (running, with Cancel), `#/history?status=&agent=&q=` (status
`failed|succeeded|canceled`, errorKind, reply chains, error detail), `#/metrics?taskType=`
(success-rate chart, per-pair table), `#/subagents`, `#/timeline?source=&q=`,
`#/approvals?tab=proposals|learnings` (accept/reject proposals and learnings) and
`#/config?section=delegation|process|breaker|overrides|paths`. Ping, Reset breaker, Cancel and
proposal/learning decisions ask for confirmation. HTTP surface: `GET /api/config`, `GET
/api/metrics`, `GET /api/proposals`, `POST /api/proposals/refresh`, `POST
/api/proposals/:id/accept|reject`, `GET|POST /api/learnings`, `POST
/api/learnings/:id/approve|reject`, `DELETE /api/learnings/:id`, `GET /api/jobs/:id/result`,
`POST /api/agents/refresh {agent?,model?,ping?}`, `POST /api/discovery/refresh`, `POST
/api/overrides`, `DELETE /api/overrides/:agent/:model`.

`overrides.json` (`{ "agent:model": {hold?, breakerReset?, reason?, setAt} }`, under
`AGENT_HUB_HOME`) is how a human holds a pair or resets its breaker via the dashboard's
Hold/Release/Reset breaker buttons — agents must never edit this file themselves, only through
those actions or the HTTP endpoints above.

Point the user to the dashboard to revalidate a pair, hold/release it, or reset its breaker,
rather than re-running a long preflight in chat; `agents_status({refresh:true})` is the
in-session equivalent when the user isn't looking at the dashboard. Point them there too instead
of re-describing job state in chat when they ask "what's running" or "what failed."

## Security

Never put secrets, `.env` contents, credentials, or tokens in a `task`, in `cwd` contents
passed to a read-mode delegate, or in a write-mode diff review. All three external CLIs run
outside Claude Code's sandboxing.

## References

- Per-agent invocation, models, health signals, measured numbers, gotchas:
  `references/agents/agy.md`, `references/agents/opencode.md`,
  `references/agents/copilot.md`, `references/agents/claude-subagents.md`.
- MCP server source of truth lives in this same repo, relative to this skill:
  `../../README.md`, `../../src/router.mjs`, `../../src/config.mjs`, `../../src/discovery.mjs`,
  `../../src/dashboard.mjs`. A default install puts the repo at
  `~/.claude/mcp-servers/agent-hub/`.

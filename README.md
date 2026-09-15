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

- Node.js >= 20.6.0
- At least one of `agy`, `opencode`, or `copilot` on `PATH`, already
  authenticated with that CLI's own login flow. agent-hub does not manage
  credentials — it only spawns the CLI you already use.

## Layout

```
src/
  index.mjs          MCP bootstrap (stdio) + --selftest/--version
  config.mjs         paths, TTLs, model registry, timeouts, circuit breaker config
  eventlog.mjs        appendEvent() (one atomic append per line) / readTail()
  fsutil.mjs           writeJsonAtomic() (tmp + rename) for state shared by two processes
  jobstore.mjs        runs/<jobId>/{prompt.txt,stdout.log,response.txt,result.json}
  process.mjs         spawn argv, SIGTERM->SIGKILL ladder, runCommand()
  jobrunner.mjs        ties process+jobstore+worktree+adapters into startJob/cancelJob
  preflight.mjs        L0-L3 ladder, TTL cache, circuit breaker
  preflight-cli.mjs    `agent-hub preflight` table printer
  discovery.mjs        CLI discovery (binPath/version/models), startup + on-demand
  overrides.mjs        manual per-pair hold / breaker-reset overrides
  startup.mjs          non-blocking startup discovery scheduler
  router.mjs           delegation map + availability filtering
  worktree.mjs         write-mode gate (secondary git worktree) + single-writer lock
  hook.mjs             SubagentStart/SubagentStop -> events
  dashboard.mjs/.html  node:http dashboard, SSE /events, /api/state, /api/config, job cancel
  adapters/{base,agy,opencode,copilot,index}.mjs
  tools/{agents,jobs}.mjs
bin/agent-hub          dispatch: mcp | hook | dashboard | preflight | selftest
skills/                multi-agent-orchestrator and agy-delegate skills (see Install)
test/                  node --test; fixtures/ has real+synthetic CLI output;
                        live/ is real-CLI, gated by AGENT_HUB_LIVE=1
systemd/agent-hub-dashboard.service   NOT installed — copy it yourself if wanted
```

Runtime state (never committed) lives in `AGENT_HUB_HOME`, default
`~/.local/share/agent-hub/`: `events.jsonl`, `preflight-cache.json`,
`discovery.json`, `overrides.json`, `runs/<jobId>/`, `runs/.locks/`.

## Install

```bash
git clone https://github.com/jalejandrov93/agent-hub.git ~/.claude/mcp-servers/agent-hub
cd ~/.claude/mcp-servers/agent-hub
npm install
npm test
node bin/agent-hub selftest
```

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
| `triage` | opencode muse-spark-1.3 | copilot auto | lowest latency |
| `second-opinion` | agy gemini-3.1-pro-high | copilot auto | different model lineage than Claude Code |
| `adversarial-review` | agy claude-sonnet-4-6 (parallel with copilot auto) | agy claude-opus-4-6-thinking | dual blind review off the Claude Code quota |
| `github-context` | copilot auto | — | built-in GitHub MCP; cheap models keep premium quota |
| `mechanical-edit` | opencode deepseek-v4-flash (write) | copilot auto (write) | cheap write-capable; single writer |
| `implementation-with-repo-rules` | claude sonnet | — | only Claude Code loads CLAUDE.md + skills + hooks |
| `architecture` | claude opus | agy claude-opus-4-6-thinking | highest reasoning |
| `structured-mechanical` | claude haiku | — | cheapest Claude tier |

A `{agent: 'claude', model: 'haiku'|'sonnet'|'opus'}` candidate is a Claude
Code subagent tier, run by the caller through its own Agent tool — it is
never CLI-preflighted or breaker-checked. A candidate is filtered out of the
chain (and reported in the result's `skipped` list, with a reason) when it
is manually held, its CLI was not found on `PATH`, its cached preflight is
`unavailable`, or its circuit breaker is open. `route()` is advisory: it
never blocks the caller from delegating to a skipped pair directly.

### Circuit breaker

A per-agent+model breaker opens after `failureThreshold` (2) matching
failures (`quota`, `canceled`, `billing`) within a 30-minute window, or
immediately on a single `billing` failure (a billing failure such as an
insufficient-balance error does not clear on retry). A manual
`breakerReset` override (dashboard "Reset breaker" button, or `POST
/api/overrides`) makes earlier failures at or before that instant stop
counting.

### Write-mode gate

A `delegate()`/`job_reply()` call with `mode: 'write'` requires `cwd` to be
a secondary `git worktree add` checkout (see `src/worktree.mjs`), plus a
per-cwd single-writer lock — this keeps an agent CLI from editing the same
working tree Claude Code (or another job) is using, and keeps two write jobs
from racing on the same worktree.

## MCP tools

| Tool | Input | Notes |
|---|---|---|
| `agents_status` | `{refresh?: boolean}` | L0-L2 for every pair in the delegation map. Never pings. Rows include `binPath`/`cliVersion` from `discovery.json`. |
| `route` | `{taskType: enum, mode?: 'read'\|'write', includeCatalog?: boolean}` | Skips unavailable/breaker-open/held pairs; returns `{primary, fallbacks, skipped, discovery, reason}`. `discovery` holds `{binPath, version, modelCount, checkedAt, error}` per CLI; `includeCatalog: true` returns the full model catalog instead. |
| `delegate` | `{agent, model, task, cwd, mode?, timeoutS?, title?, variant?}` | Returns `{jobId, status:'queued'}` immediately. `variant` is opencode's reasoning effort (minimal/low/medium/high/max); ignored by agy/copilot. |
| `job_wait` | `{jobId, timeoutS?<=60}` | Polls until terminal or timeout. |
| `job_status` | `{jobId}` | Current status, no waiting. |
| `job_result` | `{jobId, maxLines?}` | Head of the response + `fullPath`, `truncated`. |
| `job_cancel` | `{jobId}` | Kills the whole process group; marks `canceled`. |
| `job_reply` | `{jobId, message, mode?, timeoutS?, title?}` | Starts a new turn in a **terminal** agy/opencode job's conversation, using its recorded `sessionId`. `mode` defaults to the parent job's mode; switching to `write` goes through the same worktree gate + lock as `delegate`. copilot has no session resume and returns `{status:'failed', errorKind:'unsupported'}` without spawning anything. A non-terminal parent gets `errorKind:'not_terminal'`; a parent with no `sessionId` gets `errorKind:'no_session'`. |

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
| Monitor | `#/agents` | Agents grouped by CLI; `?filter=unhealthy\|held\|breaker`, search, row menu, detail panel |
| Monitor | `#/jobs` | Running and queued jobs with live elapsed time and Cancel |
| Monitor | `#/history` | Terminal jobs; `?status=failed\|canceled\|succeeded`, agent filter, error detail, reply chains |
| Activity | `#/subagents` | Claude Code subagent runs recorded by the hooks |
| Activity | `#/timeline` | Last 200 events over SSE, filtered by source and kind |
| System | `#/config` | Delegation map, process PATH and CLIs, breaker and TTL, overrides, paths; `?section=` selects a tab |

Sidebar badges show unhealthy agents, running jobs, failures in the last 24h,
unseen timeline events and unresolved CLIs. Agent row actions are Revalidate,
Ping (an L3 round-trip for that one agent+model), Hold / Release and Reset
breaker; the Agents header adds Revalidate all and Rediscover CLIs. Ping,
Reset breaker and Cancel job ask for confirmation first. The theme follows the
system by default and can be set to light or dark. `preflight` events
(`phase: discovery|agent|ping`) stream over the same SSE feed as job events.

The UI is plain ES modules under `src/dashboard/` (no build step):
`index.html`, `styles.css`, `app.js`, `router.js`, `store.js`, `api.js`,
`contracts.js` (the shared typedefs and module signatures), `ui/*.js` and one
module per view in `views/`.

| Route | Method | Body | Notes |
|---|---|---|---|
| `/` and dashboard assets | GET | — | App shell and its CSS/JS modules, served from an exact-match allowlist with `Content-Security-Policy: default-src 'self'` |
| `/api/state` | GET | — | `{agents, jobs, subagents, events}` |
| `/api/config` | GET | — | `{delegationMap, discovery, timeouts, breaker, ttlMs, agentHubHome, writeAllowlist, breakerState, overrides}` |
| `/events` | GET | — | SSE stream of `events.jsonl` |
| `/api/jobs/:id/cancel` | POST | — | Cancels a running job |
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
- Pages and assets send a Content-Security-Policy that allows only same-origin
  scripts, styles and connections, with no inline script or style, plus
  `X-Content-Type-Options: nosniff`.

There is no authentication: any local process can call the API. Do not
expose the port beyond loopback (no reverse proxy, no port-forward to a
shared network).

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
npm test                       # fast, hermetic, no real CLI calls
AGENT_HUB_LIVE=1 npm run test:live   # one real PONG per adapter — uses real quota
```

See `test/fixtures/README.md` for exactly which adapter fixtures are real CLI
output versus hand-built synthetic shapes, and why.

## Versioning

This project follows [Semantic Versioning](https://semver.org/) and
[Conventional Commits](https://www.conventionalcommits.org/). See
[CHANGELOG.md](./CHANGELOG.md) for release history.

## License

[Apache-2.0](./LICENSE)

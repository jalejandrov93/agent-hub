# agent-hub

A local MCP server that lets Claude Code delegate bounded tasks to other agent
CLIs — Antigravity (`agy`), `opencode`, GitHub `copilot` — with real preflight
checks, an append-only event log, and a local dashboard that also shows
Claude Code's own subagents.

## Layout

```
src/
  index.mjs          MCP bootstrap (stdio) + --selftest/--version
  config.mjs         paths, TTLs, model registry, timeouts, circuit breaker config
  eventlog.mjs        appendEvent() (one atomic append per line) / readTail()
  jobstore.mjs        runs/<jobId>/{prompt.txt,stdout.log,response.txt,result.json}
  process.mjs         spawn argv, SIGTERM->SIGKILL ladder, runCommand()
  jobrunner.mjs        ties process+jobstore+worktree+adapters into startJob/cancelJob
  preflight.mjs        L0-L3 ladder, TTL cache, circuit breaker
  preflight-cli.mjs    `agent-hub preflight` table printer
  router.mjs           delegation map + availability filtering
  worktree.mjs         write-mode gate (secondary git worktree) + single-writer lock
  hook.mjs             SubagentStart/SubagentStop -> events
  dashboard.mjs/.html  node:http dashboard, SSE /events, /api/state, job cancel
  adapters/{base,agy,opencode,copilot,index}.mjs
  tools/{agents,jobs}.mjs
bin/agent-hub          dispatch: mcp | hook | dashboard | preflight | selftest
test/                  node --test; fixtures/ has real+synthetic CLI output;
                        live/ is real-CLI, gated by AGENT_HUB_LIVE=1
systemd/agent-hub-dashboard.service   NOT installed — copy it yourself if wanted
```

Runtime state (never committed) lives in `AGENT_HUB_HOME`, default
`~/.local/share/agent-hub/`: `events.jsonl`, `preflight-cache.json`,
`runs/<jobId>/`, `runs/.locks/`.

## Install

```bash
cd ~/.claude/mcp-servers/agent-hub
npm install
npm test
node bin/agent-hub selftest
```

## MCP tools

| Tool | Input | Notes |
|---|---|---|
| `agents_status` | `{refresh?: boolean}` | L0-L2 for every pair in the delegation map. Never pings. |
| `route` | `{taskType: enum, mode?: 'read'\|'write'}` | Skips unavailable/breaker-open pairs. |
| `delegate` | `{agent, model, task, cwd, mode?, timeoutS?, title?, variant?}` | Returns `{jobId, status:'queued'}` immediately. `variant` is opencode's reasoning effort (minimal/low/medium/high/max); ignored by agy/copilot. |
| `job_wait` | `{jobId, timeoutS?<=60}` | Polls until terminal or timeout. |
| `job_status` | `{jobId}` | Current status, no waiting. |
| `job_result` | `{jobId, maxLines?}` | Head of the response + `fullPath`, `truncated`. |
| `job_cancel` | `{jobId}` | Kills the whole process group; marks `canceled`. |
| `job_reply` | `{jobId, message, mode?, timeoutS?, title?}` | Starts a new turn in a **terminal** agy/opencode job's conversation, using its recorded `sessionId`. `mode` defaults to the parent job's mode; switching to `write` goes through the same worktree gate + lock as `delegate`. copilot has no session resume and returns `{status:'failed', errorKind:'unsupported'}` without spawning anything. A non-terminal parent gets `errorKind:'not_terminal'`; a parent with no `sessionId` gets `errorKind:'no_session'`. |

## Registering the MCP server (not done by this build — run it yourself)

Use an absolute `node` path, not a bare `node` / `#!/usr/bin/env node`: this
machine's `node` comes from an ephemeral fnm multishell dir
(`~/.local/state/fnm_multishells/<pid>-<ts>/bin`) that only exists inside a
shell that ran `fnm use` / `eval "$(fnm env)"`. Claude Code's own process
environment may not have that on PATH either, so pin to fnm's stable,
version-pinned alias symlink:

```bash
claude mcp add --scope user agent-hub -- ~/.local/share/fnm/aliases/default/bin/node ~/.claude/mcp-servers/agent-hub/bin/agent-hub mcp
```

## Claude Code hooks (not wired by this build — add via the update-config skill)

`SubagentStart` and `SubagentStop` should both run, with the same absolute
node path as above:

```bash
~/.local/share/fnm/aliases/default/bin/node ~/.claude/mcp-servers/agent-hub/bin/agent-hub hook
```

The hook reads the event JSON from stdin, enriches `SubagentStop` with the
model/description from the agent's `meta.json` and summed token usage from
its own transcript, and always exits 0.

## Dashboard

```bash
node bin/agent-hub dashboard --port 7777
# open http://127.0.0.1:7777
```

Binds to 127.0.0.1 only. `systemd/agent-hub-dashboard.service` is provided as
a file for anyone who wants to run it as a systemd --user unit; it is not
installed automatically. Its `ExecStart` uses the same absolute
`~/.local/share/fnm/aliases/default/bin/node` path for the same reason —
systemd --user units do not inherit the fnm multishell PATH.

## Testing

```bash
npm test                       # fast, hermetic, no real CLI calls
AGENT_HUB_LIVE=1 npm run test:live   # one real PONG per adapter — uses real quota
```

See `test/fixtures/README.md` for exactly which adapter fixtures are real CLI
output versus hand-built synthetic shapes, and why.

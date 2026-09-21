# Getting started

## Installation

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


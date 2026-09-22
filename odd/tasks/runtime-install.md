# Feature: runtime-install

Branch: `feat/runtime-install-guard`
Engram mirror: `odd/runtime-install/tasks` (project `agent-hub`)

## Objective

Every client (Claude Code, agy, opencode, codex) and the dashboard run one
installed runtime copy of agent-hub built from `main`, never the development
checkout, so work in progress can never affect the live hub.

## Problem / why

- Claude Code, both agy MCP configs, opencode and the manually launched
  dashboard run `bin/agent-hub` straight from the development checkout. Any
  branch switch or in-progress edit there changes the code the live hub loads.
- codex runs a separate, stale copy (`~/.codex/mcp-servers/agent-hub`,
  commit `bbc7390`, 2026-09-18) without the fixes merged since.
- The repo already ships the right mechanism (`scripts/install-local.mjs` ->
  `~/.claude/mcp-servers/agent-hub`, systemd unit pointing there), but it was
  never installed. It also copies whatever branch/dirty state the checkout has.

## Scope

- E1 (repo): `install-local.mjs` refuses to install unless the checkout is on
  `main` with a clean tracked tree (explicit `--allow-branch` override for
  deliberate testing); `INSTALL.json` records branch and dirty flag. Tests for
  the guard. Docs (`docs/architecture.md`/README install section): the runtime
  copy is the only thing clients should point at; how to update it.
- E2 (machine, outside the repo): install from `main`; point Claude Code
  (`~/.claude.json`), agy (`~/.gemini/antigravity-cli/mcp_config.json`,
  `~/.gemini/config/mcp_config.json`), opencode (`~/.config/opencode/
  opencode.json`) and codex (`~/.codex/config.toml`) at the installed copy,
  with a timestamped backup of every edited config; run the dashboard from
  the installed copy as a systemd --user service (local unit uses the nvm
  node path; this machine has no fnm).

## Constraints

- Nothing under `AGENT_HUB_HOME` (`~/.local/share/agent-hub`) is touched.
- Config edits are minimal (only the agent-hub path) and backed up first.
- Running jobs are never killed: switch the dashboard only after checking
  `/api/state`; MCP processes move over when each client reconnects.
- The stale codex copy is left on disk until codex is verified on the new
  path, then reported (not deleted without asking).
- Strict TDD for E1: RED before implementation.

## TDD

- Mode: enabled (source: session configuration). Runner: `npm test`.

## Tasks

- [x] E1 — installer guard (main + clean) + INSTALL.json fields + tests + docs.
  Evidence: RED `ERR_MODULE_NOT_FOUND scripts/install-guard.mjs`; GREEN
  `test/install-guard.test.mjs` 6/6; live probe on this feature branch exits 1
  with "refusing to install"; full `npm test` 1526/1526.
  Route: inline (1 script + 1 test + docs).
- [x] E2 — install, repoint 5 client configs (with backups), systemd dashboard.
  Evidence: installed from main `ce8dbd6` (INSTALL.json branch=main,
  dirty=false). Repointed `~/.claude.json`, both agy `mcp_config.json`,
  opencode and codex to `~/.claude/mcp-servers/agent-hub/bin/agent-hub`
  (backups `*.bak-20260922-160845`; JSON/TOML validated; no stale refs).
  systemd --user is unavailable in this WSL ("Failed to connect to bus"):
  the unit and `~/.config/agent-hub/env` are installed but inactive; the
  dashboard runs from the installed copy via nohup (HTTP 200). Enabling
  systemd in WSL (`/etc/wsl.conf` `[boot] systemd=true`) would make it
  start on boot. The stale codex copy (`~/.codex/mcp-servers/agent-hub`)
  is left on disk, no longer referenced.
  Route: inline (machine configuration, no repo code).

## Acceptance criteria

- `node scripts/install-local.mjs` on a feature branch or dirty tree exits
  non-zero with a clear message; on clean `main` it installs.
- `~/.claude/mcp-servers/agent-hub/INSTALL.json` shows the `main` commit.
- No client config references `DesarrollosLTSM/agent-hub/bin` or the codex copy.
- `systemctl --user is-active agent-hub-dashboard` is active and serves :7777.

## Progress / next step

- Next: none. Clients load the new path on their next reconnect/restart.

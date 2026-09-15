# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [1.1.0] - 2026-09-14

### Added

- Startup CLI discovery (`scheduleStartupDiscovery`, `src/startup.mjs`): runs
  L0 (`--version`) + L1 (model listing) for every CLI in the delegation map
  in the background via `setImmediate`, so it never blocks the MCP stdio
  handshake, and never runs an L3 ping. Writes `discovery.json`
  (`{ [agent]: {agent, cmd, binPath, version, models, checkedAt, error,
  note?} }`), TTL-gated by the existing 15-minute preflight TTL. Prunes
  `preflight-cache.json` rows for agent:model pairs no longer present in the
  delegation map. Opt-out via `AGENT_HUB_DISABLE_STARTUP_DISCOVERY=1`.
- Manual per-pair overrides (`overrides.json`, `src/overrides.mjs`): a
  `hold` flag makes the router skip a pair, and a `breakerReset` timestamp
  discounts circuit-breaker failures at or before that instant.
- `agents_status` rows and `route()` results gain `binPath`/`cliVersion`
  (from discovery); `route()` also returns `skipped` (each entry tagged
  `held`, `cli_not_found`, `cached_unavailable`, or `breaker_open`) and
  `discovery`.
- Dashboard: `GET /api/config` (delegation map, discovery, timeouts, breaker
  settings, overrides), `POST /api/agents/refresh` (bulk L0-L2, or `ping:true`
  for a single L3 round-trip), `POST /api/discovery/refresh`, `POST
  /api/overrides`, `DELETE /api/overrides/:agent/:model`. New UI: per-row
  Revalidate / Ping / Hold / Release / Reset breaker, header Revalidate
  all / Rediscover CLIs, and a Config panel. New `preflight` event kind
  (`phase: discovery|agent|ping`) streamed over the existing SSE feed.
- `multi-agent-orchestrator` and `agy-delegate` skills, shipped in `skills/`
  for symlinking into a Claude Code skills directory.

### Changed

- Atomic JSON writes (tmp + rename, `src/fsutil.mjs`) for every state file
  written by both the MCP process and the dashboard process.
- Discovery fetches an agent's model list once per agent instead of once per
  agent+model pair; agents are probed in parallel, pairs within one agent
  serially.

### Removed

- Unused `CONCURRENCY_CAP_PER_AGENT` config constant (never enforced).

### Fixed

- The dashboard never writes preflight or discovery state for a CLI it cannot
  resolve on its own `PATH`. Revalidate, ping and rediscover return a
  `skipped` result with reason `cli_not_found_in_dashboard_process` instead
  of recording the agent as unavailable for the MCP server. The Agents panel
  warns about unresolved CLIs and disables their buttons, and the Config
  panel shows the dashboard process `PATH` and resolved binaries.
- The dashboard prunes cache rows for pairs removed from the delegation map
  when it starts, not only when the MCP server starts.
- Cancelling an unknown job from the dashboard returns 404 instead of 500.
- Dashboard rejects cross-site and DNS-rebinding requests. A loopback check
  alone let any web page open in the user's browser trigger writes, because
  the browser itself connects from loopback. Every request now needs a
  loopback `Host` header (403 otherwise). Every non-GET request also needs
  `Content-Type: application/json` (415), a same-origin `Origin` when one is
  sent (403), a body of at most 64 KiB (413) and valid JSON (400).
- The systemd `--user` dashboard unit now loads `PATH` from the optional
  `~/.config/agent-hub/env` file. With systemd's minimal default `PATH` the
  dashboard could not find `agy`, `opencode` or `copilot`, so a Revalidate
  click recorded ready agents as unavailable in the shared preflight cache.
- Sanitized test fixtures (home paths and private repository names replaced
  with placeholders).

## [1.0.0] - 2026-09-14

### Added

- MCP server over stdio with `agents_status`, `route`, `delegate`, `job_status`,
  `job_wait`, `job_result`, `job_reply` and `job_cancel` tools.
- Adapters for `agy` (Antigravity), `opencode` and GitHub `copilot` CLIs.
- L0-L3 preflight ladder with a 15-minute on-disk cache and a per-pair circuit breaker.
- Task-type delegation map with ordered fallback chains.
- Write-mode gate: secondary git worktree required, per-cwd write lock.
- Append-only event log, per-job run directory, orphan reconciliation on startup.
- Local dashboard on `127.0.0.1:7777` with SSE timeline and job cancel.
- `SubagentStart`/`SubagentStop` hook recorder for Claude Code subagents.

[Unreleased]: https://github.com/jalejandrov93/agent-hub/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/jalejandrov93/agent-hub/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/jalejandrov93/agent-hub/releases/tag/v1.0.0

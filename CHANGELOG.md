# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

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

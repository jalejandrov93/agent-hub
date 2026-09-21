# Comparison with ai-dispatch

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


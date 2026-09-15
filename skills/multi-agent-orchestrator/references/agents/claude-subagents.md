# Claude subagents — reference

## Not a `delegate()` target

`route()` results can name `{agent:'claude', model:'haiku'|'sonnet'|'opus'}`. That tier is
**run by the caller via the Agent tool**, never passed to `delegate` — `agent-hub`'s `delegate`
tool only accepts `agent: 'agy'|'opencode'|'copilot'`. Claude subagents are never CLI-preflighted
and never appear in `agents_status`'s per-pair health list; `route`'s `isUsable` check treats a
`claude` candidate as always usable.

## How the hub observes them anyway

`SubagentStart` and `SubagentStop` hooks are wired to `agent-hub hook` (reads hook JSON on
stdin, always exits 0 so a hook failure never blocks the agent). The model isn't in the hook
payload itself — on `SubagentStop` the hook reads `subagents/agent-<id>.meta.json` (retried 3x
/ 200ms, since it can lag) for `model`, `agentType`, `description`, `toolUseId`, and sums
`message.usage` from that subagent's own transcript for token counts. This is what populates
the dashboard's "Claude subagents" panel and the `subagent.start`/`subagent.stop` events in the
timeline — it is observability only, not a routing mechanism.

## When to route here vs. an external CLI

- `implementation-with-repo-rules` → always Claude `sonnet`: only Claude Code loads this
  repo's `CLAUDE.md`, skills, and hooks — whatever project-specific rules those encode (build
  conventions, migration bans, generated-file sync, TDD). An external CLI editing this repo does
  not know these rules exist.
- `architecture` → Claude `opus` primary, agy `claude-opus-4-6-thinking` fallback (same model
  family, hosted externally, zero Claude-quota cost as a second pass).
- `structured-mechanical` → Claude `haiku`, cheapest tier, for repo-aware but low-reasoning
  work that still needs CLAUDE.md context.
- Fall back to a Claude subagent (via Agent tool) whenever `route()` returns `primary:null`
  for a task type — every external candidate was unavailable or breaker-open.

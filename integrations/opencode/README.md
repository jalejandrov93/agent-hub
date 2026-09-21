# OpenCode Subagent Monitor for agent-hub

An optional plugin for [OpenCode](https://opencode.ai) that reports child sessions (subagents) to [agent-hub](https://github.com/jalejandrov93/agent-hub)'s event log.

This gives the agent-hub dashboard the same visibility into OpenCode subagent lifecycles as it has for Claude Code subagents.

> [!NOTE]
> This integration is **optional** and provides dashboard parity only. agent-hub functions completely without it; install it only if you want OpenCode's subagent activity reflected in the agent-hub dashboard timeline.

## How it works

OpenCode sessions that have a non-null `parentID` represent child sessions (subagents). When such a session is created or transitions to idle/deleted, the monitor plugin formats and appends an event line into `events.jsonl`:

- `session.created` with `parentID` &rarr; appends `subagent.start`
- `session.idle` or `session.deleted` for that child &rarr; appends `subagent.stop`
- Root sessions (user-interactive sessions without a `parentID`) are ignored and emit no events.

### Emitted event shape

Events match agent-hub's `HubEvent` schema:

```json
{
  "ts": "2026-09-20T22:00:00.000Z",
  "source": "opencode",
  "kind": "subagent.start",
  "agent": "explore",
  "model": "claude-sonnet-4-6",
  "title": "explore",
  "summary": null,
  "jobId": null,
  "cwd": "/path/to/project",
  "errorKind": null,
  "taskType": null,
  "tokens": null,
  "costUsd": null,
  "harness": "opencode",
  "waitMode": null,
  "sessionId": "ses_child123",
  "parentSessionId": "ses_root456"
}
```

## Installation

Symlink or copy `agent-hub-monitor.js` and `event-line.mjs` into your OpenCode plugins directory (`~/.config/opencode/plugins/`):

```bash
mkdir -p ~/.config/opencode/plugins

# Using symlinks (recommended so updates in agent-hub apply automatically):
ln -s /path/to/agent-hub/integrations/opencode/agent-hub-monitor.js ~/.config/opencode/plugins/agent-hub-monitor.js
ln -s /path/to/agent-hub/integrations/opencode/event-line.mjs ~/.config/opencode/plugins/event-line.mjs
```

Or copy them directly:

```bash
cp /path/to/agent-hub/integrations/opencode/agent-hub-monitor.js ~/.config/opencode/plugins/
cp /path/to/agent-hub/integrations/opencode/event-line.mjs ~/.config/opencode/plugins/
```

### Environment variables

- `AGENT_HUB_HOME`: Directory where agent-hub stores runtime state. Defaults to `~/.local/share/agent-hub/`. Events are appended to `$AGENT_HUB_HOME/events.jsonl`.

# agent-hub

> Local MCP orchestration layer for delegating bounded coding tasks across
> multiple AI coding agents.

![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)
![Node](https://img.shields.io/badge/node-%3E%3D20.19-brightgreen.svg)
![MCP](https://img.shields.io/badge/MCP-server-6f42c1.svg)
![Version](https://img.shields.io/badge/version-2.1.0-informational.svg)

Delegate specialized work from Claude Code, OpenCode, or any MCP client to the
coding agents you already have installed — without hand-managing processes,
fallbacks, retries, quotas, or execution state.

```
Claude Code / OpenCode / any MCP client
                  │
                  ▼
             agent-hub
                  │
      ┌───────────┼───────────┐
      ▼           ▼           ▼
     agy       OpenCode     Copilot        (…and Codex, Jules)
      │           │           │
      └───────────┼───────────┘
                  ▼
      execution · routing · recovery · workflows
                  │
                  ▼
              Dashboard
```

## What is agent-hub?

agent-hub is a **local MCP server and execution layer** for delegating bounded
tasks to multiple coding agents. It handles agent discovery, capability-aware
routing, execution, retries, recovery, workflows, verification and monitoring —
so the orchestrator states *what* it wants done, not *which CLI to drive*.

### Why?

Without agent-hub, the orchestrator owns every detail:

```
Claude Code
   ├── manually call agy
   ├── manually call OpenCode
   ├── manually retry failures
   ├── manually inspect results
   └── manually track state
```

With agent-hub, those become the layer's job:

```
Claude Code
      │
      ▼
 agent-hub
   ├── discover     which agents are installed and healthy
   ├── route        pick an agent+model for the task
   ├── execute      run it, stream and persist the result
   ├── retry        fall back on failure, quota or breaker
   ├── verify       artifacts, deterministic checks, judge
   ├── orchestrate  multi-step DAGs with dependencies
   └── monitor      event log, metrics, dashboard
```

## Key features

- **Multi-agent delegation** — agy (Antigravity), OpenCode, GitHub Copilot CLI,
  Codex CLI locally, and Google Jules in the cloud.
- **Capability-aware routing** — filters candidates by hard requirements and
  ranks them by quality, cost and latency preferences.
- **Reliable execution** — retries, automatic fallback chains, per-class circuit
  breakers and adaptive timeouts derived from observed p95.
- **Workflow orchestration** — DAG execution with `dependsOn`, parallel waves,
  fan-out/fan-in, retries and resume after a crash.
- **Evidence & verification** — artifacts, deterministic verification commands
  and a judge/revision loop that can send work back for another pass.
- **Safe write execution** — worktree isolation, single-writer coordination, and
  a read-mode guard that fails a job which touched the disk.
- **Persistent execution state** — SQLite as coordination state with a JSON
  fallback, cross-process dispatch idempotency and claim heartbeats.
- **Observability** — event log, metrics, subagent tracking and a local
  dashboard.
- **Harness integration** — caller-harness profiles (Claude Code, OpenCode,
  generic) that decide how long a delegation blocks, plus a lifecycle bridge
  back into the originating session.

## Architecture at a glance

```
                    ┌────────────────────┐
                    │   Claude Code      │
                    │   OpenCode         │
                    │   External agents  │
                    └─────────┬──────────┘
                              │ MCP
                              ▼
                    ┌────────────────────┐
                    │     agent-hub      │
                    ├────────────────────┤
                    │ Planner            │
                    │ Router             │
                    │ Dispatcher         │
                    │ Policy engine      │
                    │ Workflow engine    │
                    │ Verification       │
                    │ Storage            │
                    └─────────┬──────────┘
                              │
          ┌───────────────────┼──────────────────┐
          ▼                   ▼                  ▼
      Local CLIs           Cloud              State
      agy                  Jules              SQLite
      OpenCode                                Events
      Copilot                                 Artifacts
      Codex
```

→ **[Architecture](docs/architecture.md)** ·
**[Execution model](docs/execution.md)** ·
**[Storage](docs/storage.md)**

## Supported agents

| Agent | Local / Cloud | Typical use |
|---|---|---|
| Antigravity (`agy`) | Local | Delegated coding tasks, large-context recon |
| OpenCode | Local | Coding and research, free-tier models |
| GitHub Copilot CLI | Local | GitHub-aware tasks |
| Codex CLI | Local | Bounded fallback tasks |
| Google Jules | Cloud | Long-running remote tasks that end in a pull request |

Per-agent notes: **[agy](docs/providers/agy.md)** ·
**[OpenCode](docs/providers/opencode.md)** ·
**[Copilot](docs/providers/copilot.md)** ·
**[Jules](docs/providers/jules.md)**

## Quick start

**Requirements:** Node.js ≥ 20.19 and at least one supported agent CLI installed
and authenticated.

```bash
git clone https://github.com/jalejandrov93/agent-hub.git ~/.claude/mcp-servers/agent-hub
cd ~/.claude/mcp-servers/agent-hub

npm install
npm test
node bin/agent-hub selftest
```

Prefer to develop in place and install only the runtime elsewhere? Clone
anywhere, then:

```bash
npm install
npm run install:local -- --restart
```

`install:local` builds the dashboard, copies the runtime into
`~/.claude/mcp-servers/agent-hub`, installs production dependencies there and
records the exact commit. Re-run it after every `git pull`.

**Register the MCP server.** Use an absolute `node` path (a version-manager shim
only exists inside the shell that created it):

```bash
claude mcp add --scope user agent-hub -- \
  /path/to/node /path/to/agent-hub/bin/agent-hub mcp
```

→ Full instructions, hooks, the dashboard service and skill install:
**[Getting started](docs/getting-started.md)**

### First delegation

Ask your orchestrator for the outcome, not the mechanism:

> "Use agent-hub to investigate why the authentication flow is failing and
> return a concise diagnosis."

```
Claude Code → agent-hub → route() → available agent → execution → result
```

Useful tools to know: `route` (who can do this), `delegate` (run it now),
`dispatch` (run it with policy and idempotency), `job_wait`, `job_result`,
`recipes`/`workflow` for multi-step work. The complete surface is in
**[MCP tools](docs/reference/tools.md)**.

## Common use cases

| Use case | Ask for |
|---|---|
| **Codebase reconnaissance** | "Trace how authentication flows through the repository." |
| **Second opinion** | "Review this implementation and identify architectural risks." |
| **Large artifact analysis** | "Analyze these logs and identify recurring failures." |
| **Mechanical work** | "Update these 40 files according to the migration pattern." |
| **Multi-step workflow** | Research → Implementation → Verification → Review |

## Workflows

Workflows are DAGs: steps declare `dependsOn`, independent steps run in parallel
waves, `fanout` expands over items and `fanin` aggregates the children. A run is
persisted, so it can resume after a crash and never re-executes a succeeded node.

```
      Research
      ├─────────────┐
      ▼             ▼
   Analysis       Security
      │             │
      └──────┬──────┘
             ▼
        Implementation
             │
             ▼
          Verify
             │
             ▼
          Review
```

→ **[Workflows](docs/workflows.md)** ·
**[Verification](docs/verification.md)** ·
**[execution contract](docs/execution-contract.md)**

## Dashboard

A local dashboard ships with the runtime:

```bash
node bin/agent-hub dashboard
# http://127.0.0.1:7777
```

It shows agent availability, running jobs, execution history, metrics,
subagents, the timeline, routing proposals, learnings and configuration.

→ **[Observability and dashboard](docs/dashboard.md)**

## Configuration

| Variable | Effect |
|---|---|
| `AGENT_HUB_HOME` | State directory (default `~/.local/share/agent-hub`). |
| `AGENT_HUB_STORE` | Job read path: `json` (default), `sqlite`, or `shadow` (read JSON, verify against SQLite, log divergences). |
| `AGENT_HUB_HARNESS` | Default caller harness: `generic`, `claude-code`, `opencode`. |
| `AGENT_HUB_LIVE` | `1` enables the opt-in live test and benchmark paths. |
| `AGENT_HUB_DISABLE_STARTUP_DISCOVERY` | `1` skips the background discovery pass at startup. |

→ **[Configuration reference](docs/reference/configuration.md)** ·
**[Quota (Quota-Arc / CodexBar)](docs/quota.md)**

## Security

agent-hub is designed for **local execution**. The dashboard binds to loopback
and is **not authenticated**: do not expose it through a reverse proxy, port
forwarding, or a shared network.

Delegated agents run outside Claude Code's sandbox, so never put secrets,
`.env` contents or credentials in a task string. Isolation profiles, credential
hygiene and the read-mode guard are documented separately.

→ **[Security and isolation](docs/security.md)**

## Documentation

**Getting started**
- [Installation and registration](docs/getting-started.md)
- [Configuration reference](docs/reference/configuration.md)
- [Dashboard](docs/dashboard.md)

**Concepts**
- [Architecture](docs/architecture.md)
- [Routing](docs/routing.md)
- [Execution model](docs/execution.md)
- [Workflows](docs/workflows.md)
- [Verification](docs/verification.md)
- [Context, handoffs and messaging](docs/handoffs.md)

**Providers**
- [agy (Antigravity)](docs/providers/agy.md)
- [OpenCode](docs/providers/opencode.md)
- [GitHub Copilot CLI](docs/providers/copilot.md)
- [Jules (cloud)](docs/providers/jules.md)

**Reference**
- [MCP tools](docs/reference/tools.md)
- [Environment variables](docs/reference/configuration.md)
- [Storage](docs/storage.md)
- [Quota (Quota-Arc / CodexBar)](docs/quota.md)
- [Execution contract](docs/execution-contract.md)

**Operations and history**
- [Security and isolation](docs/security.md)
- [Security isolation matrix](docs/security-isolation.md)
- [Post-D1 roadmap](docs/roadmap-post-d1.md)
- [Deep audit](docs/audit-post-d2.md)
- [Implementation report](docs/implementation-report-2026-09-21.md)
- [Comparison with ai-dispatch](docs/comparison.md)
- [Changelog](CHANGELOG.md) · [Versioning](docs/versioning.md)

## Development

```bash
npm test                              # unit + integration suite
npm run -w dashboard test             # dashboard
npm run -w dashboard run typecheck    # dashboard types
AGENT_HUB_LIVE=1 npm run test:live    # opt-in live tests
npm run bench                         # offline benchmark corpus
node bin/agent-hub selftest           # end-to-end self check
```

Node must be the version the runtime uses (the native SQLite binding is compiled
per ABI). If your shell resolves a different major version, pin it explicitly:

```bash
export PATH="$HOME/.local/share/fnm/aliases/default/bin:$PATH"
```

→ **[Testing and reliability](docs/development/testing.md)**

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[Apache-2.0](LICENSE)

# agy (Antigravity)

## Provider profiles and agys

To prevent quota exhaustion on single accounts, agent-hub supports multi-account
provider profiles (`src/providers/profiles.mjs`) and integrates with the `agys`
Go CLI (`src/providers/agys.mjs`):

- **Profile lifecycle states**: `selected` (active default), `fallback`
  (eligible alternate), `exhausted` (quota exhausted, errorClass `quota`, or
  bucket >= 100%), and `unavailable` (auth/billing failure).
- **Selection policies**: `priority`, `least_used`, and `round_robin`.
- **agys integration**: see the dedicated [agy multi-account (agys)](#agy-multi-account-agys)
  section below for one-time setup, mode precedence, dashboard controls, and safe
  degradation.

## agy multi-account (agys)

`agys` is a separate Go CLI (`~/.local/bin/agys`) that isolates multi-account
Antigravity (`agy`) profiles under `~/.agys/profiles/<name>/` by overriding `HOME`.
It allows routing jobs across multiple Google accounts so a single account's
quota exhaustion never blocks task execution.

### One-time setup

Create and manage profiles directly using the `agys` CLI:

```bash
agys add <name>                     # runs `agy login` under ~/.agys/profiles/<name>/
agys list                           # lists profiles with active default, priority, email, path
agys list -q                        # quiet: lists profile names only
agys quota                          # human-readable quota usage across profiles
agys quota --json                   # JSON quota snapshot used by agent-hub
agys use <name>                     # sets the active default profile
agys priority set <name> <priority> # sets integer priority (higher = preferred in auto mode)
```

### Modes and precedence

Profile selection operates in one of three modes:
- `auto`: dynamically inspects `agys list` and `agys quota --json` to select the highest-priority non-exhausted profile.
- `profile`: pins execution to a specific named profile.
- `off`: disables agys wrapping entirely; runs standard `agy`.

Precedence is evaluated in strict order (highest to lowest):

1. **Environment pin** (`AGENT_HUB_AGYS_PROFILE=<name>`): unconditionally forces the named profile (`mode: 'profile'`).
2. **Environment mode** (`AGENT_HUB_AGYS='auto'` or `'off'`): forces `auto` or `off` at the process level.
3. **Persisted dashboard setting** (`agys-mode.json` under `AGENT_HUB_HOME`): written by the dashboard Providers view toggle (`{ mode, profile }`).
4. **Default**: `auto`.

### How to change the mode

- **Dashboard**: in the **Providers** view (`#/providers`), toggle between `off`, `profile`, and `auto`. When `mode: 'profile'`, select any configured profile from the dropdown. If an environment variable is set (`AGENT_HUB_AGYS` or `AGENT_HUB_AGYS_PROFILE`), the toggle is disabled with an explanatory note.
- **Client environment configuration**:
  - **Claude Code**: configure `mcpServers['agent-hub'].env` in `~/.claude.json`:
    ```json
    {
      "mcpServers": {
        "agent-hub": {
          "env": {
            "AGENT_HUB_AGYS": "auto",
            "AGENT_HUB_AGYS_PROFILE": "work"
          }
        }
      }
    }
    ```
  - **OpenCode**: configure `mcp['agent-hub'].environment` in `~/.config/opencode/opencode.json`:
    ```json
    {
      "mcp": {
        "agent-hub": {
          "environment": {
            "AGENT_HUB_AGYS": "auto"
          }
        }
      }
    }
    ```
    Or via CLI: `opencode mcp add --env AGENT_HUB_AGYS=auto`

### Safe degradation

When `agys` is not installed on `PATH` or an `agys` invocation fails (non-zero exit, timeout, missing binary), the profile resolver returns `{ profile: null, status: 'unavailable' }` and `agy` runs **UNCHANGED** as a plain `agy` process. Because of this graceful fallback, `auto` is completely safe as the default setting: environments without `agys` run standard Antigravity without interruption.

### How it works underneath

- **Transparent wrapping**: when a profile is selected, agent-hub wraps the CLI command as:
  `agys run <profile> -- <agy argv>`
- **Effort-suffix splitting**: `agys run` injects `--effort high` when `--effort` is omitted. Because agent-hub model IDs encode the effort tier in the model name (for example, `gemini-3.8-flash-low`), `agy` rejects conflicting flags (`--model gemini-3.8-flash-low conflicts with --effort=high`). The hub's `agyArgvForAgys` automatically splits suffixed model IDs: `--model gemini-3.8-flash-low` becomes `--model gemini-3.8-flash` plus `--effort low`. An explicit `--effort` is left untouched.

### Observing which account ran

- **Job records**: `profile` and `profileStatus` (`selected`, `fallback`, `exhausted`, `unavailable`) are set synchronously at creation in `startJob()`, making them visible immediately while running via `job_status` and `job_result` (and stored in the SQLite `jobs` table).
- **Job events**: `job.started`, `job.finished`, and `job.failed` events carry `profile` and `profileStatus`.
- **Dashboard**: Running Jobs (`#/jobs`) and History (`#/history`) display the `JobProfileBadge` with the profile name and status pill. The Providers view (`#/providers`) shows the active mode, source, selected profile, and live quota bucket gauges.
- **Process table**: `pgrep -af agys` shows the running wrapped command.

### Two-profile example

```bash
agys add personal
agys add work
agys priority set personal 10
agys priority set work 5
```

With mode `auto`, agent-hub routes jobs to `personal` (priority 10). If `personal` quota is exhausted (bucket >= 100% or errorClass `quota`), agent-hub automatically routes to `work` as a fallback. To force the work profile for a specific session, set `AGENT_HUB_AGYS_PROFILE=work`.


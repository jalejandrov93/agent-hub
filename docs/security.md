# Security and isolation

## Sandbox level matrix

When spawning local agent CLIs, agent-hub filters the process environment
according to the profile selected by `AGENT_HUB_SANDBOX_PROFILE` (default
`compatibility`):

| Profile | Host HOME | Environment | Temp & XDG Directories | Isolation Boundary |
|---|---|---|---|---|
| `compatibility` (default) | Inherited | Scrubbed (secret patterns redacted) | Standard host paths (`/tmp`, `~/.cache`, etc.) | None (standard process privileges & network) |
| `isolated-home` | Redirected to temp dir (`/tmp/agent-hub-sandbox-home-*`) | Scrubbed (secret patterns redacted) | Standard host paths (`/tmp`, host XDG) | None (standard process privileges & network) |
| `isolated` | Redirected to sandbox dir (`/tmp/agent-hub-isolated-*`) | Scrubbed; `AGENT_HUB_SANDBOX_DIR` exposed; opt-in copy via `AGENT_HUB_SANDBOX_INCLUDE` | Redirected into sandbox (`tmp/`, `.cache/`, `.config/`, `.local/share/`) | None (standard process privileges & network) |

**What sandbox levels do and do NOT protect:**
- **Secret scrubbing**: All profiles scrub environment variables matching
  `*_TOKEN`, `*_SECRET`, `*_API_KEY`, `AWS_*`, `GH_TOKEN`, `ANTHROPIC_*`,
  `OPENAI_*`, and `JULES_API_KEY`.
- **Credential inclusion (`AGENT_HUB_SANDBOX_INCLUDE`)**: In `isolated` mode,
  specified comma-separated paths are copied into the sandbox directory (relative
  paths preserve their relative layout; absolute paths copy to the sandbox root;
  missing paths are skipped).
- **No container security**: None of these profiles use OS containers, Linux
  namespaces, cgroups, chroot, or network policies. Child processes retain standard
  user privileges and unrestricted network access. `isolated` provides environment
  and path hygiene, not protection against untrusted or hostile code execution.


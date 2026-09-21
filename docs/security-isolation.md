# Security Isolation Matrix & Container Design

Comprehensive specification of agent-hub execution isolation levels, credential hygiene, read-purity guards, container sandbox architecture, and CLI compatibility verification.

---

## Quick Reference

| Level | Selected By | Filesystem Isolation | Env Scrubbing | Process & Network Boundary | Implemented? |
|---|---|---|---|---|---|
| `compatibility` (default) | `AGENT_HUB_SANDBOX_PROFILE=compatibility` (or unset) | None (inherits host `$HOME`) | Secret patterns unset | None (standard host process & network) | Yes (`src/sandbox.mjs:31`) |
| `isolated-home` | `AGENT_HUB_SANDBOX_PROFILE=isolated-home` | Fresh empty temp dir for `$HOME` | Secret patterns unset | None (standard host process & network) | Yes (`src/sandbox.mjs:32`) |
| `isolated` | `AGENT_HUB_SANDBOX_PROFILE=isolated` | Fresh sandbox dir for `$HOME`, `$TMPDIR`, and `$XDG_*` | Secret patterns unset; `AGENT_HUB_SANDBOX_DIR` exposed | None (**NOT a container**; unconfined process & network) | Yes (`src/sandbox.mjs:33`) |
| `container` | `AGENT_HUB_SANDBOX_PROFILE=container` (planned) | Pivot-root / mount namespace (bwrap), read-only system, workspace bind | Strict whitelist only; minimal tokens | Linux namespaces (PID, net, mount, user), cgroups v2, network policy | **No (Design Only)** (`docs/roadmap-post-d1.md:549`) |

> [!WARNING]
> **`isolated` is NOT a container.** (`src/sandbox.mjs:25-27`, `src/config.mjs:154-156`, `README.md:977-980`).
> Child processes in `isolated` profile run with standard host user privileges and unconfined network access. They can traverse any host filesystem path permitted by Unix DAC permissions (e.g., `~/.ssh`, `~/.aws`, `/etc/passwd`). It provides filesystem and path hygiene for CLI cache/config defaults, NOT security containment against untrusted or adversarial execution.

---

## 1. The Isolation Level Matrix

agent-hub controls child CLI execution environments during `startJob` (`src/jobrunner.mjs:291-320`) by resolving an active profile via `resolveSandboxProfile(env.AGENT_HUB_SANDBOX_PROFILE)` (`src/sandbox.mjs:139-142`, `src/config.mjs:158-165`).

### 1.1 Level Specifications

#### Level 1: `compatibility` (Default)
- **Selection Env Var**: `AGENT_HUB_SANDBOX_PROFILE=compatibility` (default when unset or invalid, `src/sandbox.mjs:141`, `src/config.mjs:159`).
- **Implementation**: `src/sandbox.mjs:31`, `{ inheritHome: true, redactEnv: true }`.
- **What it isolates**:
  - **Environment Variables**: Redacts/unsets secret environment variables matching `SECRET_PATTERNS` (`src/sandbox.mjs:40-49,64-69`).
- **What it explicitly does NOT isolate**:
  - **`HOME`**: Inherits real host `$HOME` (`src/sandbox.mjs:31,47`). A one-time process warning is emitted (`src/jobrunner.mjs:301-304`).
  - **`TMPDIR`**: Unset/inherited; uses standard host `/tmp` or OS temporary directory.
  - **`XDG_*` directories**: Inherited from host (`~/.config`, `~/.cache`, `~/.local/share`).
  - **Filesystem**: Child has full access to the host filesystem within user account privileges.
  - **Network**: Completely unrestricted host network access.
  - **Process capabilities**: Unconfined user process; shares host PID tree and resource budget.

#### Level 2: `isolated-home`
- **Selection Env Var**: `AGENT_HUB_SANDBOX_PROFILE=isolated-home` (`src/sandbox.mjs:139-142`).
- **Implementation**: `src/sandbox.mjs:32,103-106`, `{ inheritHome: false, redactEnv: true }`.
- **What it isolates**:
  - **Environment Variables**: Redacts/unsets secret environment variables matching `SECRET_PATTERNS` (`src/sandbox.mjs:64-69`).
  - **`HOME`**: Redirected to a freshly created empty temporary directory (`fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-sandbox-home-'))`, `src/sandbox.mjs:104-105`).
- **What it explicitly does NOT isolate**:
  - **`TMPDIR`**: Uses standard host temporary paths (`/tmp`).
  - **`XDG_*` directories**: Not redirected; inherits host environment or falls back to system defaults.
  - **Filesystem**: No mount boundaries; child can read/write any file on the host if addressed by absolute path.
  - **Network**: Completely unrestricted host network access.
  - **Process capabilities**: Standard unconfined process.

#### Level 3: `isolated`
- **Selection Env Var**: `AGENT_HUB_SANDBOX_PROFILE=isolated` (`src/sandbox.mjs:139-142`).
- **Implementation**: `src/sandbox.mjs:33,71-102`.
- **What it isolates**:
  - **Environment Variables**: Redacts/unsets secret environment variables matching `SECRET_PATTERNS` (`src/sandbox.mjs:64-69`).
  - **Sandbox Directory**: Creates a dedicated directory (`fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-isolated-'))`, `src/sandbox.mjs:72`) and exposes `AGENT_HUB_SANDBOX_DIR` (`src/sandbox.mjs:73`).
  - **`HOME`**: Set to `AGENT_HUB_SANDBOX_DIR` (`src/sandbox.mjs:74`).
  - **`TMPDIR`**: Set to `path.join(AGENT_HUB_SANDBOX_DIR, 'tmp')` (`src/sandbox.mjs:75,80`).
  - **`XDG_CACHE_HOME`**: Set to `path.join(AGENT_HUB_SANDBOX_DIR, '.cache')` (`src/sandbox.mjs:76,81`).
  - **`XDG_CONFIG_HOME`**: Set to `path.join(AGENT_HUB_SANDBOX_DIR, '.config')` (`src/sandbox.mjs:77,82`).
  - **`XDG_DATA_HOME`**: Set to `path.join(AGENT_HUB_SANDBOX_DIR, '.local', 'share')` (`src/sandbox.mjs:78,83`).
  - **Config/Credential Import**: Opt-in recursive file copying via `AGENT_HUB_SANDBOX_INCLUDE` (`src/sandbox.mjs:85-102`).
- **What it explicitly does NOT isolate**:
  - **NOT A CONTAINER**: Operates purely within the host kernel process space without namespaces (`src/sandbox.mjs:25-27`).
  - **Filesystem**: No chroot, mount namespace, or pivot_root. Any process can read `/etc/passwd`, `/home/<user>/.ssh`, `/home/<user>/.aws`, or arbitrary worktrees.
  - **Network**: Completely unrestricted host network access (sockets, DNS, localhost servers, LAN).
  - **Process capabilities**: Child processes retain host user privileges, can fork background processes, view `/proc`, and exhaust memory/CPU.

#### Level 4: `container` (Design Only — Not Implemented)
- **Selection Env Var**: `AGENT_HUB_SANDBOX_PROFILE=container` (planned; currently falls back to `compatibility`, `src/sandbox.mjs:141`).
- **Implementation Status**: **Design only** (`docs/roadmap-post-d1.md:549,568`).
- **What it isolates (Target Design)**:
  - **Environment Variables**: Strict allowlist only (`PATH`, `LANG`, `TERM`, `AGENT_HUB_*` runtime IDs); all other host environment variables omitted.
  - **`HOME` & `TMPDIR`**: Isolated ephemeral `tmpfs` mounts inside private mount namespace.
  - **Filesystem**: Unprivileged user and mount namespaces (`bwrap`), pivot_root, read-only system roots (`/usr`, `/bin`, `/lib`), strictly allowlisted bind mounts (workspace `cwd` + explicit CLI binaries/configs).
  - **Network**: Isolated network namespace (`--unshare-net` loopback-only default) or outbound HTTPS filtering proxy.
  - **Process capabilities**: Private PID namespace (`--unshare-pid`), seccomp syscall filtering, dropped capabilities, no-new-privs.
  - **Resource limits**: cgroups v2 memory (`memory.max`), CPU quota (`cpu.max`), and process limits (`pids.max`).
- **What it explicitly does NOT isolate**:
  - Shared host kernel vulnerabilities (kernel exploits bypass container boundaries).
  - Files or credentials explicitly bind-mounted into the container (if a CLI's token file is mounted, the agent process can read it).

### 1.2 Comparison Matrix

| Isolation Boundary | `compatibility` | `isolated-home` | `isolated` | `container` (Design) |
|---|---|---|---|---|
| **Secret Env Vars** | Unset (`src/sandbox.mjs:66`) | Unset (`src/sandbox.mjs:66`) | Unset (`src/sandbox.mjs:66`) | Whitelist only |
| **`HOME` Path** | Host `$HOME` (`src/sandbox.mjs:31`) | Fresh temp dir (`src/sandbox.mjs:104`) | Fresh sandbox dir (`src/sandbox.mjs:74`) | Ephemeral tmpfs in namespace |
| **`TMPDIR`** | Host `/tmp` | Host `/tmp` | `AGENT_HUB_SANDBOX_DIR/tmp` (`src/sandbox.mjs:75`) | Private tmpfs |
| **`XDG_*` Directories** | Host paths | Host paths | `AGENT_HUB_SANDBOX_DIR` subdirs (`src/sandbox.mjs:76-78`) | Private tmpfs subdirs |
| **Arbitrary Host Disk Read** | Unrestricted | Unrestricted | Unrestricted (DAC only) | Blocked (mount namespace) |
| **Host Network Access** | Unrestricted | Unrestricted | Unrestricted | Blocked / Filtered Proxy |
| **Process Inspection (`/proc`)** | Host PID tree visible | Host PID tree visible | Host PID tree visible | Blocked (PID namespace) |
| **Resource Caps (cgroups)** | None | None | None | Enforced (cgroups v2) |
| **Selection Variable** | Default / `compatibility` | `isolated-home` | `isolated` | `container` |
| **Status** | Implemented | Implemented | Implemented | **Design Only (H.4)** |

---

## 2. Credentials & Secret Management

### 2.1 Secret Pattern Scrubbing
agent-hub executes `filterEnv(env, profile)` before spawning any local agent CLI (`src/jobrunner.mjs:292`, `src/sandbox.mjs:60-109`).

Secret filtering evaluates variable names against `SECRET_PATTERNS` (`src/sandbox.mjs:40-49`):
1. `/_TOKEN$/` (e.g., `GITHUB_TOKEN`, `SLACK_TOKEN`)
2. `/_SECRET$/` (e.g., `CLIENT_SECRET`, `FOO_SECRET`)
3. `/_API_KEY$/` (e.g., `GEMINI_API_KEY`, `DEEPSEEK_API_KEY`)
4. `/^AWS_/` (e.g., `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`)
5. `/^GH_TOKEN$/` (GitHub CLI and Copilot token)
6. `/^ANTHROPIC_/` (e.g., `ANTHROPIC_API_KEY`)
7. `/^OPENAI_/` (e.g., `OPENAI_API_KEY`, `OPENAI_ORG_ID`)
8. `/^JULES_API_KEY$/` (Google Jules remote API token)

#### Redaction / Unset Behavior (H.1)
- Under roadmap item H.1 (`docs/roadmap-post-d1.md:544`), secret environment variables are **completely omitted (unset)** from the child environment dictionary (`src/sandbox.mjs:65-67`), rather than being masked with dummy string values such as `'***'`.
- This ensures CLI binaries that validate token format or branch on environment variable presence do not fail with parse errors or false configuration states.
- Non-secret system variables such as `PATH`, `LANG`, and `TZ` are preserved untouched (`test/sandbox.test.mjs:8-42`).
- Working directory `PWD` is explicitly set to job `cwd` across all adapters (`src/jobrunner.mjs:299`) to prevent stale inherited PWD redirection.

#### Telemetry
- `sandboxTelemetry(filteredEnv, originalEnv, profile)` counts omitted secret keys and tracks `homeIsolation` boolean status (`src/sandbox.mjs:117-131`).
- The resulting telemetry object is recorded on the `job.started` lifecycle event (`src/jobrunner.mjs:319-320`):
  ```json
  {
    "kind": "job.started",
    "sandbox": {
      "profile": "isolated",
      "envRedactions": 3,
      "homeIsolation": true
    }
  }
  ```

### 2.2 Opt-in Credential Inclusion (`AGENT_HUB_SANDBOX_INCLUDE`)
Under `isolated` profile, the child environment points `$HOME`, `$TMPDIR`, and `$XDG_*` to an empty sandbox directory (`src/sandbox.mjs:73-83`). By default, CLIs cannot find their config files or authentication tokens.

`AGENT_HUB_SANDBOX_INCLUDE` provides an explicit opt-in bridge (`src/sandbox.mjs:85-102`):
- **Empty by Default**: When unset or empty, nothing is copied (`src/sandbox.mjs:85`, `test/sandbox.test.mjs:87-93`).
- **Parsing**: A comma-separated list of filesystem paths (`src/sandbox.mjs:87-90`).
- **Missing Path Handling**: Non-existent paths are silently skipped without throwing (`if (!fs.existsSync(entry)) continue;`, `src/sandbox.mjs:93-95`).
- **Path Mapping**:
  - **Absolute path**: Copied to the sandbox root (`path.join(sandboxDir, path.basename(entry))`, `src/sandbox.mjs:96-97`).
  - **Relative path**: Preserves its relative folder hierarchy under the sandbox directory (`path.join(sandboxDir, entry)`, `src/sandbox.mjs:98`).
- **Copy, NOT Symlink**:
  - Files and directories are copied using `fs.cpSync(entry, dest, { recursive: true })` (`src/sandbox.mjs:100`).
  - **Why Copy**: Symlinks would allow writes inside the sandbox to mutate the host's original credential or config files on disk. Symlink directory traversal could also escape the intended sandbox directory layout.

### 2.3 Residual Credential Risk
1. **Host DAC Vulnerability**: Because `isolated` and `isolated-home` do not employ filesystem namespaces, any spawned process running shell commands or native code can read host credential files by querying absolute paths (e.g., `cat /home/<user>/.config/gh/hosts.yml` or inspecting `/home/<user>/.ssh/id_ed25519`).
2. **Inherited CLI Token Abuse**: When a CLI config or token file is copied into the sandbox (or inherited via `compatibility`), the LLM-driven CLI session has active access to that token. Because current profiles do not enforce network isolation, a misdirected or compromised agent turn could transmit the token to external hosts over HTTP/DNS.

---

## 3. ReadGuard: Read Purity & Worktree Integrity

agent-hub enforces read purity for jobs executed with `mode: 'read'` (`docs/execution-contract.md:74-81`, `src/jobrunner.mjs:287,447-448,508-522`). A `read` job is intended for reconnaissance, analysis, and reasoning without altering the repository.

```
+-----------------------------------------------------------------------------+
| startJob (mode === 'read')                                                  |
|   takeSnapshot(cwd) --> captures git status & HEAD                          |
+-----------------------------------------------------------------------------+
                                       |
                                       v
                     [ Child Process Runs CLI Adapter ]
                                       |
                                       v
+-----------------------------------------------------------------------------+
| finishJob                                                                   |
|   takeSnapshot(cwd) --> post-run snapshot                                   |
|   diffSnapshots(before, after)                                              |
|     |                                                                       |
|     +---> Changed? == false ---> Success (Result recorded)                  |
|     |                                                                       |
|     +---> Changed? == true  ---> Violation:                                 |
|                                  status = 'failed'                          |
|                                  errorKind = 'read_mode_violation'          |
|                                  (response.txt preserved for inspection)    |
+-----------------------------------------------------------------------------+
```

### 3.1 What ReadGuard Covers
- **Snapshot Baseline**: Taken immediately before process spawn (`src/jobrunner.mjs:287`), after write-gate and lock checks.
- **Terminal Diff**: Re-snapshotted at job termination (`src/jobrunner.mjs:447`).
- **Detection Capabilities** (`src/readguard.mjs:38-45,81-107`):
  - Untracked file creations (`?? file`).
  - Tracked file modifications (`M  file`).
  - Tracked file deletions (`D  file`).
  - File renames (`R  new\0old\0` parsed via NUL-delimited porcelain v1 `-z`, `src/readguard.mjs:17-31`).
  - Fingerprint sensitivity: Stores `${statusCode}:${stat.size}:${stat.mtimeMs}` (`src/readguard.mjs:41`). Files already dirty before job start that receive additional modifications are caught even if their status code remains identical (`test/readguard.test.mjs:76-87`). Pre-existing dirty files left untouched are not flagged (`test/readguard.test.mjs:89-97`).
  - `HEAD` movement: Captures `git rev-parse HEAD` before and after (`src/readguard.mjs:60-65,123`). Commits created during read jobs trigger `headChanged`.
- **Bounded Overhead**:
  - If status records exceed `MAX_ENTRIES = 5000` (`src/readguard.mjs:6`), falls back to count-only comparison to avoid costly per-file `stat` overhead in massive repositories (`src/readguard.mjs:94-96,125-128`).
  - Violation error messages list up to `MAX_MESSAGE_PATHS = 10` paths before appending an ellipsis (`src/readguard.mjs:8,147-151`). Reported path arrays are capped at `MAX_LISTED_PATHS = 50` (`src/readguard.mjs:7,138`).
- **Preserved Diagnostics on Failure**:
  - When a read violation occurs, the job status is marked `failed` with `errorKind: 'read_mode_violation'` (`src/jobrunner.mjs:515-516`).
  - However, `stdout.log`, `response.txt`, tokens, and cost metrics are preserved (`src/jobrunner.mjs:506,518-520`) so callers can inspect the agent's findings and diagnose what file modifications occurred.

### 3.2 Gitignored File Opt-in (`AGENT_HUB_READGUARD_IGNORED`)
- **Flag Configuration**: `AGENT_HUB_READGUARD_IGNORED=1` (`src/config.mjs:16-18`).
- **Default State (0 / unset)**: Git status runs with `--ignored=no` (`src/readguard.mjs:77`). Mutations to gitignored files (e.g. `.env`, local build outputs, cache files) are completely ignored (`test/readguard.test.mjs:198-216`).
- **Opt-in State (`1`)**: Git status runs with `--ignored=matching` (`src/readguard.mjs:77`). Captures modifications to individual ignored files matching patterns (e.g., modifying `.env` or adding ignored test fixtures) (`test/readguard.test.mjs:218-239`).

### 3.3 Fundamental ReadGuard Limits
1. **In-place modifications inside an already-ignored directory**:
   - `git status --ignored=matching` reports directory entries as `!! build/` without recursing or hashing files inside existing ignored directories (`src/readguard.mjs:70-76`, `README.md:952-955`).
   - If an agent modifies `build/bundle.js` in-place without altering directory mtime or entry count, git status does not detect a change. Deep directory hashing is intentionally avoided to keep snapshots lightweight.
2. **Non-git `cwd` is unverifiable**:
   - If `cwd` is not inside a git working tree (or git execution fails), `takeSnapshot` returns `null` (`src/readguard.mjs:57,87`).
   - `diffSnapshots(null, ...)` returns `{ changed: false, headChanged: false, paths: [], unverifiable: true }` (`src/readguard.mjs:120`, `test/readguard.test.mjs:163-169`).
   - A non-git directory is treated as **unverifiable**, NEVER as a violation (`src/jobrunner.mjs:447-448`, `docs/execution-contract.md:78-79`).

---

## 4. Container Architecture Design (H.4 — Design Only)

> [!NOTE]
> This section describes the target architectural design for Level 4 (`container`) as scoped in roadmap item H.4 (`docs/roadmap-post-d1.md:549`). This level is **NOT implemented** in the current runtime.

```
+-------------------------------------------------------------------------------+
| HOST OS (Linux Kernel >= 5.15)                                                |
|                                                                               |
|  agent-hub (Node.js runtime)                                                  |
|    |                                                                          |
|    +--> Spawns bwrap (Bubblewrap container launcher)                          |
|           |                                                                   |
|           +-- Linux Namespaces:                                               |
|           |     CLONE_NEWUSER  (unprivileged user mapping)                    |
|           |     CLONE_NEWPID   (isolated process tree; no host /proc)         |
|           |     CLONE_NEWNS    (pivot_root private mount table)               |
|           |     CLONE_NEWNET   (loopback-only / outbound proxy)               |
|           |     CLONE_NEWIPC   (isolated POSIX/SysV IPC)                      |
|           |     CLONE_NEWUTS   (isolated hostname)                            |
|           |                                                                   |
|           +-- cgroups v2 Scope:                                               |
|           |     cpu.max        (CPU quota and period)                         |
|           |     memory.max     (hard memory ceiling)                          |
|           |     pids.max       (fork bomb mitigation)                         |
|           |                                                                   |
|           +-- Filesystem Mount Table:                                         |
|                 /              (tmpfs root or minimal container image)        |
|                 /usr, /lib     (ro-bind from host)                            |
|                 /bin           (ro-bind minimal CLI toolchain)                |
|                 /tmp           (ephemeral isolated tmpfs)                     |
|                 /home/sandbox  (ephemeral isolated tmpfs)                     |
|                 <cwd>          (--bind if write, --ro-bind if read)           |
|                 <auth-files>   (explicit ro-bind per CLI allowlist)           |
+-------------------------------------------------------------------------------+
```

### 4.1 Technology Selection: Bubblewrap (`bwrap`)
We select `bubblewrap` (`bwrap`) over Docker or rootless Podman as the container engine:
1. **Unprivileged & Daemonless**: Runs unprivileged via Linux user namespaces (`CLONE_NEWUSER`); does not require a background daemon, systemd socket activation, or root privileges.
2. **Minimal Startup Latency**: Sub-10ms invocation overhead (critical for agent-hub short turns vs 500ms+ container engine initialization).
3. **Composable CLI Invocations**: Allows declarative assembly of mount flags (`--ro-bind`, `--bind`, `--tmpfs`, `--dev`, `--proc`, `--unshare-all`).

### 4.2 Namespace Isolation Stack
- **User Namespace (`--unshare-user`)**: Maps the invoking user's UID to `0` inside the container; root privileges inside the container cannot affect host files outside bind mounts.
- **Mount Namespace (`--unshare-mount`)**: Completely decoupled mount table. Host filesystem mounts cannot be discovered or traversed.
- **PID Namespace (`--unshare-pid`)**: Process runs as PID 1 inside the container. Host `/proc` is hidden; agent processes cannot enumerate or signal host processes.
- **IPC Namespace (`--unshare-ipc`)**: Isolates System V IPC and POSIX message queues.
- **UTS Namespace (`--unshare-uts`)**: Private hostname isolation.
- **Network Namespace (`--unshare-net`)**: By default, no network interfaces exist except `lo`.

### 4.3 Resource Isolation (cgroups v2)
To prevent agent execution from exhausting host resources (accidental infinite loops, fork bombs, compiler runaway), the container launcher wraps execution in a dedicated systemd transient scope or cgroup v2 path:
- `memory.max`: Hard upper limit (e.g., `4G`). OOM killer terminates container processes without affecting agent-hub.
- `cpu.max`: Quota allocation (e.g., `200000 100000` for 2 cores max).
- `pids.max`: Process limit (e.g., `512`) to prevent fork-bomb denial-of-service.

### 4.4 Network Policy Default & Outbound Model Gateway
- **Default Policy: Offline (`--unshare-net`)**:
  - Local CLI execution that does not require network access operates completely offline.
- **Model Gateway (Opt-in Network)**:
  - Local CLIs (like `agy`, `opencode`, `copilot`, `codex`) interact with remote LLM model APIs.
  - Instead of granting unconstrained host network access, the container network namespace is linked via `veth` pair to a local loopback proxy or uses host network with a mandatory HTTPS forward proxy.
  - **Domain Whitelist Enforcement**: Proxy permits traffic only to declared API endpoints (e.g., `api.github.com`, `generativelanguage.googleapis.com`, `api.openai.com`).
  - **Cloud Metadata Block**: Unconditionally blocks link-local metadata addresses (`169.254.169.254`, `fd00::/8`) to prevent AWS/GCP/Azure instance credential exfiltration.

### 4.5 Explicit Mount Allowlist
The container filesystem uses an allowlist model:
- **System Binaries & Libraries**:
  - `/usr` -> `--ro-bind /usr /usr`
  - `/lib`, `/lib64` -> `--ro-bind /lib /lib`, `--ro-bind /lib64 /lib64`
  - `/bin` -> `--ro-bind /bin /bin`
  - `/etc/resolv.conf`, `/etc/ssl/certs` -> `--ro-bind` for TLS certificate verification.
- **Ephemeral Scratch Storage**:
  - `/tmp` -> `--tmpfs /tmp`
  - `/home/sandbox` -> `--tmpfs /home/sandbox`
- **Workspace Workspace (`cwd`)**:
  - If `mode: 'write'`: `--bind <cwd> <cwd>` (read-write mount to the verified worktree).
  - If `mode: 'read'`: `--ro-bind <cwd> <cwd>` (**kernel-enforced read purity**).
- **Explicit Auth Config Mounts**:
  - Strictly allowlisted files mounted read-only into `/home/sandbox` based on the targeted CLI adapter.

### 4.6 Why `container` Cannot Be Enabled Prematurely
Enabling container isolation without a verified per-CLI compatibility matrix will cause immediate production failures:
1. **Hidden Sub-binary & Library Dependencies**: CLI tools dynamically spawn `git`, `node`, `bash`, compilers, or python runtimes. If paths are omitted from the mount allowlist, CLI toolchains break silently.
2. **Local Daemon Sockets**: Tools like OpenCode v2 interact with a local background daemon (`~/.local/state/opencode/service.json`). Complete network and filesystem isolation severs IPC to the daemon.
3. **Credential Storage Mechanisms**: Some CLIs expect system keyring access (Secret Service API via D-Bus, `libsecret`). Containerization without mocking or mounting these paths crashes authentication loops.
4. **Risk Policy**: In accordance with roadmap risk guidelines (`docs/roadmap-post-d1.md:564-565`), `compatibility` remains the safe default until every CLI's requirements are cataloged and tested.

---

## 5. CLI Compatibility Matrix & Verification Plan

### 5.1 CLI Requirements Matrix

| CLI Agent | Binary & Daemon Discovery | Required Auth / Config Paths | Network Endpoints Required | Compatibility Notes |
|---|---|---|---|---|
| **`agy`** (Antigravity) | `agy` or `agys` (`src/providers/agys.mjs:6`) | `~/.gemini/` (app data & auth), `~/.config/` | Google Gemini API (`generativelanguage.googleapis.com`) | agys profile wrapper selects accounts via quota (`src/providers/agys.mjs:46-50`). |
| **`opencode`** | `opencode` (`src/adapters/opencode.mjs:22`) | `~/.opencode/`, `~/.config/opencode/`, `~/.local/state/opencode/service.json` | Model provider APIs (OpenCode Zen, DeepSeek, etc.) | v2 daemon bridge requires reading service port & password (`README.md:1179`). Needs `PWD=cwd` (`src/jobrunner.mjs:299`). |
| **`copilot`** | `copilot` (`src/adapters/copilot.mjs:11`) | `~/.config/github-copilot/` (hosts.json), `~/.copilot/` | GitHub Copilot APIs (`api.github.com`, `copilot-proxy.githubusercontent.com`) | `GH_TOKEN` is scrubbed by `filterEnv` (`src/sandbox.mjs:45`); must read disk credentials. |
| **`codex`** | `codex` (`src/adapters/codex.mjs:11`) | `~/.codex/` (auth & config), `~/.config/codex/` | OpenAI Codex / model endpoints | Supports `--ignore-user-config` opt-in via `AGENT_HUB_CODEX_IGNORE_USER_CONFIG` (`src/adapters/codex.mjs:23-26`). |

### 5.2 Behavior Across Isolation Levels

| CLI | `compatibility` | `isolated-home` | `isolated` (Default Include) | `isolated` (With Explicit Include) | `container` (Target) |
|---|---|---|---|---|---|
| **`agy`** | **Pass** (inherits `$HOME`) | **Fail** (auth missing in temp `$HOME`) | **Fail** (empty sandbox) | **Pass** (`AGENT_HUB_SANDBOX_INCLUDE=~/.gemini`) | **Pass** (ro-bind `~/.gemini`) |
| **`opencode`** | **Pass** (inherits `$HOME`) | **Fail** (service credentials missing) | **Fail** (daemon unreachable) | **Pass** (`AGENT_HUB_SANDBOX_INCLUDE=~/.config/opencode,~/.local/state/opencode`) | **Pass** (ro-bind config + service socket proxy) |
| **`copilot`** | **Pass** (inherits `$HOME`) | **Fail** (auth missing; `GH_TOKEN` unset) | **Fail** (empty sandbox) | **Pass** (`AGENT_HUB_SANDBOX_INCLUDE=~/.config/github-copilot`) | **Pass** (ro-bind `~/.config/github-copilot`) |
| **`codex`** | **Pass** (inherits `$HOME`) | **Fail** (auth missing in temp `$HOME`) | **Fail** (empty sandbox) | **Pass** (`AGENT_HUB_SANDBOX_INCLUDE=~/.codex`) | **Pass** (ro-bind `~/.codex`) |

### 5.3 Smoke Test Suite (Opt-in, Live Verification)

To verify compatibility without mutating production state, execute the following non-destructive smoke tests for each CLI across isolation profiles.

#### 1. `agy` Smoke Test
```bash
# Level 1: compatibility
AGENT_HUB_SANDBOX_PROFILE=compatibility node -e "
  import { startJob } from './src/jobrunner.mjs'
  const { job, done } = startJob({ agent: 'agy', model: 'gemini-3.8-flash-low', task: 'respond with pong', mode: 'read', cwd: process.cwd() })
  await done
  console.log('Status:', job.status, 'Error:', job.error)
"

# Level 3: isolated with include
AGENT_HUB_SANDBOX_PROFILE=isolated \
AGENT_HUB_SANDBOX_INCLUDE="$HOME/.gemini" node -e "
  import { startJob } from './src/jobrunner.mjs'
  const { job, done } = startJob({ agent: 'agy', model: 'gemini-3.8-flash-low', task: 'respond with pong', mode: 'read', cwd: process.cwd() })
  await done
  console.log('Status:', job.status, 'Error:', job.error)
"
```
- **Success Assertion**: `job.status === 'succeeded'`, no `agy not authenticated` (`src/adapters/agy.mjs:103-104`).

#### 2. `opencode` Smoke Test
```bash
# Level 1: compatibility
AGENT_HUB_SANDBOX_PROFILE=compatibility node -e "
  import { startJob } from './src/jobrunner.mjs'
  const { job, done } = startJob({ agent: 'opencode', model: 'opencode/big-pickle', task: 'respond with pong', mode: 'read', cwd: process.cwd() })
  await done
  console.log('Status:', job.status, 'Error:', job.error)
"

# Level 3: isolated with include
AGENT_HUB_SANDBOX_PROFILE=isolated \
AGENT_HUB_SANDBOX_INCLUDE="$HOME/.config/opencode,$HOME/.local/state/opencode" node -e "
  import { startJob } from './src/jobrunner.mjs'
  const { job, done } = startJob({ agent: 'opencode', model: 'opencode/big-pickle', task: 'respond with pong', mode: 'read', cwd: process.cwd() })
  await done
  console.log('Status:', job.status, 'Error:', job.error)
"
```
- **Success Assertion**: `job.status === 'succeeded'`, parseResult returns output, no 401/unauthorized error (`src/adapters/opencode.mjs:155`).

#### 3. `copilot` Smoke Test
```bash
# Level 1: compatibility
AGENT_HUB_SANDBOX_PROFILE=compatibility node -e "
  import { startJob } from './src/jobrunner.mjs'
  const { job, done } = startJob({ agent: 'copilot', model: 'auto', task: 'respond with pong', mode: 'read', cwd: process.cwd() })
  await done
  console.log('Status:', job.status, 'Error:', job.error)
"

# Level 3: isolated with include
AGENT_HUB_SANDBOX_PROFILE=isolated \
AGENT_HUB_SANDBOX_INCLUDE="$HOME/.config/github-copilot" node -e "
  import { startJob } from './src/jobrunner.mjs'
  const { job, done } = startJob({ agent: 'copilot', model: 'auto', task: 'respond with pong', mode: 'read', cwd: process.cwd() })
  await done
  console.log('Status:', job.status, 'Error:', job.error)
"
```
- **Success Assertion**: `job.status === 'succeeded'`, no `copilot not authenticated` (`src/adapters/copilot.mjs:68-69`).

#### 4. `codex` Smoke Test
```bash
# Level 1: compatibility
AGENT_HUB_SANDBOX_PROFILE=compatibility node -e "
  import { startJob } from './src/jobrunner.mjs'
  const { job, done } = startJob({ agent: 'codex', model: 'default', task: 'respond with pong', mode: 'read', cwd: process.cwd() })
  await done
  console.log('Status:', job.status, 'Error:', job.error)
"

# Level 3: isolated with include
AGENT_HUB_SANDBOX_PROFILE=isolated \
AGENT_HUB_SANDBOX_INCLUDE="$HOME/.codex" node -e "
  import { startJob } from './src/jobrunner.mjs'
  const { job, done } = startJob({ agent: 'codex', model: 'default', task: 'respond with pong', mode: 'read', cwd: process.cwd() })
  await done
  console.log('Status:', job.status, 'Error:', job.error)
"
```
- **Success Assertion**: `job.status === 'succeeded'`, no `codex not authenticated` (`src/adapters/codex.mjs:114-115`).

---

## 6. Non-Goals & Security Boundaries

To maintain technical honesty, the following guarantees are explicitly **out of scope**:

1. **`isolated` Profile is Never Claimed as a Container**:
   - We will never market or treat `isolated` as a security boundary against malicious or untrusted code execution (`src/sandbox.mjs:25-27`, `docs/roadmap-post-d1.md:568`). It does not use Linux namespaces, seccomp filters, or cgroups.
2. **ReadGuard is Not an Infallible Intrusion Detection System (IDS)**:
   - ReadGuard is a lightweight, cooperative git-state comparison mechanism (`src/readguard.mjs:38-45`). It does not hook system calls, intercept disk block devices, or detect memory tampering. Modifications to unhashed gitignored directory contents or mutations made and reverted prior to process exit are undetectable by design.
3. **No Multi-Tenant Security / Hostile Payload Protection**:
   - agent-hub coordinates trusted local developer tools. It does not provide multi-tenant containment or protect the host operating system from deliberate, hostile breakout exploits delivered inside agent prompt instructions.
4. **No Deep Network Inspection or Data Loss Prevention (DLP)**:
   - Under current isolation profiles, agent-hub does not inspect, filter, or proxy TCP/IP payloads transmitted by spawned CLIs.
5. **No Keyring / Secret Vault Service**:
   - agent-hub does not generate, store, or manage API keys. Its responsibility is strictly bounded to scrubbing known credential patterns from process environments and isolating configuration directory paths.

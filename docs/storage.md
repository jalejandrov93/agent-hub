# Storage

## SQLite as coordination state

`better-sqlite3` is a runtime dependency; `initDb()` runs at MCP and
dashboard startup (`AGENT_HUB_HOME/agent-hub.db`, WAL, singleton per state
dir). Coordination state is partitioned across seven tables:
- `workflows`: DAG definitions (`definition_json`), run status, and timestamps.
- `workflow_nodes`: step status (`pending`, `running`, `waiting`, `succeeded`, `failed`, `skipped`, `canceled`), CAS `claimed_by` leases, and result JSON.
- `jobs`: mirrors execution records, workflow links (`workflow_id`, `step_id`, `parent_execution_id`, `root_execution_id`), `attempt`, `remote_state`, `verified`, and `judge_verdict`.
- `leases`: distributed single-writer locks for write-mode checkouts (`job_id`, `owner`, `expires_at`).
- `harness_origins`: maps dispatched jobs to their originating harness sessions for completion waking.
- `task_handoffs`: structured cross-step handoff payloads per step.
- `task_context`: append-only workflow-scoped notes, findings, and decisions.

Dual-mode storage writes to both SQLite and the filesystem: `createJob`/`updateResult`
persist `runs/<jobId>/result.json` for filesystem compatibility, while SQLite
serves as the authority for state transitions and cross-process coordination.
The read path is configurable via `AGENT_HUB_STORE`: `json` (default; reads
`result.json`), `sqlite` (reads SQLite first with JSON fallback), or `shadow`
(reads JSON, verifies against SQLite, and logs divergences without blocking).
If `better-sqlite3` is unavailable, storage falls back to `storage.json` under
`AGENT_HUB_HOME` with a one-time warning.


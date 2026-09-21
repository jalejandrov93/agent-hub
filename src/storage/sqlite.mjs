import fs from 'node:fs'
import path from 'node:path'
import { stateHome as resolveStateHome, paths } from '../config.mjs'
import { updateJsonLocked } from '../fsutil.mjs'

/**
 * Dual-mode storage: better-sqlite3 when available, JSON file fallback.
 *
 * Tables (C0 — workflow tracking + job mirror):
 *   workflows(id TEXT PK, name TEXT, created_at TEXT)
 *   workflow_nodes(workflow_id TEXT, step_id TEXT, PRIMARY KEY(workflow_id,step_id))
 *   jobs(job_id TEXT PK, workflow_id TEXT, step_id TEXT, parent_execution_id TEXT,
 *        root_execution_id TEXT, attempt INTEGER, remote_state TEXT,
 *        quality_score REAL, verified INTEGER, judge_verdict TEXT, result_json TEXT)
 *   leases(job_id TEXT PK, owner TEXT, expires_at TEXT)
 *
 * The JSON fallback stores everything in a single `storage.json` file under
 * the same stateHome() directory. It's meant for development/testing only —
 * real deployments should install better-sqlite3.
 */

let SqliteDB = null
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  SqliteDB = (await import('better-sqlite3')).default
} catch {
  // better-sqlite3 not installed — fall back to JSON
}

export function _setSqliteDB(val) {
  SqliteDB = val
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
}

function normalizeHome(stateHomeArg) {
  if (typeof stateHomeArg === 'string' && stateHomeArg.length > 0) return stateHomeArg
  return resolveStateHome()
}

/* ------------------------------------------------------------------ */
/*  JSON fallback                                                      */
/* ------------------------------------------------------------------ */

function jsonStoragePath(stateHome) {
  return path.join(stateHome, 'storage.json')
}

function defaultJsonStore() {
  return { workflows: {}, workflow_nodes: {}, jobs: {}, leases: {}, harness_origins: {}, task_handoffs: {}, task_context: [], agent_messages: [], dispatch_reservations: {} }
}

function readJsonStore(stateHome) {
  const p = jsonStoragePath(stateHome)
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'))
  } catch {
    return defaultJsonStore()
  }
}

function writeJsonStore(stateHome, store) {
  const p = jsonStoragePath(stateHome)
  ensureDir(path.dirname(p))
  fs.writeFileSync(p, JSON.stringify(store, null, 2), 'utf8')
}

function jsonInitDb(stateHome) {
  ensureDir(stateHome)
  const p = jsonStoragePath(stateHome)
  if (!fs.existsSync(p)) {
    writeJsonStore(stateHome, defaultJsonStore())
  }
}

function normalizeJobRow(row) {
  return {
    job_id: row.job_id,
    workflow_id: row.workflow_id ?? null,
    step_id: row.step_id ?? null,
    parent_execution_id: row.parent_execution_id ?? null,
    root_execution_id: row.root_execution_id ?? null,
    attempt: row.attempt ?? null,
    remote_state: row.remote_state ?? null,
    quality_score: row.quality_score ?? null,
    verified: row.verified === true ? 1 : (row.verified === false ? 0 : (row.verified ?? null)),
    judge_verdict: row.judge_verdict ?? null,
    result_json: typeof row.result_json === 'string' ? row.result_json : JSON.stringify(row.result_json ?? null),
  }
}

function normalizeLeaseRow(row) {
  return {
    job_id: row.job_id,
    owner: row.owner ?? null,
    expires_at: row.expires_at ?? null,
  }
}

function normalizeWorkflowRow(row) {
  const updatedAt = row.updated_at ?? row.updatedAt ?? new Date().toISOString()
  const createdAt = row.created_at ?? row.createdAt ?? new Date().toISOString()
  return {
    id: row.id,
    name: row.name ?? '',
    created_at: createdAt,
    createdAt,
    definition_json: typeof row.definition_json === 'string'
      ? row.definition_json
      : (row.definition ? JSON.stringify(row.definition) : null),
    status: row.status ?? 'pending',
    updated_at: updatedAt,
    updatedAt,
  }
}

function normalizeWorkflowNodeRow(row) {
  const updatedAt = row.updated_at ?? row.updatedAt ?? new Date().toISOString()
  return {
    workflow_id: row.workflow_id,
    step_id: row.step_id,
    status: row.status ?? 'pending',
    attempt: row.attempt ?? 0,
    updated_at: updatedAt,
    updatedAt,
    claimed_by: row.claimed_by ?? row.claimedBy ?? null,
    result_json: typeof row.result_json === 'string'
      ? row.result_json
      : JSON.stringify(row.result_json ?? row.result ?? null),
  }
}

function jsonUpsertJob(stateHome, row) {
  const store = readJsonStore(stateHome)
  store.jobs = store.jobs || {}
  store.jobs[row.job_id] = normalizeJobRow(row)
  writeJsonStore(stateHome, store)
}

function jsonGetJob(stateHome, jobId) {
  const store = readJsonStore(stateHome)
  return store.jobs?.[jobId] ?? null
}

function jsonListJobIds(stateHome) {
  const store = readJsonStore(stateHome)
  return Object.keys(store.jobs || {})
}

function jsonUpsertLease(stateHome, row) {
  const store = readJsonStore(stateHome)
  store.leases = store.leases || {}
  store.leases[row.job_id] = normalizeLeaseRow(row)
  writeJsonStore(stateHome, store)
}

function jsonDeleteLease(stateHome, jobId) {
  const store = readJsonStore(stateHome)
  if (store.leases && store.leases[jobId]) {
    delete store.leases[jobId]
    writeJsonStore(stateHome, store)
  }
}

function jsonGetLease(stateHome, jobId) {
  const store = readJsonStore(stateHome)
  return store.leases?.[jobId] ?? null
}

function jsonUpsertWorkflow(stateHome, row) {
  const store = readJsonStore(stateHome)
  store.workflows = store.workflows || {}
  store.workflows[row.id] = normalizeWorkflowRow(row)
  writeJsonStore(stateHome, store)
}

function jsonGetWorkflow(stateHome, id) {
  const store = readJsonStore(stateHome)
  return store.workflows?.[id] ?? null
}

function jsonUpsertWorkflowNode(stateHome, row) {
  const store = readJsonStore(stateHome)
  store.workflow_nodes = store.workflow_nodes || {}
  const key = `${row.workflow_id}:${row.step_id}`
  store.workflow_nodes[key] = normalizeWorkflowNodeRow(row)
  writeJsonStore(stateHome, store)
}

function jsonGetWorkflowNode(stateHome, workflowId, stepId) {
  const store = readJsonStore(stateHome)
  return store.workflow_nodes?.[`${workflowId}:${stepId}`] ?? null
}

function jsonListWorkflowNodes(stateHome, workflowId) {
  const store = readJsonStore(stateHome)
  const prefix = `${workflowId}:`
  const result = []
  for (const [k, v] of Object.entries(store.workflow_nodes || {})) {
    if (k.startsWith(prefix) || v.workflow_id === workflowId) {
      result.push(v)
    }
  }
  return result
}

function jsonPublishWorkflowNodeReady(stateHome, { workflowId, stepId }) {
  const store = readJsonStore(stateHome)
  store.workflow_nodes = store.workflow_nodes || {}
  const key = `${workflowId}:${stepId}`
  const existing = store.workflow_nodes[key]
  if (!existing || existing.status !== 'pending') return false
  existing.status = 'ready'
  existing.updated_at = new Date().toISOString()
  existing.updatedAt = existing.updated_at
  writeJsonStore(stateHome, store)
  return true
}
function jsonClaimWorkflowNode(stateHome, { workflowId, stepId, claimedBy, attempt }) {
  const store = readJsonStore(stateHome)
  store.workflow_nodes = store.workflow_nodes || {}
  const key = `${workflowId}:${stepId}`
  const existing = store.workflow_nodes[key]
  if (!existing) return false
  if (
    (existing.status === 'pending' || existing.status === 'ready') &&
    (!existing.claimed_by || existing.claimed_by === claimedBy)
  ) {
    existing.claimed_by = claimedBy
    existing.status = 'running'
    existing.attempt = attempt ?? (existing.attempt + 1)
    existing.updated_at = new Date().toISOString()
    existing.updatedAt = existing.updated_at
    writeJsonStore(stateHome, store)
    return true
  }
  return false
}

/**
 * C1.2: atomic CAS resume waiting -> running. Only flips a node that is
 * STILL waiting; preserves claimed_by/attempt/result_json so the scheduler
 * that holds the claim keeps it — a resume never steals ownership.
 */
function jsonResumeWorkflowNode(stateHome, { workflowId, stepId }) {
  const store = readJsonStore(stateHome)
  store.workflow_nodes = store.workflow_nodes || {}
  const key = `${workflowId}:${stepId}`
  const existing = store.workflow_nodes[key]
  if (!existing || existing.status !== 'waiting') return false
  existing.status = 'running'
  existing.updated_at = new Date().toISOString()
  existing.updatedAt = existing.updated_at
  writeJsonStore(stateHome, store)
  return true
}

function normalizeHarnessOriginRow(row) {
  return {
    job_id: row.job_id,
    harness_session_id: row.harness_session_id ?? null,
    harness: row.harness ?? null,
    created_at: row.created_at ?? new Date().toISOString(),
  }
}

function jsonUpsertHarnessOrigin(stateHome, row) {
  const store = readJsonStore(stateHome)
  store.harness_origins = store.harness_origins || {}
  const norm = normalizeHarnessOriginRow(row)
  store.harness_origins[norm.job_id] = norm
  writeJsonStore(stateHome, store)
  return norm
}

function jsonGetHarnessOrigin(stateHome, jobId) {
  const store = readJsonStore(stateHome)
  return store.harness_origins?.[jobId] ?? null
}

function normalizeHandoffRow(row) {
  return {
    workflow_id: row.workflow_id,
    step_id: row.step_id,
    handoff_json: typeof row.handoff_json === 'string'
      ? row.handoff_json
      : JSON.stringify(row.handoff_json ?? {}),
    updated_at: row.updated_at ?? new Date().toISOString(),
  }
}

function jsonUpsertHandoff(stateHome, row) {
  const store = readJsonStore(stateHome)
  store.task_handoffs = store.task_handoffs || {}
  const norm = normalizeHandoffRow(row)
  const key = `${norm.workflow_id}:${norm.step_id}`
  store.task_handoffs[key] = norm
  writeJsonStore(stateHome, store)
  return norm
}

function jsonGetHandoff(stateHome, workflowId, stepId) {
  const store = readJsonStore(stateHome)
  return store.task_handoffs?.[`${workflowId}:${stepId}`] ?? null
}

function jsonListHandoffs(stateHome, workflowId) {
  const store = readJsonStore(stateHome)
  const prefix = `${workflowId}:`
  const result = []
  for (const [k, v] of Object.entries(store.task_handoffs || {})) {
    if (k.startsWith(prefix) || v.workflow_id === workflowId) {
      result.push(v)
    }
  }
  return result.sort((a, b) => a.step_id.localeCompare(b.step_id))
}

function normalizeContextRow(row) {
  return {
    workflow_id: row.workflow_id,
    step_id: row.step_id ?? null,
    kind: row.kind,
    text: row.text,
    created_at: row.created_at ?? new Date().toISOString(),
  }
}

function jsonAddContextEntry(stateHome, row) {
  const store = readJsonStore(stateHome)
  store.task_context = store.task_context || []
  const norm = normalizeContextRow(row)
  const maxId = store.task_context.reduce((max, e) => Math.max(max, Number(e.id) || 0), 0)
  const entry = { id: maxId + 1, ...norm }
  store.task_context.push(entry)
  writeJsonStore(stateHome, store)
  return entry
}

function jsonListContextEntries(stateHome, workflowId, stepId = null) {
  const store = readJsonStore(stateHome)
  const entries = store.task_context || []
  const filtered = entries.filter((e) => {
    if (e.workflow_id !== workflowId) return false
    if (stepId !== null && stepId !== undefined) {
      return e.step_id === stepId
    }
    return true
  })
  return [...filtered].sort((a, b) => (a.id || 0) - (b.id || 0))
}

function normalizeAgentMessageRow(row) {
  return {
    root_execution_id: row.root_execution_id ?? row.rootExecutionId,
    workflow_id: row.workflow_id ?? row.workflowId ?? null,
    from_agent: row.from_agent ?? row.fromAgent ?? row.from,
    to_agent: row.to_agent ?? row.toAgent ?? row.to,
    kind: row.kind,
    text: row.text,
    created_at: row.created_at ?? row.createdAt ?? new Date().toISOString(),
    delivered_at: row.delivered_at ?? row.deliveredAt ?? null,
    ack_at: row.ack_at ?? row.ackAt ?? null,
  }
}

function jsonInsertAgentMessage(stateHome, row) {
  const store = readJsonStore(stateHome)
  store.agent_messages = store.agent_messages || []
  const norm = normalizeAgentMessageRow(row)
  const maxId = store.agent_messages.reduce((max, m) => Math.max(max, Number(m.id) || 0), 0)
  const entry = { id: row.id != null ? Number(row.id) : maxId + 1, ...norm }
  store.agent_messages.push(entry)
  writeJsonStore(stateHome, store)
  return entry
}

function jsonListAgentMessages(stateHome, { to, rootExecutionId, unreadOnly } = {}) {
  const store = readJsonStore(stateHome)
  const messages = store.agent_messages || []
  const filtered = messages.filter((m) => {
    if (to) {
      if (Array.isArray(to)) {
        if (!to.includes(m.to_agent)) return false
      } else if (m.to_agent !== to) {
        return false
      }
    }
    if (rootExecutionId && m.root_execution_id !== rootExecutionId) return false
    if (unreadOnly && m.delivered_at != null) return false
    return true
  })
  return [...filtered].sort((a, b) => (a.id || 0) - (b.id || 0))
}

function jsonMarkAgentMessageDelivered(stateHome, id, at) {
  const store = readJsonStore(stateHome)
  store.agent_messages = store.agent_messages || []
  const msg = store.agent_messages.find((m) => m.id === Number(id))
  if (!msg) return false
  msg.delivered_at = at ?? new Date().toISOString()
  writeJsonStore(stateHome, store)
  return true
}

function jsonMarkAgentMessageAck(stateHome, id, at) {
  const store = readJsonStore(stateHome)
  store.agent_messages = store.agent_messages || []
  const msg = store.agent_messages.find((m) => m.id === Number(id))
  if (!msg) return false
  msg.ack_at = at ?? new Date().toISOString()
  writeJsonStore(stateHome, store)
  return true
}

function jsonGetAgentMessage(stateHome, id) {
  const store = readJsonStore(stateHome)
  return (store.agent_messages || []).find((m) => m.id === Number(id)) ?? null
}

function normalizeDispatchReservationRow(row) {
  return {
    dispatch_key: row.dispatch_key ?? row.dispatchKey,
    job_id: row.job_id ?? row.jobId ?? null,
    created_at: row.created_at ?? row.createdAt ?? new Date().toISOString(),
  }
}

function jsonReserveDispatchKey(stateHome, { dispatchKey, jobId = null, createdAt = null } = {}) {
  // The lock is what makes this atomic ACROSS processes: a bare
  // read-check-write let every concurrent process observe the key absent and
  // all of them win. The JSON backend is the default, so this is the path that
  // actually matters at runtime.
  let outcome = null
  updateJsonLocked(
    jsonStoragePath(stateHome),
    (store) => {
      store.dispatch_reservations = store.dispatch_reservations || {}
      const existing = store.dispatch_reservations[dispatchKey]
      if (existing) {
        outcome = {
          reserved: false,
          existingJobId: existing.job_id ?? null,
          existingCreatedAt: existing.created_at ?? null,
        }
        return store
      }
      store.dispatch_reservations[dispatchKey] = normalizeDispatchReservationRow({ dispatchKey, jobId, createdAt })
      outcome = { reserved: true, existingJobId: null, existingCreatedAt: null }
      return store
    },
    { defaultValue: defaultJsonStore() }
  )
  return outcome
}

function jsonGetDispatchReservation(stateHome, dispatchKey) {
  const store = readJsonStore(stateHome)
  return store.dispatch_reservations?.[dispatchKey] ?? null
}

function jsonReleaseDispatchReservation(stateHome, dispatchKey) {
  let removed = false
  updateJsonLocked(
    jsonStoragePath(stateHome),
    (store) => {
      if (!store.dispatch_reservations || !store.dispatch_reservations[dispatchKey]) return store
      delete store.dispatch_reservations[dispatchKey]
      removed = true
      return store
    },
    { defaultValue: defaultJsonStore() }
  )
  return removed
}

/* ------------------------------------------------------------------ */
/*  better-sqlite3                                                     */
/* ------------------------------------------------------------------ */

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS workflows (
  id TEXT PRIMARY KEY,
  name TEXT,
  created_at TEXT,
  definition_json TEXT,
  status TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS workflow_nodes (
  workflow_id TEXT,
  step_id TEXT,
  status TEXT DEFAULT 'pending',
  attempt INTEGER DEFAULT 0,
  updated_at TEXT,
  claimed_by TEXT,
  result_json TEXT,
  PRIMARY KEY(workflow_id, step_id)
);

CREATE TABLE IF NOT EXISTS jobs (
  job_id TEXT PRIMARY KEY,
  workflow_id TEXT,
  step_id TEXT,
  parent_execution_id TEXT,
  root_execution_id TEXT,
  attempt INTEGER,
  remote_state TEXT,
  quality_score REAL,
  verified INTEGER,
  judge_verdict TEXT,
  result_json TEXT
);

CREATE TABLE IF NOT EXISTS leases (
  job_id TEXT PRIMARY KEY,
  owner TEXT,
  expires_at TEXT
);

CREATE TABLE IF NOT EXISTS harness_origins (
  job_id TEXT PRIMARY KEY,
  harness_session_id TEXT,
  harness TEXT,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS task_handoffs (
  workflow_id TEXT,
  step_id TEXT,
  handoff_json TEXT,
  updated_at TEXT,
  PRIMARY KEY(workflow_id, step_id)
);

CREATE TABLE IF NOT EXISTS task_context (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workflow_id TEXT,
  step_id TEXT,
  kind TEXT,
  text TEXT,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS agent_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  root_execution_id TEXT NOT NULL,
  workflow_id TEXT,
  from_agent TEXT NOT NULL,
  to_agent TEXT NOT NULL,
  kind TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL,
  delivered_at TEXT,
  ack_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_agent_messages_delivery ON agent_messages (to_agent, root_execution_id, delivered_at);

CREATE TABLE IF NOT EXISTS dispatch_reservations (
  dispatch_key TEXT PRIMARY KEY,
  job_id TEXT,
  created_at TEXT NOT NULL
);
`

const UPSERT_JOB_SQL = `
INSERT INTO jobs (job_id, workflow_id, step_id, parent_execution_id, root_execution_id,
                  attempt, remote_state, quality_score, verified, judge_verdict, result_json)
VALUES (@job_id, @workflow_id, @step_id, @parent_execution_id, @root_execution_id,
        @attempt, @remote_state, @quality_score, @verified, @judge_verdict, @result_json)
ON CONFLICT(job_id) DO UPDATE SET
  workflow_id = @workflow_id,
  step_id = @step_id,
  parent_execution_id = @parent_execution_id,
  root_execution_id = @root_execution_id,
  attempt = @attempt,
  remote_state = @remote_state,
  quality_score = @quality_score,
  verified = @verified,
  judge_verdict = @judge_verdict,
  result_json = @result_json
`

const GET_JOB_SQL = `SELECT * FROM jobs WHERE job_id = ?`
const LIST_JOB_IDS_SQL = `SELECT job_id FROM jobs`

const UPSERT_LEASE_SQL = `
INSERT INTO leases (job_id, owner, expires_at)
VALUES (@job_id, @owner, @expires_at)
ON CONFLICT(job_id) DO UPDATE SET
  owner = @owner,
  expires_at = @expires_at
`

const DELETE_LEASE_SQL = `DELETE FROM leases WHERE job_id = ?`

const GET_LEASE_SQL = `SELECT * FROM leases WHERE job_id = ?`

const UPSERT_WORKFLOW_SQL = `
INSERT INTO workflows (id, name, created_at, definition_json, status, updated_at)
VALUES (@id, @name, @created_at, @definition_json, @status, @updated_at)
ON CONFLICT(id) DO UPDATE SET
  name = @name,
  definition_json = COALESCE(@definition_json, workflows.definition_json),
  status = @status,
  updated_at = @updated_at
`

const GET_WORKFLOW_SQL = `SELECT * FROM workflows WHERE id = ?`

const UPSERT_WORKFLOW_NODE_SQL = `
INSERT INTO workflow_nodes (workflow_id, step_id, status, attempt, updated_at, claimed_by, result_json)
VALUES (@workflow_id, @step_id, @status, @attempt, @updated_at, @claimed_by, @result_json)
ON CONFLICT(workflow_id, step_id) DO UPDATE SET
  status = @status,
  attempt = @attempt,
  updated_at = @updated_at,
  claimed_by = @claimed_by,
  result_json = @result_json
`

const GET_WORKFLOW_NODE_SQL = `SELECT * FROM workflow_nodes WHERE workflow_id = ? AND step_id = ?`

const LIST_WORKFLOW_NODES_SQL = `SELECT * FROM workflow_nodes WHERE workflow_id = ?`

const CLAIM_WORKFLOW_NODE_SQL = `
UPDATE workflow_nodes
SET claimed_by = @claimed_by,
    status = 'running',
    attempt = CASE WHEN @attempt IS NOT NULL THEN @attempt ELSE attempt + 1 END,
    updated_at = @updated_at
WHERE workflow_id = @workflow_id
  AND step_id = @step_id
  AND status IN ('pending', 'ready')
  AND (claimed_by IS NULL OR claimed_by = '' OR claimed_by = @claimed_by)
`

const PUBLISH_READY_SQL = `
UPDATE workflow_nodes
SET status = 'ready',
    updated_at = @updated_at
WHERE workflow_id = @workflow_id
  AND step_id = @step_id
  AND status = 'pending'
`

const RESUME_WORKFLOW_NODE_SQL = `
UPDATE workflow_nodes
SET status = 'running',
    updated_at = @updated_at
WHERE workflow_id = @workflow_id
  AND step_id = @step_id
  AND status = 'waiting'
`

const UPSERT_HARNESS_ORIGIN_SQL = `
INSERT INTO harness_origins (job_id, harness_session_id, harness, created_at)
VALUES (@job_id, @harness_session_id, @harness, @created_at)
ON CONFLICT(job_id) DO UPDATE SET
  harness_session_id = @harness_session_id,
  harness = @harness,
  created_at = @created_at
`

const GET_HARNESS_ORIGIN_SQL = `SELECT * FROM harness_origins WHERE job_id = ?`

const UPSERT_HANDOFF_SQL = `
INSERT INTO task_handoffs (workflow_id, step_id, handoff_json, updated_at)
VALUES (@workflow_id, @step_id, @handoff_json, @updated_at)
ON CONFLICT(workflow_id, step_id) DO UPDATE SET
  handoff_json = @handoff_json,
  updated_at = @updated_at
`

const GET_HANDOFF_SQL = `SELECT * FROM task_handoffs WHERE workflow_id = ? AND step_id = ?`

const LIST_HANDOFFS_SQL = `SELECT * FROM task_handoffs WHERE workflow_id = ? ORDER BY step_id ASC`

const ADD_CONTEXT_ENTRY_SQL = `
INSERT INTO task_context (workflow_id, step_id, kind, text, created_at)
VALUES (@workflow_id, @step_id, @kind, @text, @created_at)
`

const LIST_CONTEXT_ENTRIES_SQL = `SELECT * FROM task_context WHERE workflow_id = ? ORDER BY id ASC`

const LIST_CONTEXT_ENTRIES_BY_STEP_SQL = `SELECT * FROM task_context WHERE workflow_id = ? AND step_id = ? ORDER BY id ASC`

const INSERT_AGENT_MESSAGE_SQL = `
INSERT INTO agent_messages (root_execution_id, workflow_id, from_agent, to_agent, kind, text, created_at, delivered_at, ack_at)
VALUES (@root_execution_id, @workflow_id, @from_agent, @to_agent, @kind, @text, @created_at, @delivered_at, @ack_at)
`

const RESERVE_DISPATCH_KEY_SQL = `
INSERT INTO dispatch_reservations (dispatch_key, job_id, created_at)
VALUES (@dispatch_key, @job_id, @created_at)
ON CONFLICT(dispatch_key) DO NOTHING
`

const GET_DISPATCH_RESERVATION_SQL = `SELECT * FROM dispatch_reservations WHERE dispatch_key = ?`

const DELETE_DISPATCH_RESERVATION_SQL = `DELETE FROM dispatch_reservations WHERE dispatch_key = ?`

function sqliteInitDb(stateHome) {
  const dbPath = paths({ AGENT_HUB_HOME: stateHome }).dbFile
  ensureDir(stateHome)
  // C1.1: dos schedulers (incluso en procesos distintos) pueden crear el DB
  // a la vez. El `timeout` del constructor no siempre cubre el DDL inicial,
  // así que se reintenta con backoff ante SQLITE_BUSY.
  const attempts = Number(process.env.AGENT_HUB_DB_INIT_RETRIES ?? 10)
  let lastError = null
  for (let i = 0; i < Math.max(1, attempts); i++) {
    let db = null
    try {
      // C1.1: timeout de busy desde el constructor para que TAMBIÉN cubra los
      // pragmas/DDL iniciales cuando dos procesos crean el DB a la vez.
      db = new SqliteDB(dbPath, { timeout: 5000 })
      db.pragma('journal_mode = WAL')
  // C1.1: dos schedulers (incluso en procesos distintos) escriben sobre el
  // mismo DB. Sin busy_timeout, better-sqlite3 falla de inmediato con
  // SQLITE_BUSY ante cualquier solape de escritura.
  db.pragma('busy_timeout = 5000')
  db.exec(SCHEMA_SQL)
  try { db.exec("ALTER TABLE workflows ADD COLUMN definition_json TEXT") } catch {}
  try { db.exec("ALTER TABLE workflows ADD COLUMN status TEXT") } catch {}
  try { db.exec("ALTER TABLE workflows ADD COLUMN updated_at TEXT") } catch {}
  try { db.exec("ALTER TABLE workflow_nodes ADD COLUMN status TEXT DEFAULT 'pending'") } catch {}
  try { db.exec("ALTER TABLE workflow_nodes ADD COLUMN attempt INTEGER DEFAULT 0") } catch {}
  try { db.exec("ALTER TABLE workflow_nodes ADD COLUMN updated_at TEXT") } catch {}
  try { db.exec("ALTER TABLE workflow_nodes ADD COLUMN claimed_by TEXT") } catch {}
  try { db.exec("ALTER TABLE workflow_nodes ADD COLUMN result_json TEXT") } catch {}
  return db
    } catch (error) {
      lastError = error
      try { db?.close() } catch {}
      const busy = error?.code === 'SQLITE_BUSY' || /database is locked/i.test(String(error?.message ?? ''))
      if (!busy || i === Math.max(1, attempts) - 1) throw error
      const delayMs = Math.min(1000, 25 * 2 ** i)
      const start = Date.now()
      while (Date.now() - start < delayMs) { /* backoff síncrono: initDb es síncrono */ }
    }
  }
  throw lastError
}

function sqliteUpsertJob(db, row) {
  db.prepare(UPSERT_JOB_SQL).run(normalizeJobRow(row))
}

function sqliteGetJob(db, jobId) {
  return db.prepare(GET_JOB_SQL).get(jobId) ?? null
}

function sqliteListJobIds(db) {
  const rows = db.prepare(LIST_JOB_IDS_SQL).all()
  return rows.map((r) => r.job_id)
}

function sqliteUpsertLease(db, row) {
  db.prepare(UPSERT_LEASE_SQL).run(normalizeLeaseRow(row))
}

function sqliteDeleteLease(db, jobId) {
  db.prepare(DELETE_LEASE_SQL).run(jobId)
}

function sqliteGetLease(db, jobId) {
  return db.prepare(GET_LEASE_SQL).get(jobId) ?? null
}

function sqliteUpsertWorkflow(db, row) {
  const norm = normalizeWorkflowRow(row)
  db.prepare(UPSERT_WORKFLOW_SQL).run({
    id: norm.id,
    name: norm.name,
    created_at: norm.created_at,
    definition_json: norm.definition_json,
    status: norm.status,
    updated_at: norm.updated_at,
  })
}

function sqliteGetWorkflow(db, id) {
  const row = db.prepare(GET_WORKFLOW_SQL).get(id)
  if (!row) return null
  return {
    ...row,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function sqliteUpsertWorkflowNode(db, row) {
  const norm = normalizeWorkflowNodeRow(row)
  db.prepare(UPSERT_WORKFLOW_NODE_SQL).run({
    workflow_id: norm.workflow_id,
    step_id: norm.step_id,
    status: norm.status,
    attempt: norm.attempt,
    updated_at: norm.updated_at,
    claimed_by: norm.claimed_by,
    result_json: norm.result_json,
  })
}

function sqliteGetWorkflowNode(db, workflowId, stepId) {
  const row = db.prepare(GET_WORKFLOW_NODE_SQL).get(workflowId, stepId)
  if (!row) return null
  return {
    ...row,
    updatedAt: row.updated_at,
  }
}

function sqliteListWorkflowNodes(db, workflowId) {
  const rows = db.prepare(LIST_WORKFLOW_NODES_SQL).all(workflowId)
  return rows.map((r) => ({
    ...r,
    updatedAt: r.updated_at,
  }))
}

function sqlitePublishWorkflowNodeReady(db, { workflowId, stepId }) {
  const now = new Date().toISOString()
  const info = db.prepare(PUBLISH_READY_SQL).run({
    workflow_id: workflowId,
    step_id: stepId,
    updated_at: now,
  })
  return info.changes > 0
}

function sqliteClaimWorkflowNode(db, { workflowId, stepId, claimedBy, attempt }) {  const now = new Date().toISOString()
  const info = db.prepare(CLAIM_WORKFLOW_NODE_SQL).run({
    workflow_id: workflowId,
    step_id: stepId,
    claimed_by: claimedBy,
    attempt: attempt ?? null,
    updated_at: now,
  })
  return info.changes > 0
}

function sqliteResumeWorkflowNode(db, { workflowId, stepId }) {
  const now = new Date().toISOString()
  const info = db.prepare(RESUME_WORKFLOW_NODE_SQL).run({
    workflow_id: workflowId,
    step_id: stepId,
    updated_at: now,
  })
  return info.changes > 0
}

function sqliteUpsertHarnessOrigin(db, row) {
  const norm = normalizeHarnessOriginRow(row)
  db.prepare(UPSERT_HARNESS_ORIGIN_SQL).run({
    job_id: norm.job_id,
    harness_session_id: norm.harness_session_id,
    harness: norm.harness,
    created_at: norm.created_at,
  })
  return norm
}

function sqliteGetHarnessOrigin(db, jobId) {
  return db.prepare(GET_HARNESS_ORIGIN_SQL).get(jobId) ?? null
}

function sqliteUpsertHandoff(db, row) {
  const norm = normalizeHandoffRow(row)
  db.prepare(UPSERT_HANDOFF_SQL).run(norm)
  return norm
}

function sqliteGetHandoff(db, workflowId, stepId) {
  return db.prepare(GET_HANDOFF_SQL).get(workflowId, stepId) ?? null
}

function sqliteListHandoffs(db, workflowId) {
  return db.prepare(LIST_HANDOFFS_SQL).all(workflowId)
}

function sqliteAddContextEntry(db, row) {
  const norm = normalizeContextRow(row)
  const info = db.prepare(ADD_CONTEXT_ENTRY_SQL).run(norm)
  return {
    id: Number(info.lastInsertRowid),
    ...norm,
  }
}

function sqliteListContextEntries(db, workflowId, stepId = null) {
  if (stepId !== null && stepId !== undefined) {
    return db.prepare(LIST_CONTEXT_ENTRIES_BY_STEP_SQL).all(workflowId, stepId)
  }
  return db.prepare(LIST_CONTEXT_ENTRIES_SQL).all(workflowId)
}

function sqliteInsertAgentMessage(db, row) {
  const norm = normalizeAgentMessageRow(row)
  const info = db.prepare(INSERT_AGENT_MESSAGE_SQL).run(norm)
  return {
    id: Number(info.lastInsertRowid),
    ...norm,
  }
}

function sqliteListAgentMessages(db, { to, rootExecutionId, unreadOnly } = {}) {
  let sql = 'SELECT * FROM agent_messages WHERE 1=1'
  const params = []
  if (to) {
    if (Array.isArray(to)) {
      if (to.length === 0) return []
      const placeholders = to.map(() => '?').join(', ')
      sql += ` AND to_agent IN (${placeholders})`
      params.push(...to)
    } else {
      sql += ' AND to_agent = ?'
      params.push(to)
    }
  }
  if (rootExecutionId) {
    sql += ' AND root_execution_id = ?'
    params.push(rootExecutionId)
  }
  if (unreadOnly) {
    sql += ' AND delivered_at IS NULL'
  }
  sql += ' ORDER BY id ASC'
  return db.prepare(sql).all(...params)
}

function sqliteMarkAgentMessageDelivered(db, id, at) {
  const atVal = at ?? new Date().toISOString()
  const info = db.prepare('UPDATE agent_messages SET delivered_at = ? WHERE id = ?').run(atVal, id)
  return info.changes > 0
}

function sqliteMarkAgentMessageAck(db, id, at) {
  const atVal = at ?? new Date().toISOString()
  const info = db.prepare('UPDATE agent_messages SET ack_at = ? WHERE id = ?').run(atVal, id)
  return info.changes > 0
}

function sqliteGetAgentMessage(db, id) {
  return db.prepare('SELECT * FROM agent_messages WHERE id = ?').get(id) ?? null
}

function sqliteReserveDispatchKey(db, { dispatchKey, jobId = null, createdAt = null } = {}) {
  const norm = normalizeDispatchReservationRow({ dispatchKey, jobId, createdAt })
  const info = db.prepare(RESERVE_DISPATCH_KEY_SQL).run(norm)
  if (info.changes === 1) {
    return { reserved: true, existingJobId: null, existingCreatedAt: null }
  }
  const existing = db.prepare(GET_DISPATCH_RESERVATION_SQL).get(dispatchKey) ?? null
  return {
    reserved: false,
    existingJobId: existing?.job_id ?? null,
    existingCreatedAt: existing?.created_at ?? null,
  }
}

function sqliteGetDispatchReservation(db, dispatchKey) {
  return db.prepare(GET_DISPATCH_RESERVATION_SQL).get(dispatchKey) ?? null
}

function sqliteReleaseDispatchReservation(db, dispatchKey) {
  const info = db.prepare(DELETE_DISPATCH_RESERVATION_SQL).run(dispatchKey)
  return info.changes > 0
}

/* ------------------------------------------------------------------ */
/*  Public API                                                         */
/* ------------------------------------------------------------------ */

/**
 * @param {string} [stateHome] - Root state directory (defaults to stateHome() in config.mjs)
 * @returns {{ db: import('better-sqlite3').Database | null, backend: 'sqlite' | 'json', stateHome: string }}
 */
export function initDb(stateHome) {
  const home = normalizeHome(stateHome)
  if (SqliteDB) {
    const db = sqliteInitDb(home)
    return { db, backend: 'sqlite', stateHome: home }
  }
  jsonInitDb(home)
  return { db: null, backend: 'json', stateHome: home }
}

/**
 * Insert or update a job row. `result_json` is the full job record as a string.
 * @param {{ db: import('better-sqlite3').Database | null, backend: 'sqlite' | 'json', stateHome?: string }} ctx
 * @param {object} row - Must include job_id; all other columns are nullable.
 */
export function upsertJob(ctx, row) {
  if (!ctx) return
  if (ctx.backend === 'sqlite') {
    sqliteUpsertJob(ctx.db, row)
  } else {
    const home = normalizeHome(ctx?.stateHome)
    jsonUpsertJob(home, row)
  }
}

/**
 * @param {{ db: import('better-sqlite3').Database | null, backend: 'sqlite' | 'json', stateHome?: string }} ctx
 * @param {string} jobId
 * @returns {object | null}
 */
export function getJob(ctx, jobId) {
  if (!ctx) return null
  if (ctx.backend === 'sqlite') {
    return sqliteGetJob(ctx.db, jobId)
  }
  const home = normalizeHome(ctx?.stateHome)
  return jsonGetJob(home, jobId)
}

/**
 * List all job IDs.
 * @param {{ db: import('better-sqlite3').Database | null, backend: 'sqlite' | 'json', stateHome?: string }} ctx
 * @returns {string[]}
 */
export function listJobIds(ctx) {
  if (!ctx) return []
  if (ctx.backend === 'sqlite') {
    return sqliteListJobIds(ctx.db)
  }
  const home = normalizeHome(ctx?.stateHome)
  return jsonListJobIds(home)
}

/**
 * Insert or update a lease row.
 * @param {{ db: import('better-sqlite3').Database | null, backend: 'sqlite' | 'json', stateHome?: string }} ctx
 * @param {{ job_id: string, owner: string, expires_at: string }} row
 */
export function upsertLease(ctx, row) {
  if (ctx.backend === 'sqlite') {
    sqliteUpsertLease(ctx.db, row)
  } else {
    const home = normalizeHome(ctx?.stateHome)
    jsonUpsertLease(home, row)
  }
}

/**
 * Delete a lease row by job_id.
 * @param {{ db: import('better-sqlite3').Database | null, backend: 'sqlite' | 'json', stateHome?: string }} ctx
 * @param {string} jobId
 */
export function deleteLease(ctx, jobId) {
  if (ctx.backend === 'sqlite') {
    sqliteDeleteLease(ctx.db, jobId)
  } else {
    const home = normalizeHome(ctx?.stateHome)
    jsonDeleteLease(home, jobId)
  }
}

/**
 * Get a lease row by job_id.
 * @param {{ db: import('better-sqlite3').Database | null, backend: 'sqlite' | 'json', stateHome?: string }} ctx
 * @param {string} jobId
 * @returns {object | null}
 */
export function getLease(ctx, jobId) {
  if (ctx.backend === 'sqlite') {
    return sqliteGetLease(ctx.db, jobId)
  }
  const home = normalizeHome(ctx?.stateHome)
  return jsonGetLease(home, jobId)
}

/**
 * Insert or update a workflow row.
 * @param {{ db: import('better-sqlite3').Database | null, backend: 'sqlite' | 'json', stateHome?: string }} ctx
 * @param {object} row
 */
export function upsertWorkflow(ctx, row) {
  if (ctx.backend === 'sqlite') {
    sqliteUpsertWorkflow(ctx.db, row)
  } else {
    const home = normalizeHome(ctx?.stateHome)
    jsonUpsertWorkflow(home, row)
  }
}

/**
 * Get a workflow row by id.
 * @param {{ db: import('better-sqlite3').Database | null, backend: 'sqlite' | 'json', stateHome?: string }} ctx
 * @param {string} id
 * @returns {object | null}
 */
export function getWorkflow(ctx, id) {
  if (ctx.backend === 'sqlite') {
    return sqliteGetWorkflow(ctx.db, id)
  }
  const home = normalizeHome(ctx?.stateHome)
  return jsonGetWorkflow(home, id)
}

/**
 * Insert or update a workflow node row.
 * @param {{ db: import('better-sqlite3').Database | null, backend: 'sqlite' | 'json', stateHome?: string }} ctx
 * @param {object} row
 */
export function upsertWorkflowNode(ctx, row) {
  if (ctx.backend === 'sqlite') {
    sqliteUpsertWorkflowNode(ctx.db, row)
  } else {
    const home = normalizeHome(ctx?.stateHome)
    jsonUpsertWorkflowNode(home, row)
  }
}

/**
 * Get a workflow node row.
 * @param {{ db: import('better-sqlite3').Database | null, backend: 'sqlite' | 'json', stateHome?: string }} ctx
 * @param {string} workflowId
 * @param {string} stepId
 * @returns {object | null}
 */
export function getWorkflowNode(ctx, workflowId, stepId) {
  if (ctx.backend === 'sqlite') {
    return sqliteGetWorkflowNode(ctx.db, workflowId, stepId)
  }
  const home = normalizeHome(ctx?.stateHome)
  return jsonGetWorkflowNode(home, workflowId, stepId)
}

/**
 * List all workflow nodes for a given workflow.
 * @param {{ db: import('better-sqlite3').Database | null, backend: 'sqlite' | 'json', stateHome?: string }} ctx
 * @param {string} workflowId
 * @returns {Array<object>}
 */
export function listWorkflowNodes(ctx, workflowId) {
  if (ctx.backend === 'sqlite') {
    return sqliteListWorkflowNodes(ctx.db, workflowId)
  }
  const home = normalizeHome(ctx?.stateHome)
  return jsonListWorkflowNodes(home, workflowId)
}

/**
 * Atomically claim a workflow node for execution (CAS).
 * @param {{ db: import('better-sqlite3').Database | null, backend: 'sqlite' | 'json', stateHome?: string }} ctx
 * @param {{ workflowId: string, stepId: string, claimedBy: string, attempt?: number }} params
 * @returns {boolean} true if claimed successfully, false if already claimed or executed
 */
export function claimWorkflowNode(ctx, { workflowId, stepId, claimedBy, attempt }) {
  if (ctx.backend === 'sqlite') {
    return sqliteClaimWorkflowNode(ctx.db, { workflowId, stepId, claimedBy, attempt })
  }
  const home = normalizeHome(ctx?.stateHome)
  return jsonClaimWorkflowNode(home, { workflowId, stepId, claimedBy, attempt })
}

/**
 * Atomically publish a pending node as ready (conditional: only from pending).
 * Never touches claimed/running rows, so it cannot clobber another
 * scheduler's claim — the CAS claim below stays the single winner gate.
 * @returns {boolean} true if the row moved pending -> ready
 */
export function publishWorkflowNodeReady(ctx, { workflowId, stepId }) {
  if (ctx.backend === 'sqlite') {
    return sqlitePublishWorkflowNodeReady(ctx.db, { workflowId, stepId })
  }
  const home = normalizeHome(ctx?.stateHome)
  return jsonPublishWorkflowNodeReady(home, { workflowId, stepId })
}

/**
 * C1.2: atomically resume a waiting node to running (conditional: only from
 * waiting). Preserves claimed_by so the scheduler holding the claim keeps
 * it — a resume never steals ownership.
 * @returns {boolean} true if the row moved waiting -> running
 */
export function resumeWorkflowNode(ctx, { workflowId, stepId }) {
  if (ctx.backend === 'sqlite') {
    return sqliteResumeWorkflowNode(ctx.db, { workflowId, stepId })
  }
  const home = normalizeHome(ctx?.stateHome)
  return jsonResumeWorkflowNode(home, { workflowId, stepId })
}

/**
 * C1.2: persist the jobId -> harness-session mapping (future bridge only;
 * nothing consumes it yet — every profile reports supportsWake=false).
 */
export function upsertHarnessOrigin(ctx, row) {
  if (ctx.backend === 'sqlite') {
    return sqliteUpsertHarnessOrigin(ctx.db, row)
  }
  const home = normalizeHome(ctx?.stateHome)
  return jsonUpsertHarnessOrigin(home, row)
}

/**
 * C1.2: read the jobId -> harness-session mapping, or null when unknown.
 */
export function getHarnessOrigin(ctx, jobId) {
  if (ctx.backend === 'sqlite') {
    return sqliteGetHarnessOrigin(ctx.db, jobId)
  }
  const home = normalizeHome(ctx?.stateHome)
  return jsonGetHarnessOrigin(home, jobId)
}

export function upsertHandoff(ctx, row) {
  if (ctx.backend === 'sqlite') {
    return sqliteUpsertHandoff(ctx.db, row)
  }
  const home = normalizeHome(ctx?.stateHome)
  return jsonUpsertHandoff(home, row)
}

export function getHandoff(ctx, workflowId, stepId) {
  if (ctx.backend === 'sqlite') {
    return sqliteGetHandoff(ctx.db, workflowId, stepId)
  }
  const home = normalizeHome(ctx?.stateHome)
  return jsonGetHandoff(home, workflowId, stepId)
}

export function listHandoffs(ctx, workflowId) {
  if (ctx.backend === 'sqlite') {
    return sqliteListHandoffs(ctx.db, workflowId)
  }
  const home = normalizeHome(ctx?.stateHome)
  return jsonListHandoffs(home, workflowId)
}

export function addContextEntry(ctx, row) {
  if (ctx.backend === 'sqlite') {
    return sqliteAddContextEntry(ctx.db, row)
  }
  const home = normalizeHome(ctx?.stateHome)
  return jsonAddContextEntry(home, row)
}

export function listContextEntries(ctx, workflowId, stepId = null) {
  if (ctx.backend === 'sqlite') {
    return sqliteListContextEntries(ctx.db, workflowId, stepId)
  }
  const home = normalizeHome(ctx?.stateHome)
  return jsonListContextEntries(home, workflowId, stepId)
}

export function insertAgentMessage(ctx, row) {
  if (!ctx) return null
  if (ctx.backend === 'sqlite') {
    return sqliteInsertAgentMessage(ctx.db, row)
  }
  const home = normalizeHome(ctx?.stateHome)
  return jsonInsertAgentMessage(home, row)
}

export function listAgentMessages(ctx, options = {}) {
  if (!ctx) return []
  if (ctx.backend === 'sqlite') {
    return sqliteListAgentMessages(ctx.db, options)
  }
  const home = normalizeHome(ctx?.stateHome)
  return jsonListAgentMessages(home, options)
}

export function markAgentMessageDelivered(ctx, id, at) {
  if (!ctx) return false
  if (ctx.backend === 'sqlite') {
    return sqliteMarkAgentMessageDelivered(ctx.db, id, at)
  }
  const home = normalizeHome(ctx?.stateHome)
  return jsonMarkAgentMessageDelivered(home, id, at)
}

export function markAgentMessageAck(ctx, id, at) {
  if (!ctx) return false
  if (ctx.backend === 'sqlite') {
    return sqliteMarkAgentMessageAck(ctx.db, id, at)
  }
  const home = normalizeHome(ctx?.stateHome)
  return jsonMarkAgentMessageAck(home, id, at)
}

/**
 * Cross-process idempotency primitive for dispatches.
 *
 * reserveDispatchKey is atomic per dispatch_key: the first caller wins and
 * every later caller gets { reserved: false } with the winning job, so a
 * dispatch cannot be started twice for the same key. Behaviour is mirrored in
 * the JSON fallback so it is identical without better-sqlite3.
 *
 * Known gap: there is no deleteLeaseByCwd helper. The leases table is keyed by
 * (job_id, owner) and has no cwd column; the worktree cwd only exists as the
 * lock file path. A cwd-keyed delete would need a schema change, so it is
 * intentionally not invented here.
 */
export function reserveDispatchKey(ctx, options = {}) {
  if (!ctx) return { reserved: false, existingJobId: null, existingCreatedAt: null }
  if (ctx.backend === 'sqlite') {
    return sqliteReserveDispatchKey(ctx.db, options)
  }
  const home = normalizeHome(ctx?.stateHome)
  return jsonReserveDispatchKey(home, options)
}

export function getDispatchReservation(ctx, dispatchKey) {
  if (!ctx) return null
  if (ctx.backend === 'sqlite') {
    return sqliteGetDispatchReservation(ctx.db, dispatchKey)
  }
  const home = normalizeHome(ctx?.stateHome)
  return jsonGetDispatchReservation(home, dispatchKey)
}

export function releaseDispatchReservation(ctx, dispatchKey) {
  if (!ctx) return false
  if (ctx.backend === 'sqlite') {
    return sqliteReleaseDispatchReservation(ctx.db, dispatchKey)
  }
  const home = normalizeHome(ctx?.stateHome)
  return jsonReleaseDispatchReservation(home, dispatchKey)
}

export function getAgentMessage(ctx, id) {
  if (!ctx) return null
  if (ctx.backend === 'sqlite') {
    return sqliteGetAgentMessage(ctx.db, id)
  }
  const home = normalizeHome(ctx?.stateHome)
  return jsonGetAgentMessage(home, id)
}

export { getDb, closeDb, resetDbInstances } from './db.mjs'

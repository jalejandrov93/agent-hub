import fs from 'node:fs'
import path from 'node:path'

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

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
}

/* ------------------------------------------------------------------ */
/*  JSON fallback                                                      */
/* ------------------------------------------------------------------ */

function jsonStoragePath(stateHome) {
  return path.join(stateHome, 'storage.json')
}

function readJsonStore(stateHome) {
  const p = jsonStoragePath(stateHome)
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'))
  } catch {
    return { workflows: {}, workflow_nodes: {}, jobs: {}, leases: {} }
  }
}

function writeJsonStore(stateHome, store) {
  const p = jsonStoragePath(stateHome)
  ensureDir(path.dirname(p))
  fs.writeFileSync(p, JSON.stringify(store, null, 2), 'utf8')
}

function jsonInitDb(stateHome) {
  ensureDir(stateHome)
  // Seed the file if missing
  const p = jsonStoragePath(stateHome)
  if (!fs.existsSync(p)) {
    writeJsonStore(stateHome, { workflows: {}, workflow_nodes: {}, jobs: {}, leases: {} })
  }
}

function jsonUpsertJob(stateHome, row) {
  const store = readJsonStore(stateHome)
  store.jobs[row.job_id] = row
  writeJsonStore(stateHome, store)
}

function jsonGetJob(stateHome, jobId) {
  const store = readJsonStore(stateHome)
  return store.jobs[jobId] ?? null
}

/* ------------------------------------------------------------------ */
/*  better-sqlite3                                                     */
/* ------------------------------------------------------------------ */

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS workflows (
  id TEXT PRIMARY KEY,
  name TEXT,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS workflow_nodes (
  workflow_id TEXT,
  step_id TEXT,
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

function sqliteInitDb(stateHome) {
  const dbPath = path.join(stateHome, 'agent-hub.db')
  ensureDir(stateHome)
  const db = new SqliteDB(dbPath)
  db.pragma('journal_mode = WAL')
  db.exec(SCHEMA_SQL)
  return db
}

function sqliteUpsertJob(db, row) {
  db.prepare(UPSERT_JOB_SQL).run(row)
}

function sqliteGetJob(db, jobId) {
  return db.prepare(GET_JOB_SQL).get(jobId) ?? null
}

/* ------------------------------------------------------------------ */
/*  Public API                                                         */
/* ------------------------------------------------------------------ */

/**
 * @param {string} stateHome - Root state directory (from stateHome() in config.mjs)
 * @returns {{ db: import('better-sqlite3').Database | null, backend: 'sqlite' | 'json' }}
 */
export function initDb(stateHome) {
  if (SqliteDB) {
    const db = sqliteInitDb(stateHome)
    return { db, backend: 'sqlite' }
  }
  jsonInitDb(stateHome)
  return { db: null, backend: 'json' }
}

/**
 * Insert or update a job row. `result_json` is the full job record as a string.
 * @param {{ db: import('better-sqlite3').Database | null, backend: 'sqlite' | 'json' }} ctx
 * @param {object} row - Must include job_id; all other columns are nullable.
 */
export function upsertJob(ctx, row) {
  if (ctx.backend === 'sqlite') {
    sqliteUpsertJob(ctx.db, row)
  } else {
    // JSON fallback: store under stateHome inferred from the ctx shape.
    // For the JSON path we store the raw row keyed by job_id.
    const storePath = jsonStoragePath(process.env.AGENT_HUB_HOME || path.join(process.env.HOME || '', '.local', 'share', 'agent-hub'))
    const stateHome = path.dirname(storePath)
    const store = readJsonStore(stateHome)
    store.jobs[row.job_id] = row
    writeJsonStore(stateHome, store)
  }
}

/**
 * @param {{ db: import('better-sqlite3').Database | null, backend: 'sqlite' | 'json' }} ctx
 * @param {string} jobId
 * @returns {object | null}
 */
export function getJob(ctx, jobId) {
  if (ctx.backend === 'sqlite') {
    return sqliteGetJob(ctx.db, jobId)
  }
  const storePath = jsonStoragePath(process.env.AGENT_HUB_HOME || path.join(process.env.HOME || '', '.local', 'share', 'agent-hub'))
  const stateHome = path.dirname(storePath)
  const store = readJsonStore(stateHome)
  return store.jobs[jobId] ?? null
}

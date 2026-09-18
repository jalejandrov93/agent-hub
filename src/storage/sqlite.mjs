import fs from 'node:fs'
import path from 'node:path'
import { stateHome as resolveStateHome, paths } from '../config.mjs'

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
  const p = jsonStoragePath(stateHome)
  if (!fs.existsSync(p)) {
    writeJsonStore(stateHome, { workflows: {}, workflow_nodes: {}, jobs: {}, leases: {} })
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

const UPSERT_LEASE_SQL = `
INSERT INTO leases (job_id, owner, expires_at)
VALUES (@job_id, @owner, @expires_at)
ON CONFLICT(job_id) DO UPDATE SET
  owner = @owner,
  expires_at = @expires_at
`

const DELETE_LEASE_SQL = `DELETE FROM leases WHERE job_id = ?`

const GET_LEASE_SQL = `SELECT * FROM leases WHERE job_id = ?`

function sqliteInitDb(stateHome) {
  const dbPath = paths({ AGENT_HUB_HOME: stateHome }).dbFile
  ensureDir(stateHome)
  const db = new SqliteDB(dbPath)
  db.pragma('journal_mode = WAL')
  db.exec(SCHEMA_SQL)
  return db
}

function sqliteUpsertJob(db, row) {
  db.prepare(UPSERT_JOB_SQL).run(normalizeJobRow(row))
}

function sqliteGetJob(db, jobId) {
  return db.prepare(GET_JOB_SQL).get(jobId) ?? null
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
  if (ctx.backend === 'sqlite') {
    return sqliteGetJob(ctx.db, jobId)
  }
  const home = normalizeHome(ctx?.stateHome)
  return jsonGetJob(home, jobId)
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

export { getDb, closeDb } from './db.mjs'

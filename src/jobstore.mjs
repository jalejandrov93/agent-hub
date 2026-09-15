import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { paths } from './config.mjs'
import { updateJsonLocked } from './fsutil.mjs'

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
}

function jobDir(jobId, env = process.env) {
  return path.join(paths(env).runsDir, jobId)
}

function resultPath(jobId, env = process.env) {
  return path.join(jobDir(jobId, env), 'result.json')
}

export function stdoutPath(jobId, env = process.env) {
  return path.join(jobDir(jobId, env), 'stdout.log')
}

/** The parsed, human-readable response text — distinct from the raw stdout.log. */
export function responsePath(jobId, env = process.env) {
  return path.join(jobDir(jobId, env), 'response.txt')
}

export function promptPath(jobId, env = process.env) {
  return path.join(jobDir(jobId, env), 'prompt.txt')
}

function newJobId() {
  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  return `${ts}-${crypto.randomBytes(4).toString('hex')}`
}

/**
 * Create a new job: allocates a jobId, writes prompt.txt and an initial
 * result.json in 'queued' state. Does not spawn anything — process.mjs owns that.
 */
export function createJob({
  agent,
  model,
  task,
  cwd,
  title,
  mode = 'read',
  timeoutS,
  timeoutSource = 'default',
  taskType = null,
  turnDepth = 0,
  learningIds = [],
  env = process.env,
  variant,
  sessionId,
  parentJobId,
}) {
  const jobId = newJobId()
  const dir = jobDir(jobId, env)
  ensureDir(dir)

  fs.writeFileSync(promptPath(jobId, env), task ?? '', 'utf8')

  const result = {
    jobId,
    agent,
    model,
    title: title ?? '',
    cwd,
    mode,
    // timeoutS is the EFFECTIVE timeout (already resolved against metrics by
    // startJob); timeoutSource records which rule produced it. taskType and
    // turnDepth drive metrics grouping and the deep-conversation warning.
    timeoutS: timeoutS ?? null,
    timeoutSource: timeoutSource ?? 'default',
    taskType: taskType ?? null,
    turnDepth: turnDepth ?? 0,
    learningIds: Array.isArray(learningIds) ? learningIds : [],
    variant: variant ?? null,
    // sessionId is the CLI's own conversation/session id, used to resume via
    // job_reply. parentJobId links a reply back to the job it continues.
    sessionId: sessionId ?? null,
    parentJobId: parentJobId ?? null,
    status: 'queued',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
  fs.writeFileSync(resultPath(jobId, env), JSON.stringify(result, null, 2), 'utf8')
  return result
}

export function readResult(jobId, env = process.env) {
  try {
    return JSON.parse(fs.readFileSync(resultPath(jobId, env), 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error(`job not found: ${jobId}`)
    throw error
  }
}

/**
 * Merge fields into result.json. Both the job runner and the dashboard's
 * cancel endpoint call this for the same job, so the read-modify-write goes
 * through updateJsonLocked (not a plain writeFileSync) to make the whole
 * sequence atomic across processes, never just the final write.
 */
export function updateResult(jobId, patch, env = process.env) {
  readResult(jobId, env) // throws `job not found: ${jobId}` if result.json does not exist
  const updatedAt = new Date().toISOString()
  return updateJsonLocked(resultPath(jobId, env), (current) => ({ ...current, ...patch, updatedAt }))
}

export function listJobs(env = process.env) {
  const { runsDir } = paths(env)
  let entries
  try {
    entries = fs.readdirSync(runsDir, { withFileTypes: true })
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }

  const jobs = []
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === '.locks') continue
    try {
      jobs.push(readResult(entry.name, env))
    } catch {
      // skip a job directory without a readable result.json
    }
  }
  jobs.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
  return jobs
}

export function appendStdout(jobId, chunk, env = process.env) {
  fs.appendFileSync(stdoutPath(jobId, env), chunk, 'utf8')
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM' // exists but owned by someone else
  }
}

/**
 * Reconcile jobs left 'running' whose pid is dead (e.g. the MCP process was
 * killed mid-job). Called on MCP startup. Returns the list of jobIds changed.
 */
export function reconcileOrphans(env = process.env) {
  const changed = []
  for (const job of listJobs(env)) {
    if (job.status !== 'running') continue
    if (job.pid && isPidAlive(job.pid)) continue
    updateResult(job.jobId, { status: 'failed', errorKind: 'orphaned', error: 'process not found on startup reconcile' }, env)
    changed.push(job.jobId)
  }
  return changed
}

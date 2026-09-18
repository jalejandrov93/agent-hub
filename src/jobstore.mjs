import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { paths } from './config.mjs'
import { updateJsonLocked } from './fsutil.mjs'

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
}

/**
 * A job id is used directly as a directory name under runs/, so it must be a
 * single safe path segment. Without this a decoded id like `../../x` (reachable
 * via GET /api/jobs/..%2F..%2Fx/result and the MCP job_* tools) would read or
 * write files outside runs/. Every exported function that accepts a jobId
 * funnels through jobDir(), so validating here rejects the whole class before
 * any filesystem call, and reports it the same way a missing job does.
 */
const JOB_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

function assertValidJobId(jobId) {
  if (typeof jobId !== 'string' || !JOB_ID_PATTERN.test(jobId) || jobId.includes('..')) {
    throw new Error(`job not found: ${jobId}`)
  }
}

function jobDir(jobId, env = process.env) {
  assertValidJobId(jobId)
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
  // C0 workflow/provenance params
  workflow_id = null,
  step_id = null,
  parent_execution_id = null,
  root_execution_id = null,
  attempt = null,
  remote_state = null,
  quality_score = null,
  verified = null,
  judge_verdict = null,
  // A1 dispatch params
  executionId = null,
  execution_id = null,
  dispatchKey = null,
  dispatch_key = null,
}) {
  const jobId = newJobId()
  const dir = jobDir(jobId, env)
  ensureDir(dir)

  fs.writeFileSync(promptPath(jobId, env), task ?? '', 'utf8')

  const resolvedExecutionId = executionId ?? execution_id ?? null
  const resolvedDispatchKey = dispatchKey ?? dispatch_key ?? null

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
    // C0 workflow/provenance fields
    workflow_id: workflow_id ?? null,
    step_id: step_id ?? null,
    parent_execution_id: parent_execution_id ?? null,
    root_execution_id: root_execution_id ?? null,
    attempt: attempt ?? null,
    remote_state: remote_state ?? null,
    quality_score: quality_score ?? null,
    verified: verified ?? null,
    judge_verdict: judge_verdict ?? null,
    // A1 dispatch provenance fields
    executionId: resolvedExecutionId,
    execution_id: resolvedExecutionId,
    dispatchKey: resolvedDispatchKey,
    dispatch_key: resolvedDispatchKey,
  }
  // Dual state: if remote_state is provided, mirror it into remote.state for compat.
  if (remote_state != null) {
    result.remote = { state: remote_state }
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
  return updateJsonLocked(resultPath(jobId, env), (current) => {
    const next = { ...current, ...patch, updatedAt }
    // cancelJob (dashboard process) and finishJob (MCP process) race: a finish
    // computed from a record read before the cancel must not resurrect the job
    // as succeeded/failed. Cancellation wins on status; everything else may
    // still merge (tokens, sessionId, costUsd, ...).
    if (current.status === 'canceled' && patch.status && patch.status !== 'canceled') {
      next.status = 'canceled'
      next.errorKind = current.errorKind
      next.error = current.error
    }
    return next
  })
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
    // A remote job (Jules) has no local pid — it runs on the provider's own
    // infrastructure and is tracked by the poller, not by a child of this
    // process. Judging it by a missing/foreign pid would wrongly mark a
    // still-progressing remote session as orphaned on every MCP restart.
    if (job.remote) continue
    if (job.pid && isPidAlive(job.pid)) continue
    updateResult(job.jobId, { status: 'failed', errorKind: 'orphaned', error: 'process not found on startup reconcile' }, env)
    changed.push(job.jobId)
  }
  return changed
}

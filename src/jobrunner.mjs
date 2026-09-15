import fs from 'node:fs'
import { spawnDetached, runWithTimeout as defaultRunWithTimeout, killProcessGroup } from './process.mjs'
import { createJob, updateResult, appendStdout, stdoutPath, responsePath, readResult } from './jobstore.mjs'
import { appendEvent } from './eventlog.mjs'
import { adapterFor as defaultAdapterFor } from './adapters/index.mjs'
import { checkWriteAllowed, acquireWriteLock, releaseWriteLock } from './worktree.mjs'
import { resolveTimeoutS, resolveVariant, KILL_GRACE_S } from './config.mjs'

// jobId -> { pgid } for jobs still running in THIS process. Used by
// cancelJob for an immediate kill; reconcileOrphans (jobstore.mjs) covers
// jobs left running by a process that died without ever calling cancelJob.
const active = new Map()

function summarize(text, max = 300) {
  if (!text) return ''
  const flat = String(text).replace(/\s+/g, ' ').trim()
  return flat.length > max ? flat.slice(0, max) + '…' : flat
}

/**
 * Start a job. Returns immediately with the queued/failed-fast job record;
 * the actual CLI run happens in the background. `done` resolves once the
 * job reaches a terminal state — tests can await it; the MCP layer polls
 * jobstore instead, which also works after a process restart.
 */
export function startJob({
  agent,
  model,
  task,
  cwd,
  mode = 'read',
  title = '',
  maxLines = 20,
  timeoutS,
  allowlist = [],
  env = process.env,
  spawn = spawnDetached,
  adapterFor = defaultAdapterFor,
  runWithTimeout = defaultRunWithTimeout,
  variant,
  sessionId,
  parentJobId,
}) {
  const effectiveVariant = resolveVariant(agent, model, variant)
  const job = createJob({ agent, model, task, cwd, title, mode, timeoutS, env, variant: effectiveVariant, sessionId, parentJobId })
  appendEvent({ kind: 'job.queued', agent, model, cwd, title, jobId: job.jobId }, { env })

  if (mode === 'write') {
    const gate = checkWriteAllowed({ cwd, allowlist })
    if (!gate.allowed) {
      updateResult(job.jobId, { status: 'failed', errorKind: 'worktree_denied', error: gate.reason }, env)
      appendEvent({ kind: 'job.failed', agent, model, cwd, title, jobId: job.jobId, errorKind: 'worktree_denied', summary: gate.reason }, { env })
      return { job: readResult(job.jobId, env), done: Promise.resolve() }
    }
    const lock = acquireWriteLock({ cwd, jobId: job.jobId, env })
    if (!lock.acquired) {
      updateResult(job.jobId, { status: 'failed', errorKind: 'locked', error: lock.reason }, env)
      appendEvent({ kind: 'job.failed', agent, model, cwd, title, jobId: job.jobId, errorKind: 'locked', summary: lock.reason }, { env })
      return { job: readResult(job.jobId, env), done: Promise.resolve() }
    }
  }

  const adapter = adapterFor(agent)
  const effectiveTimeoutS = timeoutS ?? resolveTimeoutS(agent, model)
  const argv = adapter.buildArgv({ model, prompt: task, cwd, mode, title, variant: effectiveVariant, timeoutS: effectiveTimeoutS, sessionId })

  let child
  try {
    child = spawn(adapter.cmd, argv, { cwd })
  } catch (error) {
    updateResult(job.jobId, { status: 'failed', errorKind: 'crash', error: String(error?.message ?? error) }, env)
    appendEvent({ kind: 'job.failed', agent, model, cwd, title, jobId: job.jobId, errorKind: 'crash', summary: String(error?.message ?? error) }, { env })
    if (mode === 'write') releaseWriteLock({ cwd, env })
    return { job: readResult(job.jobId, env), done: Promise.resolve() }
  }

  updateResult(job.jobId, { status: 'running', pid: child.pid, pgid: child.pid }, env)
  appendEvent({ kind: 'job.started', agent, model, cwd, title, jobId: job.jobId }, { env })
  active.set(job.jobId, { pgid: child.pid })

  // Hard-kill at timeoutS + KILL_GRACE_S, not at timeoutS itself: agy is
  // given --print-timeout <timeoutS>s (see buildArgv above) and exits on its
  // own — with a partial/empty result on stdout — when that fires. The extra
  // grace period lets that graceful, partial-output-preserving exit happen
  // before this hub SIGTERM->SIGKILLs the whole process group.
  const { exitPromise } = runWithTimeout(child, {
    timeoutMs: (effectiveTimeoutS + KILL_GRACE_S) * 1000,
    onStdout: (chunk) => appendStdout(job.jobId, chunk, env),
    onStderr: (chunk) => appendStdout(job.jobId, chunk, env),
  })

  const done = exitPromise
    .then(({ timedOut }) => finishJob({ jobId: job.jobId, agent, model, cwd, title, adapter, mode, env, timedOut }))
    .finally(() => {
      active.delete(job.jobId)
      if (mode === 'write') releaseWriteLock({ cwd, env })
    })

  return { job: readResult(job.jobId, env), done }
}

function finishJob({ jobId, agent, model, cwd, title, adapter, mode, env, timedOut }) {
  const current = readResult(jobId, env)
  if (current.status === 'canceled') return // cancelJob already finalized this job

  let stdout = ''
  try {
    stdout = fs.readFileSync(stdoutPath(jobId, env), 'utf8')
  } catch {
    // no output captured — parse/classify will treat this as empty
  }

  const error = adapter.classifyError(stdout, { timedOut })
  if (error) {
    // A print-timeout abandons the turn but agy still streamed partial text
    // (see agy.mjs classifyError) — keep it in response.txt like a normal
    // result, and persist sessionId so job_reply can resume that conversation.
    if (error.partialText) {
      try {
        fs.writeFileSync(responsePath(jobId, env), error.partialText, 'utf8')
      } catch {
        // best-effort — a failed job still gets reported even if this write fails
      }
    }
    updateResult(
      jobId,
      { status: 'failed', errorKind: error.kind, error: error.message, sessionId: error.sessionId ?? current.sessionId ?? null },
      env
    )
    appendEvent(
      { kind: 'job.failed', agent, model, cwd, title, jobId, errorKind: error.kind, summary: summarize(error.message) },
      { env }
    )
    return
  }

  const result = adapter.parseResult(stdout)
  fs.writeFileSync(responsePath(jobId, env), result.text ?? '', 'utf8')
  updateResult(
    jobId,
    {
      status: 'succeeded',
      tokens: result.tokens ?? null,
      costUsd: result.costUsd ?? null,
      sessionId: result.sessionId ?? null,
      toolDenials: result.toolDenials ?? [],
    },
    env
  )
  appendEvent(
    { kind: 'job.finished', agent, model, cwd, title, jobId, tokens: result.tokens ?? null, costUsd: result.costUsd ?? null, summary: summarize(result.text) },
    { env }
  )
}

/** Kill a running job's process group and mark it canceled. */
export async function cancelJob(jobId, { env = process.env } = {}) {
  const result = readResult(jobId, env)
  if (result.status !== 'running') {
    return result
  }

  // Mark 'canceled' BEFORE killing: killProcessGroup makes the child exit,
  // which races finishJob's own completion handler (via the same exitPromise
  // that runs the timeout ladder). finishJob checks for status:'canceled' and
  // no-ops when it sees it, so this ordering is what keeps a cancel from also
  // producing a spurious job.failed(errorKind:'empty') event for the same job.
  const updated = updateResult(jobId, { status: 'canceled', errorKind: 'canceled_by_user' }, env)

  const pgid = active.get(jobId)?.pgid ?? result.pgid
  if (pgid) {
    await killProcessGroup(pgid, {})
  }
  appendEvent(
    { kind: 'job.canceled', agent: result.agent, model: result.model, cwd: result.cwd, title: result.title, jobId },
    { env }
  )
  active.delete(jobId)
  if (result.mode === 'write') releaseWriteLock({ cwd: result.cwd, env })
  return updated
}

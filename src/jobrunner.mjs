import fs from 'node:fs'
import { spawnDetached, runWithTimeout as defaultRunWithTimeout, killProcessGroup } from './process.mjs'
import { createJob, updateResult, appendStdout, stdoutPath, responsePath, readResult } from './jobstore.mjs'
import { appendEvent } from './eventlog.mjs'
import { adapterFor as defaultAdapterFor } from './adapters/index.mjs'
import { checkWriteAllowed, acquireWriteLock, releaseWriteLock } from './worktree.mjs'
import { resolveVariant, KILL_GRACE_S } from './config.mjs'
import { resolveEffectiveTimeoutS as defaultResolveEffectiveTimeoutS } from './timeouts.mjs'
import { selectLearnings as defaultSelectLearnings, augmentTask as defaultAugmentTask } from './learnings.mjs'
import { takeSnapshot as defaultTakeSnapshot, diffSnapshots as defaultDiffSnapshots, formatViolation as defaultFormatViolation } from './readguard.mjs'
import { startRemoteJob as defaultStartRemoteJob } from './cloud/runner.mjs'

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
  taskType = null,
  turnDepth = 0,
  allowlist = [],
  env = process.env,
  spawn = spawnDetached,
  adapterFor = defaultAdapterFor,
  runWithTimeout = defaultRunWithTimeout,
  variant,
  sessionId,
  parentJobId,
  resolveEffectiveTimeoutSFn = defaultResolveEffectiveTimeoutS,
  selectLearningsFn = defaultSelectLearnings,
  augmentTaskFn = defaultAugmentTask,
  takeSnapshotFn = defaultTakeSnapshot,
  diffSnapshotsFn = defaultDiffSnapshots,
  formatViolationFn = defaultFormatViolation,
  // Jules-only fields, forwarded untouched to startRemoteJobFn for a remote
  // adapter; unused (and harmless) for every local agent.
  source,
  startingBranch,
  requirePlanApproval,
  automationMode,
  startRemoteJobFn = defaultStartRemoteJob,
  // A1 dispatch / C0 provenance fields
  dispatchKey,
  executionId,
  parentExecutionId,
  rootExecutionId,
  attempt,
  workflow_id,
  step_id,
}) {
  // Resolved BEFORE anything else — including learnings/timeout/createJob —
  // because a remote adapter (Jules) edits a branch on GitHub via its own
  // infrastructure, never this process's cwd: the "must be a secondary
  // worktree" write-mode gate and the read-mode snapshot must never run for
  // it. One side effect: an unknown agent now throws here, before any job
  // record exists (previously adapterFor ran after createJob/the write gate;
  // no existing test pinned that ordering).
  const adapter = adapterFor(agent)
  if (adapter.remote) {
    return startRemoteJobFn({
      agent,
      model,
      task,
      cwd,
      title,
      source,
      startingBranch,
      requirePlanApproval,
      automationMode,
      timeoutS,
      taskType,
      turnDepth,
      parentJobId,
      env,
      adapter,
      resolveEffectiveTimeoutSFn,
      selectLearningsFn,
      augmentTaskFn,
      dispatchKey,
      executionId,
      parentExecutionId,
      rootExecutionId,
      attempt,
      workflow_id,
      step_id,
    })
  }

  // Only a root turn (no resumed session, depth 0) gets curated learnings
  // prepended — a reply turn continues a conversation that already has them.
  const isRootTurn = !sessionId && (turnDepth ?? 0) === 0
  let effectiveTask = task
  let learningIds = []
  if (isRootTurn) {
    const selected = selectLearningsFn({ agent, model, taskType, env })
    const augmented = augmentTaskFn(task, selected)
    effectiveTask = augmented.task
    learningIds = Array.isArray(augmented.learningIds) ? augmented.learningIds : []
  }

  // Resolve the effective timeout BEFORE createJob so the record persists the
  // value actually used for the adapter and the kill timer, not the raw input.
  const { timeoutS: effectiveTimeoutS, source: timeoutSource } = resolveEffectiveTimeoutSFn({
    agent,
    model,
    mode,
    taskType,
    explicit: timeoutS,
    env,
  })
  const effectiveVariant = resolveVariant(agent, model, variant)
  const job = createJob({
    agent,
    model,
    task: effectiveTask,
    cwd,
    title,
    mode,
    timeoutS: effectiveTimeoutS,
    timeoutSource,
    taskType,
    turnDepth,
    learningIds,
    env,
    variant: effectiveVariant,
    sessionId,
    parentJobId,
    dispatchKey,
    executionId,
    parentExecutionId,
    rootExecutionId,
    attempt,
    workflow_id,
    step_id,
  })
  appendEvent({ kind: 'job.queued', agent, model, cwd, title, jobId: job.jobId, taskType }, { env })

  if (mode === 'write') {
    const gate = checkWriteAllowed({ cwd, allowlist })
    if (!gate.allowed) {
      updateResult(job.jobId, { status: 'failed', errorKind: 'worktree_denied', error: gate.reason }, env)
      appendEvent({ kind: 'job.failed', agent, model, cwd, title, jobId: job.jobId, errorKind: 'worktree_denied', taskType, summary: gate.reason }, { env })
      return { job: readResult(job.jobId, env), done: Promise.resolve() }
    }
    const lock = acquireWriteLock({ cwd, jobId: job.jobId, env })
    if (!lock.acquired) {
      updateResult(job.jobId, { status: 'failed', errorKind: 'locked', error: lock.reason }, env)
      appendEvent({ kind: 'job.failed', agent, model, cwd, title, jobId: job.jobId, errorKind: 'locked', taskType, summary: lock.reason }, { env })
      return { job: readResult(job.jobId, env), done: Promise.resolve() }
    }
  }

  const argv = adapter.buildArgv({ model, prompt: effectiveTask, cwd, mode, title, variant: effectiveVariant, timeoutS: effectiveTimeoutS, sessionId, env })

  // Snapshot right before spawning, AFTER the write gate/lock: a gate failure
  // must never be judged by a snapshot it never ran against.
  const snapshot = mode === 'read' ? takeSnapshotFn(cwd) : null

  // The local CLIs are third-party processes outside our control, and
  // JULES_API_KEY is a credential agent-hub itself introduced: it must not
  // travel to them. Nothing else is filtered.
  const childEnv = { ...process.env }
  delete childEnv.JULES_API_KEY

  let child
  try {
    child = spawn(adapter.cmd, argv, { cwd, env: childEnv })
  } catch (error) {
    updateResult(job.jobId, { status: 'failed', errorKind: 'crash', error: String(error?.message ?? error) }, env)
    appendEvent({ kind: 'job.failed', agent, model, cwd, title, jobId: job.jobId, errorKind: 'crash', taskType, summary: String(error?.message ?? error) }, { env })
    if (mode === 'write') releaseWriteLock({ cwd, env })
    return { job: readResult(job.jobId, env), done: Promise.resolve() }
  }

  updateResult(job.jobId, { status: 'running', pid: child.pid, pgid: child.pid }, env)
  appendEvent({ kind: 'job.started', agent, model, cwd, title, jobId: job.jobId, taskType }, { env })
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
    .then(({ timedOut }) => finishJob({ jobId: job.jobId, agent, model, cwd, title, adapter, mode, env, timedOut, taskType, snapshot, takeSnapshotFn, diffSnapshotsFn, formatViolationFn }))
    .finally(() => {
      active.delete(job.jobId)
      if (mode === 'write') releaseWriteLock({ cwd, env })
    })

  return { job: readResult(job.jobId, env), done }
}

function finishJob({
  jobId,
  agent,
  model,
  cwd,
  title,
  adapter,
  mode,
  env,
  timedOut,
  taskType = null,
  snapshot = null,
  takeSnapshotFn = defaultTakeSnapshot,
  diffSnapshotsFn = defaultDiffSnapshots,
  formatViolationFn = defaultFormatViolation,
}) {
  const current = readResult(jobId, env)
  if (current.status === 'canceled') return // cancelJob already finalized this job

  let stdout = ''
  try {
    stdout = fs.readFileSync(stdoutPath(jobId, env), 'utf8')
  } catch {
    // no output captured — parse/classify will treat this as empty
  }

  // A read-mode job is re-snapshotted at the terminal transition. A non-git
  // cwd produced no baseline, so the diff stays null and nothing changes.
  const diff = snapshot ? diffSnapshotsFn(snapshot, takeSnapshotFn(cwd)) : null
  const violation = diff?.changed ? formatViolationFn(diff) : null

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
    // The original failure stays the errorKind; a read-mode violation is
    // recorded alongside it rather than replacing the primary cause.
    updateResult(
      jobId,
      {
        status: 'failed',
        errorKind: error.kind,
        error: error.message,
        sessionId: error.sessionId ?? current.sessionId ?? null,
        ...(violation ? { readModeViolation: violation } : {}),
      },
      env
    )
    appendEvent(
      { kind: 'job.failed', agent, model, cwd, title, jobId, errorKind: error.kind, taskType, summary: summarize(error.message) },
      { env }
    )
    return
  }

  const result = adapter.parseResult(stdout)
  fs.writeFileSync(responsePath(jobId, env), result.text ?? '', 'utf8')

  if (violation) {
    // A "read" job that modified its worktree is a failure even though the CLI
    // succeeded. response.txt and tokens are still kept so the caller can see
    // the work that was produced.
    updateResult(
      jobId,
      {
        status: 'failed',
        errorKind: 'read_mode_violation',
        error: violation,
        tokens: result.tokens ?? null,
        costUsd: result.costUsd ?? null,
        sessionId: result.sessionId ?? null,
        toolDenials: result.toolDenials ?? [],
      },
      env
    )
    appendEvent(
      { kind: 'job.failed', agent, model, cwd, title, jobId, errorKind: 'read_mode_violation', taskType, summary: summarize(violation) },
      { env }
    )
    return
  }

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
    { kind: 'job.finished', agent, model, cwd, title, jobId, taskType, tokens: result.tokens ?? null, costUsd: result.costUsd ?? null, summary: summarize(result.text) },
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

  if (result.remote) {
    // There is no Jules API to cancel a remote session: marking the record
    // canceled above is enough — pollUntilTerminal (src/cloud/poller.mjs)
    // reads the record on its next tick and stops itself there. The session
    // on Jules' own infrastructure keeps running; only OUR polling/reporting
    // of it stops. A remote job also never acquired the local write lock (its
    // mode is 'write' but checkWriteAllowed/acquireWriteLock never ran for
    // it — see startJob's remote branch), so releaseWriteLock must not run
    // either: doing so would release a lock a concurrent LOCAL write-mode
    // job on the same cwd actually holds.
    appendEvent(
      { kind: 'job.canceled', agent: result.agent, model: result.model, cwd: result.cwd, title: result.title, jobId, taskType: result.taskType ?? null },
      { env }
    )
    active.delete(jobId)
    return updated
  }

  const pgid = active.get(jobId)?.pgid ?? result.pgid
  if (pgid) {
    await killProcessGroup(pgid, {})
  }
  appendEvent(
    { kind: 'job.canceled', agent: result.agent, model: result.model, cwd: result.cwd, title: result.title, jobId, taskType: result.taskType ?? null },
    { env }
  )
  active.delete(jobId)
  if (result.mode === 'write') releaseWriteLock({ cwd: result.cwd, env })
  return updated
}

import fs from 'node:fs'
import { createJob as defaultCreateJob, updateResult as defaultUpdateResult, readResult as defaultReadResult, responsePath } from '../jobstore.mjs'
import { appendEvent as defaultAppendEvent } from '../eventlog.mjs'
import { resolveEffectiveTimeoutS as defaultResolveEffectiveTimeoutS } from '../timeouts.mjs'
import { selectLearnings as defaultSelectLearnings, augmentTask as defaultAugmentTask } from '../learnings.mjs'
import { inferSourceFromCwd as defaultInferSourceFromCwd } from './gitContext.mjs'
import { pollUntilTerminal as defaultPollUntilTerminal } from './poller.mjs'
import * as defaultClient from './jules/client.mjs'
import * as defaultAdapter from './jules/adapter.mjs'

function summarize(text, max = 300) {
  if (!text) return ''
  const flat = String(text).replace(/\s+/g, ' ').trim()
  return flat.length > max ? flat.slice(0, max) + '…' : flat
}

/**
 * The Jules API's own session identity ('id') is preferred over parsing the
 * 'name' resource path ('sessions/abc' -> 'abc'). adapter.mjs has an
 * equivalent private helper but does not export it, so this is kept local
 * rather than reaching into its internals.
 */
function sessionIdOf(session) {
  if (typeof session?.id === 'string' && session.id.length > 0) return session.id
  const name = typeof session?.name === 'string' ? session.name : ''
  return name.startsWith('sessions/') ? name.slice('sessions/'.length) : name || 'unknown'
}

/**
 * Finish a remote job once pollUntilTerminal reaches a terminal outcome.
 * Mirrors finishJob in jobrunner.mjs: bail out when the record is already
 * canceled (cancelJob already finalized it locally — the remote session on
 * Jules is NOT stopped, so a late poll result here must never resurrect the
 * job), write response.txt through the same jobstore path finishJob uses,
 * then flip status and persist the final remote.state/prUrl.
 */
export function finishRemoteJob({
  jobId,
  outcome,
  state,
  summary,
  session,
  apiError,
  adapter,
  env = process.env,
  readResultFn = defaultReadResult,
  updateResultFn = defaultUpdateResult,
  appendEventFn = defaultAppendEvent,
}) {
  const current = readResultFn(jobId, env)
  if (current.status === 'canceled') return // cancelJob already finalized this job locally

  const responseText = adapter.buildResponseText({ session, summary })
  try {
    fs.writeFileSync(responsePath(jobId, env), responseText, 'utf8')
  } catch {
    // best-effort — a failed job still gets reported even if this write fails
  }

  const remotePatch = {
    remote: {
      ...(current.remote ?? {}),
      state: state ?? current.remote?.state ?? null,
      prUrl: summary?.prUrl ?? adapter.prUrlFromSession(session) ?? current.remote?.prUrl ?? null,
    },
  }

  if (outcome === 'completed') {
    updateResultFn(jobId, { status: 'succeeded', ...remotePatch }, env)
    appendEventFn(
      { kind: 'job.finished', agent: current.agent, model: current.model, cwd: current.cwd, title: current.title, jobId, taskType: current.taskType ?? null, summary: summarize(responseText) },
      { env }
    )
    return
  }

  const timedOut = outcome === 'timeout'
  const error = adapter.classifyError({ session, summary, timedOut, apiError }) ?? {
    kind: 'crash',
    message: 'Jules session ended without a clear outcome',
  }
  updateResultFn(jobId, { status: 'failed', errorKind: error.kind, error: error.message, ...remotePatch }, env)
  appendEventFn(
    { kind: 'job.failed', agent: current.agent, model: current.model, cwd: current.cwd, title: current.title, jobId, errorKind: error.kind, taskType: current.taskType ?? null, summary: summarize(error.message) },
    { env }
  )
}

/**
 * Start a job on the Jules remote agent. Unlike startJob (jobrunner.mjs) this
 * never spawns a local process, never touches the write-mode worktree gate,
 * lock, or read-mode snapshot — a Jules session edits a branch on GitHub via
 * Google's own infrastructure, never this process's cwd.
 *
 * Returns synchronously, like startJob: `job` reflects the queued (or
 * fail-fast) record, and `done` resolves once the remote session reaches a
 * terminal state (or fails immediately, e.g. a missing API key).
 */
export function startRemoteJob({
  agent = 'jules',
  model = 'jules',
  task,
  cwd,
  title,
  source,
  startingBranch,
  requirePlanApproval,
  automationMode,
  timeoutS,
  taskType = null,
  turnDepth = 0,
  parentJobId,
  env = process.env,
  client = defaultClient,
  adapter = defaultAdapter,
  pollFn = defaultPollUntilTerminal,
  inferSourceFn = defaultInferSourceFromCwd,
  createJobFn = defaultCreateJob,
  updateResultFn = defaultUpdateResult,
  readResultFn = defaultReadResult,
  appendEventFn = defaultAppendEvent,
  resolveEffectiveTimeoutSFn = defaultResolveEffectiveTimeoutS,
  selectLearningsFn = defaultSelectLearnings,
  augmentTaskFn = defaultAugmentTask,
}) {
  // Mirrors startJob: only a root turn gets curated learnings prepended. A
  // Jules job never resumes via a local sessionId (job_reply talks to the
  // Jules session directly — see tools/jules.mjs), so turnDepth alone decides.
  const isRootTurn = (turnDepth ?? 0) === 0
  let effectiveTask = task
  let learningIds = []
  if (isRootTurn) {
    const selected = selectLearningsFn({ agent, model, taskType, env })
    const augmented = augmentTaskFn(task, selected)
    effectiveTask = augmented.task
    learningIds = Array.isArray(augmented.learningIds) ? augmented.learningIds : []
  }

  const { timeoutS: effectiveTimeoutS, source: timeoutSource } = resolveEffectiveTimeoutSFn({
    agent,
    model,
    mode: 'write',
    taskType,
    explicit: timeoutS,
    env,
  })

  // A Jules session always edits a remote branch, so its mode is always
  // 'write' — there is no read-only Jules session.
  const job = createJobFn({
    agent,
    model,
    task: effectiveTask,
    cwd,
    title,
    mode: 'write',
    timeoutS: effectiveTimeoutS,
    timeoutSource,
    taskType,
    turnDepth,
    learningIds,
    env,
    parentJobId,
  })
  appendEventFn({ kind: 'job.queued', agent, model, cwd, title, jobId: job.jobId, taskType }, { env })

  const fail = (errorKind, message) => {
    updateResultFn(job.jobId, { status: 'failed', errorKind, error: message }, env)
    appendEventFn({ kind: 'job.failed', agent, model, cwd, title, jobId: job.jobId, errorKind, taskType, summary: summarize(message) }, { env })
  }

  const apiKey = env.JULES_API_KEY
  if (!apiKey || apiKey.length === 0) {
    fail('auth', 'JULES_API_KEY is not set — export it in the environment to delegate to Jules.')
    return { job: readResultFn(job.jobId, env), done: Promise.resolve() }
  }

  const done = (async () => {
    try {
      let resolvedSource = source
      let inferredBranch = null
      if (!resolvedSource) {
        let inferred
        try {
          inferred = await inferSourceFn(cwd)
        } catch (error) {
          fail('source_not_found', String(error?.message ?? error))
          return
        }
        resolvedSource = inferred.source
        inferredBranch = inferred.branch ?? null
      }
      const resolvedStartingBranch = startingBranch ?? inferredBranch ?? null

      let session
      try {
        const sessionArgs = adapter.buildSessionRequest({
          prompt: effectiveTask,
          source: resolvedSource,
          startingBranch: resolvedStartingBranch,
          title,
          requirePlanApproval,
          automationMode,
        })
        session = await client.createSession({ ...sessionArgs, apiKey })
      } catch (error) {
        const status = error?.status
        const errorKind = status === 429 ? 'quota' : status === 401 || status === 403 ? 'auth' : 'crash'
        fail(errorKind, String(error?.message ?? error))
        return
      }

      const sessionId = sessionIdOf(session)
      updateResultFn(
        job.jobId,
        {
          status: 'running',
          remote: {
            provider: 'jules',
            sessionId,
            sessionUrl: adapter.sessionUrl(session),
            source: resolvedSource,
            startingBranch: resolvedStartingBranch,
            state: adapter.sessionState(session),
          },
        },
        env
      )
      appendEventFn({ kind: 'job.started', agent, model, cwd, title, jobId: job.jobId, taskType }, { env })

      const pollResult = await pollFn({
        jobId: job.jobId,
        apiKey,
        sessionId,
        timeoutMs: effectiveTimeoutS * 1000,
        client,
        adapter,
        env,
      })

      finishRemoteJob({ jobId: job.jobId, ...pollResult, adapter, env, readResultFn, updateResultFn, appendEventFn })
    } catch (error) {
      // A thrown/rejected step anywhere in this chain (most notably a
      // rejected pollFn) must still resolve `done` as a normal failed job —
      // startJob callers await `done`, and letting this reject would surface
      // as an unhandled rejection instead, and leave the record 'running'.
      fail('crash', String(error?.message ?? error))
    }
  })()

  return { job: readResultFn(job.jobId, env), done }
}

import crypto from 'node:crypto'
import { route } from './router.mjs'
import { policyFor } from './policy/registry.mjs'
import { executeWithPolicy } from './policy/executor.mjs'
import { startJob } from './jobrunner.mjs'
import { createJob, listJobs, readResult } from './jobstore.mjs'
import { runPreflight, circuitBreakerOpen } from './preflight.mjs'
import { acquireWriteLock, releaseWriteLock, adoptWriteLock } from './worktree.mjs'
import { resolveEffectiveTimeoutS } from './timeouts.mjs'
import { ADAPTIVE_TIMEOUT } from './config.mjs'
import { classifyError } from './policy/taxonomy.mjs'
import { adapterFor as defaultAdapterFor } from './adapters/index.mjs'

/** Default window for deduplicating recent dispatches: 10 minutes */
export const DISPATCH_WINDOW_MS = 10 * 60 * 1000

/** In-flight map to deduplicate concurrent dispatches in this process */
const inFlightDispatches = new Map()

/** In-memory cache for recent dispatches (useful when startJob is mocked without disk persistence) */
const recentDispatches = new Map()

/**
 * Computes the deterministic dispatchKey: sha256(task+cwd+taskType+workflowStep)
 */
export function computeDispatchKey({ task, cwd, taskType, workflowStep } = {}) {
  const hash = crypto.createHash('sha256')
  hash.update(`${task ?? ''}${cwd ?? ''}${taskType ?? ''}${workflowStep ?? ''}`)
  return hash.digest('hex')
}

/**
 * Computes remote intent fingerprint for Jules reconcilation:
 * sha256(source + branch + taskHash + title + 10min window bucket)
 */
export function fingerprintRemoteIntent({
  source,
  branch,
  startingBranch,
  task,
  title,
  now = Date.now(),
  windowMs = DISPATCH_WINDOW_MS,
} = {}) {
  const resolvedBranch = branch ?? startingBranch ?? null
  const taskHash = crypto.createHash('sha256').update(String(task ?? '')).digest('hex')
  const timeBucket = Math.floor(now / windowMs)
  const hash = crypto
    .createHash('sha256')
    .update(`${source ?? ''}:${resolvedBranch ?? ''}:${taskHash}:${title ?? ''}:${timeBucket}`)
    .digest('hex')

  return {
    source: source ?? null,
    branch: resolvedBranch,
    taskHash,
    title: title ?? null,
    timeBucket,
    windowMs,
    hash,
  }
}

/**
 * Finds a matching recent Jules session in listSessions to avoid duplicate session creation.
 */
export async function findMatchingSession({
  fingerprint,
  source,
  branch,
  startingBranch,
  task,
  title,
  sessions,
  client,
  apiKey,
  env = process.env,
  listJobsFn = listJobs,
  now = Date.now(),
  windowMs = DISPATCH_WINDOW_MS,
} = {}) {
  const fp = fingerprint ?? fingerprintRemoteIntent({ source, branch, startingBranch, task, title, now, windowMs })

  let sessionList = sessions
  if (!sessionList && client?.listSessions) {
    try {
      const resp = await client.listSessions({ apiKey })
      sessionList = Array.isArray(resp?.sessions) ? resp.sessions : Array.isArray(resp) ? resp : []
    } catch {
      sessionList = []
    }
  }

  if (!Array.isArray(sessionList) || sessionList.length === 0) {
    return null
  }

  const matchingSession = sessionList.find((s) => {
    // 1. Time window check
    if (s.createTime) {
      const created = new Date(s.createTime).getTime()
      if (Math.abs(now - created) > (fp.windowMs ?? windowMs)) return false
    }

    // 2. Source check
    const sSource = s.sourceContext?.source ?? s.source
    if (fp.source && sSource && sSource !== fp.source) return false

    // 3. Branch check
    const sBranch = s.sourceContext?.githubRepoContext?.startingBranch ?? s.branch
    if (fp.branch && sBranch && sBranch !== fp.branch) return false

    // 4. Title check
    if (fp.title && s.title && s.title !== fp.title) return false

    // 5. Prompt check
    if (s.prompt && fp.taskHash) {
      const sHash = crypto.createHash('sha256').update(String(s.prompt)).digest('hex')
      if (sHash !== fp.taskHash) return false
    }

    return true
  })

  if (!matchingSession) {
    return null
  }

  const rawId = matchingSession.id ?? matchingSession.sessionId ?? matchingSession.name
  const sessionId = typeof rawId === 'string' && rawId.startsWith('sessions/') ? rawId.slice(9) : rawId

  const jobs = listJobsFn(env)
  const linkedJob = jobs.find((j) => j.remote?.sessionId === sessionId || j.sessionId === sessionId)

  return {
    session: matchingSession,
    sessionId,
    job: linkedJob ?? null,
  }
}

/**
 * Calculates effective dispatch timeout with attempt backoff (1x, 1.5x, 2x).
 */
export function calculateDispatchTimeoutS({
  agent,
  model,
  mode = 'read',
  taskType = null,
  explicit = null,
  attempt = 1,
  env = process.env,
  resolveEffectiveTimeoutSFn = resolveEffectiveTimeoutS,
} = {}) {
  const { timeoutS: baseTimeoutS } = resolveEffectiveTimeoutSFn({
    agent,
    model,
    mode,
    taskType,
    explicit,
    env,
  })

  const attemptNum = Math.max(1, attempt || 1)
  const multiplier = attemptNum === 1 ? 1 : attemptNum === 2 ? 1.5 : 2.0
  const effective = Math.round(baseTimeoutS * multiplier)

  return Math.min(ADAPTIVE_TIMEOUT.capS, effective)
}

/**
 * Searches runs for an existing recent job by dispatchKey.
 */
export function findRecentJobByDispatchKey({
  dispatchKey,
  env = process.env,
  listJobsFn = listJobs,
  windowMs = DISPATCH_WINDOW_MS,
  now = Date.now(),
} = {}) {
  const jobs = listJobsFn(env)
  const found = jobs.find((j) => {
    const key = j.dispatchKey ?? j.dispatch_key
    if (key !== dispatchKey) return false
    if (!j.createdAt) return false
    const created = new Date(j.createdAt).getTime()
    const age = now - created
    if (age < 0 || age >= windowMs) return false
    return j.status !== 'failed' && j.status !== 'canceled'
  })
  if (found) return found

  const cached = recentDispatches.get(dispatchKey)
  if (cached) {
    const age = now - cached.timestamp
    if (age >= 0 && age < windowMs) {
      return cached.job
    }
  }

  return null
}

async function isCandidateUsable(candidate, { cwd, env, runPreflightFn, circuitBreakerOpenFn }) {
  if (candidate.agent === 'claude') return true
  if (circuitBreakerOpenFn({ agent: candidate.agent, model: candidate.model, env })) return false
  try {
    const pf = await runPreflightFn({ agent: candidate.agent, model: candidate.model, cwd, env, level: 'L2' })
    if (pf?.status === 'unavailable') return false
  } catch {
    return false
  }
  return true
}

/**
 * Main dispatch entrypoint:
 * route() → primer candidato usable → policyFor() → reserva writeLock →
 * createJob con dispatchKey + executionId → executeWithPolicy → fallback automático →
 * retorna { job, dispatchKey, executionId, candidate }.
 */
export async function dispatch({
  task,
  taskType,
  cwd,
  mode = 'read',
  workflowStep = null,
  dispatchKey = null,
  attempt = 1,
  parentExecutionId = null,
  rootExecutionId = null,
  timeoutS,
  category = null,
  env = process.env,
  // Injectable dependencies
  routeFn = route,
  policyForFn = policyFor,
  executeWithPolicyFn = executeWithPolicy,
  startJobFn = startJob,
  createJobFn = createJob,
  listJobsFn = listJobs,
  readResultFn = readResult,
  runPreflightFn = runPreflight,
  circuitBreakerOpenFn = circuitBreakerOpen,
  acquireWriteLockFn = acquireWriteLock,
  releaseWriteLockFn = releaseWriteLock,
  calculateTimeoutFn = calculateDispatchTimeoutS,
  fingerprintRemoteIntentFn = fingerprintRemoteIntent,
  findMatchingSessionFn = findMatchingSession,
  nowFn = Date.now,
  adoptWriteLockFn = adoptWriteLock,
  classifyErrorFn = classifyError,
  adapterForFn = defaultAdapterFor,
  ...restDeps
} = {}) {
  const key = dispatchKey ?? computeDispatchKey({ task, cwd, taskType, workflowStep })

  // 1. Check recent runs for existing job with same dispatchKey
  const existingJob = findRecentJobByDispatchKey({
    dispatchKey: key,
    env,
    listJobsFn,
    windowMs: DISPATCH_WINDOW_MS,
    now: nowFn(),
  })
  if (existingJob) {
    return {
      job: existingJob,
      dispatchKey: key,
      executionId: existingJob.executionId ?? existingJob.execution_id ?? null,
      candidate: {
        agent: existingJob.agent,
        model: existingJob.model,
        mode: existingJob.mode,
      },
    }
  }

  // 2. Concurrency control: synchronize concurrent dispatches with the same key
  while (inFlightDispatches.has(key)) {
    await inFlightDispatches.get(key)
    const existing = findRecentJobByDispatchKey({
      dispatchKey: key,
      env,
      listJobsFn,
      windowMs: DISPATCH_WINDOW_MS,
      now: nowFn(),
    })
    if (existing) {
      return {
        job: existing,
        dispatchKey: key,
        executionId: existing.executionId ?? existing.execution_id ?? null,
        candidate: {
          agent: existing.agent,
          model: existing.model,
          mode: existing.mode,
        },
      }
    }
  }

  let releaseInFlight
  const inFlightPromise = new Promise((resolve) => {
    releaseInFlight = resolve
  })
  inFlightDispatches.set(key, inFlightPromise)

  let reservationToken = null
  let reservationAdopted = false

  try {
    const execId = `exec_${crypto.randomBytes(6).toString('hex')}`
    const rootExecId = rootExecutionId ?? execId

    // 3. Candidate discovery & TOCTOU revalidation
    let primaryCandidate = null
    let fallbackCandidates = []

    if (restDeps.candidate) {
      primaryCandidate = restDeps.candidate
      fallbackCandidates = restDeps.fallbacks ? [...restDeps.fallbacks] : []
    } else {
      const routeResult = await routeFn({ taskType, mode, env })
      if (!routeResult || !routeResult.primary) {
        throw new Error(routeResult?.reason || `No available candidate for taskType "${taskType}"`)
      }

      const allCandidates = [routeResult.primary, ...(routeResult.fallbacks || [])]
      const usableCandidates = []
      for (const c of allCandidates) {
        const usable = await isCandidateUsable(c, { cwd, env, runPreflightFn, circuitBreakerOpenFn })
        if (usable) {
          usableCandidates.push(c)
        }
      }

      if (usableCandidates.length === 0) {
        throw new Error(`Every candidate for "${taskType}" is unavailable at execution time`)
      }

      primaryCandidate = usableCandidates[0]
      fallbackCandidates = usableCandidates.slice(1)
    }

    // Helper to determine if a candidate is remote
    const isRemoteCandidate = (c) => {
      if (!c) return false
      if (c.agent === 'jules' || c.remote === true) return true
      if (restDeps.adapter?.remote === true) return true
      try {
        return Boolean(adapterForFn(c.agent)?.remote)
      } catch {
        return false
      }
    }

    const isRemote = isRemoteCandidate(primaryCandidate)

    let matchedSessionId = restDeps.sessionId ?? null

    // 4. Remote reconciliation for Jules / remote candidates
    if (primaryCandidate.agent === 'jules' || isRemote) {
      const fingerprint = fingerprintRemoteIntentFn({
        source: restDeps.source,
        branch: restDeps.startingBranch ?? restDeps.branch,
        task,
        title: restDeps.title,
        now: nowFn(),
      })

      const matched = await findMatchingSessionFn({
        fingerprint,
        source: restDeps.source,
        branch: restDeps.startingBranch ?? restDeps.branch,
        task,
        title: restDeps.title,
        now: nowFn(),
        env,
        listJobsFn,
        client: restDeps.client,
        apiKey: restDeps.apiKey,
        sessions: restDeps.sessions,
      })

      if (matched?.sessionId) {
        matchedSessionId = matched.sessionId
      } else if (matched?.session) {
        const rawId = matched.session.id ?? matched.session.sessionId ?? matched.session.name
        matchedSessionId = typeof rawId === 'string' && rawId.startsWith('sessions/') ? rawId.slice(9) : rawId
      }

      if (matched?.job) {
        const jobSessId = matched.job.remote?.sessionId ?? matched.job.sessionId
        if (jobSessId) matchedSessionId = jobSessId
        if (matched.job.status !== 'failed' && matched.job.status !== 'canceled') {
          recentDispatches.set(key, { job: matched.job, timestamp: nowFn() })
          return {
            job: matched.job,
            dispatchKey: key,
            executionId: matched.job.executionId ?? matched.job.execution_id ?? execId,
            candidate: primaryCandidate,
          }
        }
      } else if (matched?.session && !matched?.job) {
        const adoptedJob = createJobFn({
          agent: primaryCandidate.agent,
          model: primaryCandidate.model ?? 'default',
          task: task ?? matched.session.prompt ?? '',
          cwd: null,
          title: restDeps.title ?? matched.session.title ?? '',
          mode: 'write',
          remote_state: matched.session.state ?? 'IN_PROGRESS',
          sessionId: matchedSessionId,
          dispatchKey: key,
          executionId: execId,
          attempt,
          parent_execution_id: parentExecutionId,
          root_execution_id: rootExecId,
          env,
        })
        recentDispatches.set(key, { job: adoptedJob, timestamp: nowFn() })
        return {
          job: adoptedJob,
          dispatchKey: key,
          executionId: execId,
          candidate: primaryCandidate,
        }
      }
    }

    const resolvedSessionId = matchedSessionId ?? restDeps.job?.remote?.sessionId ?? restDeps.job?.sessionId ?? restDeps.sessionId ?? null

    // 5. Worktree reservation (honest reservation token)
    if (mode === 'write' && !isRemote) {
      const lock = acquireWriteLockFn({ cwd, jobId: execId, env })
      if (!lock.acquired) {
        const err = new Error(`Worktree locked: ${lock.reason}`)
        err.errorKind = 'locked'
        err.category = 'write-conflict'
        throw err
      }
      reservationToken = lock.token
    }

    // 6. Policy resolution & recovery execution
    const recoveryOrder = isRemote
      ? ['resume', 'fallback', 'retry', 'escalate']
      : ['retry', 'resume', 'fallback', 'escalate']

    const resolvePolicyForError = (err) => {
      if (category) {
        return policyForFn(category) || {
          retry: 1,
          resume: false,
          fallback: true,
          escalation: 'human',
        }
      }
      const meta = {
        errorKind: err?.errorKind ?? err?.result?.errorKind ?? err?.result?.job?.errorKind,
        status: err?.status ?? err?.statusCode ?? err?.result?.status ?? err?.result?.job?.status,
        category: err?.category ?? err?.result?.category,
      }
      const cat = classifyErrorFn(err, meta)
      const pol = cat ? policyForFn(cat) : null
      return pol || policyForFn('default') || {
        retry: 1,
        resume: false,
        fallback: true,
        escalation: 'human',
      }
    }

    const execCtx = {
      candidate: primaryCandidate,
      fallbacks: [...fallbackCandidates],
      recoveryOrder,
      sessionId: resolvedSessionId,
      policyFor: policyForFn,
      onResume: restDeps.onResume,
      onFallback: async ({ candidate }) => {
        // Ensure the candidate popped from fallbacks is still usable
        if (candidate) {
          const usable = await isCandidateUsable(candidate, { cwd, env, runPreflightFn, circuitBreakerOpenFn })
          if (!usable && execCtx.fallbacks.length > 0) {
            execCtx.candidate = execCtx.fallbacks.shift()
          }
        }
      },
      ...restDeps,
    }

    const execResult = await executeWithPolicyFn(
      async (activeCtx) => {
        const candidate = activeCtx.candidate
        const attemptNum = (activeCtx.attempt ?? 0) + (attempt || 1)

        const effectiveTimeoutS = calculateTimeoutFn({
          agent: candidate.agent,
          model: candidate.model,
          mode: candidate.mode ?? mode,
          taskType,
          explicit: timeoutS,
          attempt: attemptNum,
          env,
        })

        const startResult = await startJobFn({
          agent: candidate.agent,
          model: candidate.model,
          task,
          cwd,
          mode: candidate.mode ?? mode,
          timeoutS: effectiveTimeoutS,
          taskType,
          dispatchKey: key,
          executionId: execId,
          attempt: attemptNum,
          parentExecutionId,
          rootExecutionId: rootExecId,
          reservationToken,
          adoptWriteLockFn,
          workflow_id: restDeps.workflowId ?? restDeps.workflow_id,
          step_id: workflowStep ?? restDeps.step_id,
          sessionId: activeCtx.sessionId,
          resumed: activeCtx.resumed,
          env,
          ...restDeps,
        })

        reservationAdopted = true

        const job = startResult?.job ?? startResult
        const status = job?.status
        const error = job?.error
        const errorKind = job?.errorKind
        const currentSessionId = job?.sessionId ?? job?.remote?.sessionId ?? startResult?.sessionId ?? activeCtx.sessionId

        return {
          job,
          candidate,
          status,
          error,
          errorKind,
          sessionId: currentSessionId,
        }
      },
      resolvePolicyForError,
      execCtx
    )

    const finalJob = execResult?.job ?? execResult
    const finalCandidate = execResult?.candidate ?? primaryCandidate

    recentDispatches.set(key, { job: finalJob, timestamp: nowFn() })

    return {
      job: finalJob,
      dispatchKey: key,
      executionId: execId,
      candidate: finalCandidate,
    }
  } finally {
    if (reservationToken && !reservationAdopted) {
      try {
        releaseWriteLockFn({ cwd, token: reservationToken, env })
      } catch {}
    }
    inFlightDispatches.delete(key)
    releaseInFlight?.()
  }
}

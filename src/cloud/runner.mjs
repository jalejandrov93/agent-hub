import fs from 'node:fs'
import { createJob as defaultCreateJob, updateResult as defaultUpdateResult, readResult as defaultReadResult, listJobs as defaultListJobs, responsePath } from '../jobstore.mjs'
import { appendEvent as defaultAppendEvent } from '../eventlog.mjs'
import { resolveEffectiveTimeoutS as defaultResolveEffectiveTimeoutS } from '../timeouts.mjs'
import { selectLearnings as defaultSelectLearnings, augmentTask as defaultAugmentTask } from '../learnings.mjs'
import { inferSourceFromCwd as defaultInferSourceFromCwd } from './gitContext.mjs'
import { pollUntilTerminal as defaultPollUntilTerminal } from './poller.mjs'
import {
  listAccounts as defaultListAccounts,
  getAccountSecret as defaultGetAccountSecret,
  usageFor as defaultUsageFor,
  markAccountUsed as defaultMarkAccountUsed,
} from '../accounts.mjs'
import { selectAccount as defaultSelectAccount } from './selectAccount.mjs'
import { readSourcesCache as defaultReadSourcesCache, refreshSources as defaultRefreshSources } from './sources.mjs'
import { keyForJob, keyForAccount } from './credentials.mjs'
import * as defaultClient from './jules/client.mjs'
import * as defaultAdapter from './jules/adapter.mjs'

const TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'canceled'])

/** At most this many accounts are tried when one is exhausted by a 429. */
const MAX_ACCOUNT_ATTEMPTS = 3

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
 * Stop tracking a remote session from this process without declaring an
 * outcome. The job stays running and its last known remote state stays live,
 * because nothing here knows the session stopped.
 */
function stopPolling({ jobId, reason, current, updateResultFn, env }) {
  updateResultFn(
    jobId,
    { remote: { ...(current?.remote ?? {}), pollingStoppedAt: new Date().toISOString(), pollingStoppedReason: reason } },
    env
  )
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
  timeoutMessage,
  adapter,
  env = process.env,
  readResultFn = defaultReadResult,
  updateResultFn = defaultUpdateResult,
  appendEventFn = defaultAppendEvent,
}) {
  const current = readResultFn(jobId, env)
  if (current.status === 'canceled') return // cancelJob already finalized this job locally

  // THE INVARIANT: a remote job becomes terminal only from the remote
  // session's own state. A local deadline, a rejected key or a run of transient
  // API errors are conclusions about THIS process, not about the session —
  // violating this failed three healthy Jules sessions on one day, three
  // different ways, while each kept running on Google's side. Such outcomes
  // stop the polling and record why; jules_check finalizes the job for real
  // once the session itself ends.
  const remoteTerminal = outcome === 'completed' || state === 'COMPLETED' || state === 'FAILED' || summary?.failed === true
  if (!remoteTerminal) {
    const reason =
      outcome === 'waiting' ? 'awaiting_interaction'
      : outcome === 'timeout' ? 'local_deadline'
      : apiError?.status === 401 || apiError?.status === 403 ? 'auth'
      : apiError ? 'api_errors'
      : 'unknown'
    stopPolling({ jobId, reason, current, updateResultFn, env })
    return
  }

  const responseText = adapter.buildResponseText({ session, summary })
  try {
    fs.writeFileSync(responsePath(jobId, env), responseText, 'utf8')
  } catch {
    // best-effort — a failed job still gets reported even if this write fails
  }

  const remote = { ...(current.remote ?? {}) }
  if (state != null) {
    remote.state = state
  } else if (outcome !== 'completed') {
    // A timeout or an error-budget failure carries no fresh state. Keeping the
    // previous state would leave status:'failed' beside remote.state:
    // 'IN_PROGRESS' — two fields claiming opposite things. Preserve it under
    // lastKnownState and clear the live state so nothing says "still running".
    remote.lastKnownState = current.remote?.state ?? null
    remote.state = null
  } else {
    remote.state = current.remote?.state ?? null
  }
  remote.prUrl = summary?.prUrl ?? adapter.prUrlFromSession(session) ?? current.remote?.prUrl ?? null
  const remotePatch = { remote }

  if (outcome === 'completed') {
    updateResultFn(jobId, { status: 'succeeded', ...remotePatch }, env)
    appendEventFn(
      { kind: 'job.finished', agent: current.agent, model: current.model, cwd: current.cwd, title: current.title, jobId, taskType: current.taskType ?? null, summary: summarize(responseText) },
      { env }
    )
    return
  }

  const timedOut = outcome === 'timeout'
  let error = adapter.classifyError({ session, summary, timedOut, apiError }) ?? {
    kind: 'crash',
    message: 'Jules session ended without a clear outcome',
  }
  // A resumed job that hits its local deadline is not a failed session: the
  // remote session may simply still be running. Callers that know this pass a
  // message saying so instead of the generic "session timed out" wording.
  if (timedOut && typeof timeoutMessage === 'string' && timeoutMessage.length > 0) {
    error = { ...error, message: timeoutMessage }
  }
  updateResultFn(jobId, { status: 'failed', errorKind: error.kind, error: error.message, ...remotePatch }, env)
  appendEventFn(
    { kind: 'job.failed', agent: current.agent, model: current.model, cwd: current.cwd, title: current.title, jobId, errorKind: error.kind, taskType: current.taskType ?? null, summary: summarize(error.message) },
    { env }
  )
}

/**
 * Resolve one account+key for a delegation. When accounts.json has no accounts
 * at all, fall back to the environment JULES_API_KEY as an implicit account id
 * 'env' so an existing single-key setup keeps working untouched. `exclude`
 * holds the ids already tried by the 429 failover, so the next call picks a
 * fresh account.
 */
function selectCredential({
  explicitAccount,
  source,
  exclude,
  env,
  listAccountsFn,
  selectAccountFn,
  getAccountSecretFn,
  usageForFn,
  readSourcesCacheFn,
}) {
  if (listAccountsFn(env).length === 0) {
    // No configured accounts: keyForAccount's implicit 'env' fallback is the
    // environment key (or null), exactly as before.
    const { apiKey } = keyForAccount({ env, listAccountsFn, getAccountSecretFn })
    return apiKey ? { accountId: 'env', apiKey } : { accountId: null, apiKey: null, reason: 'no_accounts' }
  }

  const listFiltered = (targetEnv) => listAccountsFn(targetEnv).filter((account) => !exclude.includes(account.id))
  const selection = selectAccountFn({
    source,
    preferredAccountId: explicitAccount ?? null,
    env,
    listAccountsFn: listFiltered,
    usageForFn,
    readSourcesCacheFn,
  })
  if (!selection.accountId) return { accountId: null, apiKey: null, reason: selection.reason }

  const apiKey = getAccountSecretFn(selection.accountId, env)
  if (!apiKey) return { accountId: null, apiKey: null, reason: `account not found: ${selection.accountId}` }
  return { accountId: selection.accountId, apiKey }
}

/**
 * Refresh sources for every enabled account that has a key. Used once, when
 * selectCredential's first attempt fails with reason 'source_unavailable' —
 * every eligible account's cache is 'ok' but none lists the requested source.
 * That is exactly the symptom a stale cache leaves behind (see listAllSources
 * in cloud/jules/client.mjs: a single-page read used to cap a cache at the
 * API's default 30 sources of e.g. 53), so one refresh-and-retry recovers
 * without a real "no access" failure. Each refresh is independent and
 * best-effort — refreshSources already never throws for an API error, and a
 * defect in a caller-supplied refreshSourcesFn must not abort the others or
 * fail the delegation.
 */
async function refreshStaleAccountSources({ env, client, listAccountsFn, getAccountSecretFn, refreshSourcesFn }) {
  const targets = listAccountsFn(env)
    .filter((account) => account.enabled !== false)
    .map((account) => ({ accountId: account.id, apiKey: getAccountSecretFn(account.id, env) }))
    .filter((target) => target.apiKey)

  await Promise.all(
    targets.map(({ accountId, apiKey }) => Promise.resolve(refreshSourcesFn({ accountId, env, client, apiKey })).catch(() => {}))
  )
}

/**
 * The key a resumed/polled job must use comes from credentials.mjs (the single
 * source of truth): its own account when it has one, otherwise the env key.
 */

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
  account,
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
  listAccountsFn = defaultListAccounts,
  getAccountSecretFn = defaultGetAccountSecret,
  selectAccountFn = defaultSelectAccount,
  usageForFn = defaultUsageFor,
  readSourcesCacheFn = defaultReadSourcesCache,
  markAccountUsedFn = defaultMarkAccountUsed,
  refreshSourcesFn = defaultRefreshSources,
  // A1 dispatch / C0 provenance fields
  dispatchKey,
  executionId,
  parentExecutionId,
  rootExecutionId,
  attempt,
  workflow_id,
  step_id,
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
    dispatchKey,
    executionId,
    parentExecutionId,
    rootExecutionId,
    attempt,
    workflow_id,
    step_id,
  })
  appendEventFn({ kind: 'job.queued', agent, model, cwd, title, jobId: job.jobId, taskType }, { env })

  const fail = (errorKind, message) => {
    // A job canceled (or already finalized) while this async chain was in
    // flight is final: neither the status nor a job.failed event may
    // contradict it, so both the update and the event are skipped together.
    const current = readResultFn(job.jobId, env)
    if (TERMINAL_STATUSES.has(current.status)) return
    updateResultFn(job.jobId, { status: 'failed', errorKind, error: message }, env)
    appendEventFn({ kind: 'job.failed', agent, model, cwd, title, jobId: job.jobId, errorKind, taskType, summary: summarize(message) }, { env })
  }

  const configuredAccounts = listAccountsFn(env)
  if (configuredAccounts.length === 0 && !keyForAccount({ env, listAccountsFn, getAccountSecretFn }).apiKey) {
    fail('auth', 'JULES_API_KEY is not set — export it in the environment to delegate to Jules.')
    return { job: readResultFn(job.jobId, env), done: Promise.resolve() }
  }

  const done = (async () => {
    // Set once createSession succeeds: from then on the session exists on
    // Google's side, and a failure in this process no longer says anything
    // about it.
    let startedSession = false
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

      // Account selection happens here (not before createJob) because the source
      // hint is only known once cwd inference has run. A 429 does not fail the
      // job: it moves on to the next eligible account, up to MAX_ACCOUNT_ATTEMPTS.
      const attempted = []
      let apiKey = null
      let accountId = null
      let session = null
      // Never refresh more than once per delegation, even if selection keeps
      // failing with source_unavailable after the refresh already ran.
      let staleCacheRefreshed = false

      for (let attempt = 0; attempt < MAX_ACCOUNT_ATTEMPTS; attempt++) {
        let credential = selectCredential({
          explicitAccount: attempt === 0 ? account : null,
          source: resolvedSource,
          exclude: attempted,
          env,
          listAccountsFn,
          selectAccountFn,
          getAccountSecretFn,
          usageForFn,
          readSourcesCacheFn,
        })

        // Only on the first attempt, before any account has actually been
        // tried: a stale cache (every eligible account's list is 'ok' but none
        // yet includes the source) looks identical to real "no access" without
        // this recovery.
        if (
          !credential.apiKey &&
          credential.reason === 'source_unavailable' &&
          attempted.length === 0 &&
          !staleCacheRefreshed
        ) {
          staleCacheRefreshed = true
          await refreshStaleAccountSources({ env, client, listAccountsFn, getAccountSecretFn, refreshSourcesFn })
          credential = selectCredential({
            explicitAccount: attempt === 0 ? account : null,
            source: resolvedSource,
            exclude: attempted,
            env,
            listAccountsFn,
            selectAccountFn,
            getAccountSecretFn,
            usageForFn,
            readSourcesCacheFn,
          })
        }

        if (!credential.apiKey) {
          if (attempted.length > 0) {
            fail('quota', `Jules API quota exhausted (429) after trying ${attempted.length} account(s): ${attempted.join(', ')}`)
          } else {
            fail('quota', `no Jules account available: ${credential.reason}`)
          }
          return
        }

        attempted.push(credential.accountId)
        try {
          const sessionArgs = adapter.buildSessionRequest({
            prompt: effectiveTask,
            source: resolvedSource,
            startingBranch: resolvedStartingBranch,
            title,
            requirePlanApproval,
            automationMode,
          })
          session = await client.createSession({ ...sessionArgs, apiKey: credential.apiKey })
        } catch (error) {
          const status = error?.status
          if (status === 429 && attempted.length < MAX_ACCOUNT_ATTEMPTS) continue
          if (status === 429) {
            fail('quota', `Jules API quota exhausted (429) after trying ${attempted.length} account(s): ${attempted.join(', ')}`)
            return
          }
          const errorKind = status === 401 || status === 403 ? 'auth' : 'crash'
          fail(errorKind, String(error?.message ?? error))
          return
        }

        apiKey = credential.apiKey
        accountId = credential.accountId
        break
      }

      if (!session) {
        // The loop only exits without a session via a `return` above; this is a
        // defensive guard so a future edit can never fall through to polling.
        fail('quota', `Jules API quota exhausted (429) after trying ${attempted.length} account(s): ${attempted.join(', ')}`)
        return
      }

      // Only a configured account has a record to stamp; the implicit 'env'
      // account is not stored anywhere.
      if (accountId && accountId !== 'env') {
        try {
          markAccountUsedFn(accountId, env)
        } catch {
          // best-effort: a failed stamp must never fail an otherwise-started job
        }
      }

      const sessionId = sessionIdOf(session)
      startedSession = true
      updateResultFn(
        job.jobId,
        {
          status: 'running',
          remote: {
            provider: 'jules',
            accountId,
            sessionId,
            sessionUrl: adapter.sessionUrl(session),
            source: resolvedSource,
            startingBranch: resolvedStartingBranch,
            state: adapter.sessionState(session),
            // createSession can already return the PR and working branch; record
            // them now so a machine that dies before the first poll still knows
            // where Jules is working.
            branch: adapter.branchFromSession?.(session) ?? null,
            prUrl: adapter.prUrlFromSession?.(session) ?? null,
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
      // `done` must never reject: startJob callers await it, and a rejection
      // would surface as an unhandled one. Before the session exists this is a
      // genuine failure to start. After it exists, it is a failure of THIS
      // poller only, so the job keeps running with polling stopped.
      if (startedSession) {
        try {
          stopPolling({ jobId: job.jobId, reason: 'poller_error', current: readResultFn(job.jobId, env), updateResultFn, env })
        } catch {
          // best-effort: the record stays as it was, which is still running
        }
      } else {
        fail('crash', String(error?.message ?? error))
      }
    }
  })()

  return { job: readResultFn(job.jobId, env), done }
}

// Job ids being polled by resumeRemoteJobs in THIS process. A second call must
// never start a duplicate poll for the same job.
const resumingRemoteJobs = new Set()

/**
 * Re-adopt the remote (Jules) jobs left 'running' on disk after an MCP server
 * restart. reconcileOrphans deliberately skips remote jobs (they have no local
 * pid to judge), so without this a delegated cloud job would stay 'running'
 * forever with nothing tracking it — defeating the point of delegating before
 * walking away.
 *
 * Returns synchronously with a classification; any polling it starts continues
 * in the background. It never throws and never rejects, so it is safe to call
 * fire-and-forget at startup.
 */
export function resumeRemoteJobs({
  env = process.env,
  listJobsFn = defaultListJobs,
  readResultFn = defaultReadResult,
  updateResultFn = defaultUpdateResult,
  appendEventFn = defaultAppendEvent,
  client = defaultClient,
  adapter = defaultAdapter,
  pollFn = defaultPollUntilTerminal,
  nowFn = Date.now,
  finalTickTimeoutMs = 60000,
  getAccountSecretFn = defaultGetAccountSecret,
} = {}) {
  const resumed = []
  const failed = []
  const skipped = []
  // Running remote jobs this process holds no key for: left running, not failed.
  const unkeyed = []

  let jobs
  try {
    jobs = listJobsFn(env)
  } catch {
    return { resumed, failed, skipped, unkeyed }
  }

  const candidates = jobs.filter((job) => job?.status === 'running' && job?.remote?.sessionId)

  for (const job of candidates) {
    if (resumingRemoteJobs.has(job.jobId)) {
      skipped.push(job.jobId)
      continue
    }

    // A resumed job keeps polling with the account that started it, so two
    // accounts' sessions never get crossed; the environment key is only the
    // fallback for jobs that predate accounts (or were started from it).
    const apiKey = keyForJob(job, { env, getAccountSecretFn })

    if (!apiKey || apiKey.length === 0) {
      // No key in THIS process says nothing about the session, which keeps
      // running on Google's side. Failing the job here destroyed correct state
      // for real: after a restart with no key configured, three live Jules jobs
      // were marked failed(auth). Leave the record running and untouched — it
      // is recoverable, and jules_check finalizes it once a key is configured.
      unkeyed.push(job.jobId)
      continue
    }

    const createdMs = Date.parse(job.createdAt)
    const elapsedMs = Number.isFinite(createdMs) ? nowFn() - createdMs : 0
    const remainingMs = (job.timeoutS ?? 0) * 1000 - elapsedMs

    // The local deadline may already have elapsed while nothing was polling —
    // exactly the delegate-then-walk-away case this feature exists for. Do NOT
    // finalize on the local clock alone: the session very likely COMPLETED and
    // opened a pull request while nobody watched. Give pollFn a small positive
    // budget so it performs at least one getSession/listActivities round and
    // reports the real outcome; only a genuinely still-running session falls
    // through to a timeout, and then the message says so.
    const deadlineElapsed = remainingMs <= 0
    const pollTimeoutMs = deadlineElapsed ? finalTickTimeoutMs : remainingMs
    const timeoutMessage = deadlineElapsed
      ? 'Local deadline elapsed while the Jules session is still running remotely.'
      : undefined

    resumingRemoteJobs.add(job.jobId)
    resumed.push(job.jobId)

    ;(async () => {
      try {
        const pollResult = await pollFn({
          jobId: job.jobId,
          apiKey,
          sessionId: job.remote.sessionId,
          timeoutMs: pollTimeoutMs,
          client,
          adapter,
          env,
        })
        finishRemoteJob({ jobId: job.jobId, ...pollResult, timeoutMessage, adapter, env, readResultFn, updateResultFn, appendEventFn })
      } catch (error) {
        // A rejected poll must not reject resumeRemoteJobs (nobody awaits it) —
        // mark the job failed unless it is already terminal.
        const message = String(error?.message ?? error)
        try {
          const current = readResultFn(job.jobId, env)
          if (!TERMINAL_STATUSES.has(current.status)) {
            updateResultFn(job.jobId, { status: 'failed', errorKind: 'crash', error: message }, env)
            appendEventFn(
              { kind: 'job.failed', agent: job.agent, model: job.model, cwd: job.cwd, title: job.title, jobId: job.jobId, errorKind: 'crash', taskType: job.taskType ?? null, summary: summarize(message) },
              { env }
            )
          }
        } catch {
          // best-effort — a poll rejection must never take the process down
        }
      } finally {
        resumingRemoteJobs.delete(job.jobId)
      }
    })()
  }

  return { resumed, failed, skipped, unkeyed }
}

import { startRemoteJob as defaultStartRemoteJob } from '../cloud/runner.mjs'
import { checkRemoteSession as defaultCheckRemoteSession } from '../cloud/check.mjs'
import { listJobs as defaultListJobs, readResult as defaultReadResult, updateResult as defaultUpdateResult } from '../jobstore.mjs'
import { listSchedules as defaultListSchedules } from '../schedules.mjs'
import {
  listAccounts as defaultListAccounts,
  getAccountSecret as defaultGetAccountSecret,
  usageFor as defaultUsageFor,
  readPolicy as defaultReadPolicy,
} from '../accounts.mjs'
import { readSourcesCache as defaultReadSourcesCache } from '../cloud/sources.mjs'
import { keyForJob, keyForAccount } from '../cloud/credentials.mjs'
import * as defaultClient from '../cloud/jules/client.mjs'
import { listAllSources } from '../cloud/jules/client.mjs'
import * as defaultAdapter from '../cloud/jules/adapter.mjs'
import { julesSuperviseTool } from '../cloud/jules/supervisor.mjs'
import { bestEffortResumeWorkflowNode } from '../workflow/resume.mjs'
import { TASK_TYPES } from '../schemas.mjs'

/** Reject a caller-supplied taskType that is not one of schemas.mjs TASK_TYPES (mirrors tools/jobs.mjs). */
function assertTaskType(taskType) {
  if (taskType != null && !TASK_TYPES.includes(taskType)) {
    throw new Error(`unknown taskType: ${taskType}`)
  }
}

/**
 * Start a Jules session. Returns the same {jobId, status, errorKind} shape as
 * delegateTool (tools/jobs.mjs), so job_status/job_wait/job_result keep
 * working unchanged for a Jules job. Unlike delegateTool this never touches
 * the local worktree — startRemoteJob (src/cloud/runner.mjs) resolves the
 * GitHub source and edits a remote branch via the Jules API.
 */
export async function julesDelegateTool({
  task,
  cwd,
  source,
  startingBranch,
  title,
  requirePlanApproval,
  automationMode,
  timeoutS,
  taskType,
  account,
  env = process.env,
  startRemoteJobFn = defaultStartRemoteJob,
}) {
  assertTaskType(taskType)
  if (!cwd && !source) {
    throw new Error('jules_delegate requires either cwd (to infer the GitHub source from) or an explicit source')
  }

  const { job } = await startRemoteJobFn({
    agent: 'jules',
    model: 'jules',
    task,
    cwd,
    source,
    startingBranch,
    title,
    requirePlanApproval,
    automationMode,
    timeoutS,
    taskType,
    account,
    turnDepth: 0,
    env,
  })
  return { jobId: job.jobId, status: job.status, errorKind: job.errorKind ?? null }
}

/**
 * One live read of a Jules session: the answer to "did it finish, what came
 * out, and which branch is it on", with no local poller required. Thin wrapper
 * so the transport stays in check.mjs (src/cloud/check.mjs) and this stays
 * trivially mockable.
 */
export async function julesCheckTool({ jobId, sessionId, env = process.env, client = defaultClient, checkRemoteSessionFn = defaultCheckRemoteSession, ...rest } = {}) {
  return checkRemoteSessionFn({ jobId, sessionId, env, client, ...rest })
}

// Matches the id runner.mjs persists in remote.sessionId (id first, then the
// 'sessions/' resource name) so a local job can be matched back to a session.
function sessionIdOf(session) {
  if (typeof session?.id === 'string' && session.id.length > 0) return session.id
  const name = typeof session?.name === 'string' ? session.name : ''
  if (name.length > 0) return name.startsWith('sessions/') ? name.slice('sessions/'.length) : name
  return null
}

/**
 * List the account's Jules sessions straight from the API, newest first, and
 * annotate each with the local jobId whose remote.sessionId matches (null when
 * this machine has no record — a reinstall, or a session started elsewhere).
 *
 * Sessions belong to ONE account, so a single key only shows part of the
 * picture once several are configured: with no explicit `account`, every
 * enabled account that has a key is queried in parallel and the rows are
 * merged. One account failing must not hide the others, so its error is
 * reported in `accountErrors` beside the sessions that did come back.
 */
export async function julesSessionsTool({
  limit = 20,
  state,
  account,
  env = process.env,
  client = defaultClient,
  listJobsFn = defaultListJobs,
  adapter = defaultAdapter,
  listAccountsFn = defaultListAccounts,
  getAccountSecretFn = defaultGetAccountSecret,
} = {}) {
  const jobIdBySession = new Map()
  try {
    for (const job of listJobsFn(env)) {
      const sessionId = job?.remote?.sessionId
      if (sessionId && !jobIdBySession.has(sessionId)) jobIdBySession.set(sessionId, job.jobId)
    }
  } catch {
    // No local job history (fresh install, unreadable runs dir): every session
    // still comes back, just with jobId:null.
  }

  const toRows = (page, accountId) => {
    const sessions = Array.isArray(page?.sessions) ? page.sessions : []
    return sessions
      .filter((session) => (state ? adapter.sessionState(session) === state : true))
      .map((session) => {
        const sessionId = sessionIdOf(session)
        const row = {
          sessionId,
          title: typeof session?.title === 'string' && session.title.length > 0 ? session.title : null,
          state: adapter.sessionState(session),
          prUrl: adapter.prUrlFromSession(session),
          branch: adapter.branchFromSession(session),
          sessionUrl: adapter.sessionUrl(session),
          createTime: typeof session?.createTime === 'string' && session.createTime.length > 0 ? session.createTime : null,
          jobId: sessionId ? jobIdBySession.get(sessionId) ?? null : null,
        }
        if (accountId) row.accountId = accountId
        return row
      })
  }

  const merge = (rows) =>
    rows
      .sort((a, b) => (b.createTime ?? '').localeCompare(a.createTime ?? ''))
      .slice(0, limit)

  const queryOne = async (apiKey) => {
    try {
      return await client.listSessions({ apiKey, pageSize: limit })
    } catch (error) {
      if (error?.status === 401 || error?.status === 403) throw new Error('JULES_API_KEY is missing or rejected')
      throw error
    }
  }

  // An explicit account is an answer to "whose sessions?" — query only it, and
  // let a failure surface instead of silently returning nothing.
  if (account) {
    const apiKey = getAccountSecretFn(account, env)
    if (!apiKey) throw new Error(`account not found: ${account}`)
    const page = await queryOne(apiKey)
    return { sessions: merge(toRows(page, account)), accountErrors: [] }
  }

  const entries = listAccountsFn(env)
    .filter((candidate) => candidate.enabled !== false)
    .sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0))
    .map((candidate) => ({ accountId: candidate.id, apiKey: getAccountSecretFn(candidate.id, env) }))
    .filter((entry) => entry.apiKey)

  // No configured account has a key: behave exactly as before, env-only, with
  // errors propagating the way they always did.
  if (entries.length === 0) {
    const fallback = keyForAccount({ env, listAccountsFn, getAccountSecretFn })
    if (!fallback.apiKey) throw new Error('JULES_API_KEY is missing or rejected')
    const page = await queryOne(fallback.apiKey)
    return { sessions: merge(toRows(page, null)) }
  }

  const results = await Promise.all(
    entries.map(async (entry) => {
      try {
        return { rows: toRows(await client.listSessions({ apiKey: entry.apiKey, pageSize: limit }), entry.accountId) }
      } catch (error) {
        // Keep the raw message (it names the status) — this is one account's
        // failure, not a statement about the whole call.
        return { error: { accountId: entry.accountId, error: String(error?.message ?? error) } }
      }
    })
  )

  return {
    sessions: merge(results.flatMap((result) => result.rows ?? [])),
    accountErrors: results.map((result) => result.error).filter(Boolean),
  }
}

// The one shape the Jules alpha API pins down for a source is its resource
// name, 'sources/github/{owner}/{repo}' — githubRepo is an observed-in-the-
// wild convenience field, not a documented guarantee, so it is only ever a
// preferred value, never the sole source of owner/repo.
function ownerRepoFromName(name) {
  const match = typeof name === 'string' ? name.match(/^sources\/github\/([^/]+)\/(.+)$/) : null
  return match ? { owner: match[1], repo: match[2] } : { owner: null, repo: null }
}

/**
 * List the GitHub repos connected to a Jules account. Sources are connected in
 * the Jules web UI — there is no API to add one.
 *
 * With no `account` and no accounts configured this behaves exactly as before
 * (the JULES_API_KEY environment variable). With accounts configured it defaults to the
 * highest-priority enabled account. A 401/403 from /sources is reported as
 * "this account has no source access", never as a rejected key: a valid,
 * usable key was observed being refused by /sources while /sessions worked.
 */
export async function julesSourcesTool({
  account,
  env = process.env,
  client = defaultClient,
  fetchImpl,
  listAccountsFn = defaultListAccounts,
  getAccountSecretFn = defaultGetAccountSecret,
} = {}) {
  const { apiKey, accountId } = keyForAccount({ account, env, listAccountsFn, getAccountSecretFn })
  if (account && !apiKey) throw new Error(`account not found: ${account}`)
  if (!apiKey) {
    throw new Error('JULES_API_KEY is missing or rejected')
  }
  // 'env' is the implicit account, not a configured one — never report it as an
  // accountId (this keeps the pre-accounts output byte-for-byte unchanged).
  const scopedAccountId = accountId && accountId !== 'env' ? accountId : null

  let page
  try {
    // Page through the full source list — the API defaults pageSize to 30
    // (max 100), so a single-page read only ever saw the first 30 repos.
    page = await listAllSources(client, { apiKey, fetchImpl })
  } catch (error) {
    if (error?.status === 401 || error?.status === 403) {
      if (scopedAccountId) {
        return {
          sources: [],
          accountId: scopedAccountId,
          noSourceAccess: true,
          note:
            `Account ${scopedAccountId} has no source access: the Jules API refused /sources with ${error.status}. ` +
            'This is not a credential failure — repositories are connected in the Jules web UI (jules.google.com).',
        }
      }
      throw new Error('JULES_API_KEY is missing or rejected')
    }
    throw error
  }

  const sources = Array.isArray(page?.sources) ? page.sources : []
  const result = {
    sources: sources.map((s) => {
      const fallback = ownerRepoFromName(s?.name)
      const githubRepo = s?.githubRepo
      const defaultBranchName = githubRepo?.defaultBranch?.displayName
      return {
        name: s?.name ?? null,
        owner: githubRepo?.owner ?? fallback.owner,
        repo: githubRepo?.repo ?? fallback.repo,
        defaultBranch:
          typeof defaultBranchName === 'string' && defaultBranchName.length > 0 ? defaultBranchName : null,
        branches: Array.isArray(githubRepo?.branches)
          ? githubRepo.branches.map((branch) => branch?.displayName).filter((name) => typeof name === 'string' && name.length > 0)
          : [],
      }
    }),
  }
  if (scopedAccountId) result.accountId = scopedAccountId
  return result
}

/**
 * Read-only view of the configured accounts for the dashboard/MCP: masked
 * accounts (never the raw key) with their live quota usage and last /sources
 * cache status. Creating/editing accounts belongs to the dashboard, so there is
 * deliberately no write tool here.
 */
export function julesAccountsTool({
  env = process.env,
  listAccountsFn = defaultListAccounts,
  usageForFn = defaultUsageFor,
  readSourcesCacheFn = defaultReadSourcesCache,
  readPolicyFn = defaultReadPolicy,
} = {}) {
  const cache = readSourcesCacheFn(env)
  return {
    policy: readPolicyFn(env),
    accounts: listAccountsFn(env).map((account) => ({
      ...account,
      usage: usageForFn(account.id, env),
      sourcesStatus: cache[account.id]?.status ?? null,
      sourcesFetchedAt: cache[account.id]?.fetchedAt ?? null,
    })),
  }
}

/**
 * Read-only view of the recurring Jules tasks: each schedule with its next run
 * and the outcome of the job it started last time. Creating and editing
 * schedules belongs to the dashboard, so there is deliberately no write tool.
 */
export function julesSchedulesTool({
  env = process.env,
  listSchedulesFn = defaultListSchedules,
  readResultFn = defaultReadResult,
} = {}) {
  return {
    schedules: listSchedulesFn(env).map((schedule) => {
      let lastResult = null
      if (schedule.lastJobId) {
        try {
          const job = readResultFn(schedule.lastJobId, env)
          lastResult = {
            jobId: job.jobId,
            status: job.status,
            errorKind: job.errorKind ?? null,
            sessionId: job.remote?.sessionId ?? null,
            prUrl: job.remote?.prUrl ?? null,
          }
        } catch {
          // The job record is gone (pruned runs dir): the schedule still shows,
          // just without a last result.
          lastResult = null
        }
      }
      return { ...schedule, lastResult }
    }),
  }
}

/**
 * Single implementation of a Jules interaction (reply / approve_plan),
 * shared by jules_interact, job_reply on a Jules parent, and the future
 * supervisor. One implementation means one place for reply/approve_plan
 * semantics, counter updates and policy accounting.
 *
 * Model A (confirmed): this only modifies the remote session plus local
 * counters. It NEVER clears pollingStoppedReason (a null reason means
 * "polling active", and no watcher exists here) and NEVER restarts a
 * poller — only an observation that sees a non-waiting state
 * (jules_wait/supervisor/jules_check, or a poller tick) may clear it.
 */
export async function interactWithSession({
  jobId,
  sessionId,
  action,
  message,
  feedbackDecision,
  env = process.env,
  client = defaultClient,
  listJobsFn = defaultListJobs,
  readResultFn = defaultReadResult,
  updateResultFn = defaultUpdateResult,
  listAccountsFn = defaultListAccounts,
  getAccountSecretFn = defaultGetAccountSecret,
} = {}) {
  if (action === 'pause' || action === 'resume' || action === 'cancel') {
    throw new Error(`Jules API does not support remote ${action} (no remote pause, resume, or cancel endpoints exist)`)
  }

  if (action !== 'reply' && action !== 'approve_plan') {
    throw new Error(`Invalid action "${action}": only "reply" and "approve_plan" are supported. Remote pause, resume, and cancel are not supported.`)
  }

  if (action === 'reply' && (!message || String(message).trim().length === 0)) {
    throw new Error('message is required for action "reply"')
  }

  if (!jobId && !sessionId) {
    throw new Error('jules_interact requires either jobId or sessionId')
  }

  let resolvedJobId = jobId ?? null
  let resolvedSessionId = sessionId ?? null
  let resolvedJob = null

  if (jobId) {
    const record = readResultFn(jobId, env)
    const recorded = record?.remote?.sessionId
    if (!recorded && !sessionId) {
      throw new Error(`job ${jobId} has no Jules session recorded`)
    }
    resolvedSessionId = sessionId ?? recorded
    resolvedJob = record
  } else {
    let jobs = []
    try {
      jobs = listJobsFn(env)
    } catch {
      // ignore
    }
    const match = Array.isArray(jobs) ? jobs.find((job) => job?.remote?.sessionId === resolvedSessionId) : null
    if (match) {
      resolvedJobId = match.jobId
      resolvedJob = match
    }
  }

  const apiKey = resolvedJob
    ? keyForJob(resolvedJob, { env, getAccountSecretFn })
    : keyForAccount({ env, listAccountsFn, getAccountSecretFn }).apiKey

  if (!apiKey || apiKey.length === 0) {
    throw new Error('JULES_API_KEY is missing or rejected')
  }

  if (action === 'approve_plan') {
    await client.approvePlan({ apiKey, sessionId: resolvedSessionId })
  } else {
    await client.sendMessage({ apiKey, sessionId: resolvedSessionId, prompt: message })
  }

  if (resolvedJobId) {
    try {
      const current = readResultFn(resolvedJobId, env)
      const currentRemote = current?.remote ?? {}
      // attempts stays incremented for existing records/consumers, but the
      // semantic counters below are what policies must read: turnDepth is
      // conversation depth and is deliberately NOT bumped here, so a plan
      // approval never consumes the auto-reply budget (maxAutoReplies).
      // pollingStoppedReason is deliberately NOT cleared: no watcher exists
      // after this call (Model A), so null would falsely claim polling is
      // active. The next observation that sees a non-waiting state clears it.
      const newAttempts = (currentRemote.attempts ?? current?.turnDepth ?? 0) + 1
      const isSafeContinue = feedbackDecision === 'safe_continue'
      const isAutoReply = action === 'reply' && !isSafeContinue
      updateResultFn(
        resolvedJobId,
        {
          remote: {
            ...currentRemote,
            attempts: newAttempts,
            interventionCount: (currentRemote.interventionCount ?? 0) + 1,
            autoReplyCount: (currentRemote.autoReplyCount ?? 0) + (isAutoReply ? 1 : 0),
            safeContinueCount: (currentRemote.safeContinueCount ?? 0) + (isSafeContinue ? 1 : 0),
            planApprovalCount: (currentRemote.planApprovalCount ?? 0) + (action === 'approve_plan' ? 1 : 0),
          },
        },
        env
      )
    } catch {
      // best-effort
    }
  }

  return {
    jobId: resolvedJobId,
    sessionId: resolvedSessionId,
    action,
    status: 'ok',
    success: true,
  }
}

/**
 * MCP tool wrapper around interactWithSession (same behavior, MCP defaults).
 * C1.2: after a successful interaction, best-effort resume of a parked
 * WAITING workflow node (WAITING -> RUNNING) — never fails the interaction.
 */
export async function julesInteractTool(args = {}) {
  const res = await interactWithSession({
    env: process.env,
    client: defaultClient,
    listJobsFn: defaultListJobs,
    readResultFn: defaultReadResult,
    updateResultFn: defaultUpdateResult,
    listAccountsFn: defaultListAccounts,
    getAccountSecretFn: defaultGetAccountSecret,
    ...args,
  })
  const jobId = args?.jobId ?? res?.jobId ?? null
  if (jobId) {
    try { bestEffortResumeWorkflowNode(jobId, { env: args?.env ?? process.env }) } catch {}
  }
  return res
}

/**
 * Local helper (not an MCP tool): poll with a local timeout waiting for a terminal
 * state (COMPLETED, FAILED) or a waiting state (AWAITING_*, PAUSED).
 */
export async function julesWait({
  jobId,
  sessionId,
  timeoutMs,
  timeoutS = 30,
  intervalMs = 2000,
  env = process.env,
  client = defaultClient,
  adapter = defaultAdapter,
  checkRemoteSessionFn = defaultCheckRemoteSession,
  sleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  nowFn = Date.now,
  readResultFn = defaultReadResult,
  listJobsFn = defaultListJobs,
  finishRemoteJobFn,
  updateResultFn,
} = {}) {
  const effectiveTimeoutMs = timeoutMs ?? (timeoutS * 1000)
  const start = nowFn()

  // Resolve the jobId for watch lease checking
  let resolvedJobId = jobId ?? null
  if (!resolvedJobId && sessionId) {
    let jobs = []
    try { jobs = listJobsFn(env) } catch { /* ignore */ }
    const match = Array.isArray(jobs) ? jobs.find((j) => j?.remote?.sessionId === sessionId) : null
    if (match) resolvedJobId = match.jobId
  }

  while (true) {
    // B4 watch lease: when another owner (e.g. 'supervisor') holds the watch,
    // observe read-only — no finalization, no state mutation. The supervisor
    // owns the interaction lifecycle and will finalize when it's done.
    let effectiveFinishRemoteJobFn = finishRemoteJobFn
    let effectiveUpdateResultFn = updateResultFn

    if (resolvedJobId) {
      try {
        const record = readResultFn(resolvedJobId, env)
        const watch = record?.remote?.watch
        if (watch?.owner != null && watch.owner !== 'jules_wait') {
          // Foreign lease active — wrap check to be read-only
          effectiveFinishRemoteJobFn = () => {}
          effectiveUpdateResultFn = () => {}
        }
      } catch { /* no record — proceed normally */ }
    }

    const check = await checkRemoteSessionFn({
      jobId,
      sessionId,
      env,
      client,
      adapter,
      enrich: true,
      readResultFn,
      listJobsFn,
      ...(effectiveFinishRemoteJobFn !== undefined ? { finishRemoteJobFn: effectiveFinishRemoteJobFn } : {}),
      ...(effectiveUpdateResultFn !== undefined ? { updateResultFn: effectiveUpdateResultFn } : {}),
    })
    const state = check.state
    const terminal = adapter.isTerminalState(state)
    const waiting = adapter.isWaitingState?.(state) || (typeof state === 'string' && (state.startsWith('AWAITING_') || state === 'PAUSED'))

    if (terminal || waiting) {
      return {
        ...check,
        done: true,
        terminal,
        waiting,
        timedOut: false,
      }
    }

    const elapsed = nowFn() - start
    if (elapsed >= effectiveTimeoutMs) {
      return {
        ...check,
        done: false,
        terminal: false,
        waiting: false,
        timedOut: true,
      }
    }

    const sleepTime = Math.min(intervalMs, effectiveTimeoutMs - elapsed)
    await sleepFn(sleepTime)
  }
}

export { julesSuperviseTool }
export const jules_supervise = julesSuperviseTool
export const jules_wait = julesWait

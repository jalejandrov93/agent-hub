import { listJobs as defaultListJobs, readResult as defaultReadResult, updateResult as defaultUpdateResult } from '../jobstore.mjs'
import { getAccountSecret as defaultGetAccountSecret } from '../accounts.mjs'
import { appendEvent as defaultAppendEvent } from '../eventlog.mjs'
import { finishRemoteJob as defaultFinishRemoteJob } from './runner.mjs'
import * as defaultClient from './jules/client.mjs'
import * as defaultAdapter from './jules/adapter.mjs'

/**
 * Activities arrive oldest-first, so a session that outlived the machine has
 * more than one page and the newest state hides on the last one. Draining is
 * still a single bounded read: no sleeping or backoff, and the cap stops a
 * server that keeps echoing the same nextPageToken from hanging the call.
 */
export const ACTIVITY_PAGE_CAP = 10

async function collectActivities({ client, apiKey, sessionId, pageSize }) {
  const activities = []
  let pageToken
  for (let page = 0; page < ACTIVITY_PAGE_CAP; page++) {
    const result = await client.listActivities({
      apiKey,
      sessionId,
      pageSize,
      ...(pageToken ? { pageToken } : {}),
    })
    const pageActivities = Array.isArray(result?.activities) ? result.activities : []
    activities.push(...pageActivities)
    pageToken = result?.nextPageToken
    // An empty page means the token is not advancing; stop rather than spin.
    if (!pageToken || pageActivities.length === 0) break
  }
  return activities
}

/**
 * Answer "what did that Jules session do?" with a single live read.
 *
 * A Jules session runs on Google's servers, so this process may have been dead
 * for days when the user asks. This is deliberately NOT a poll loop: it makes
 * one getSession plus a bounded drain of listActivities and returns, so it works
 * after a reboot with no poller, backoff or sleeping involved.
 *
 * A jobId names its own local record; a bare sessionId may still have one (the
 * job_result recovery path), so it is matched against remote.sessionId. When a
 * local job is found and its session is terminal while the job is still
 * 'running', finishRemoteJob finalizes it so the job stops being 'running'
 * forever and job_result returns the real answer.
 */
export async function checkRemoteSession({
  jobId,
  sessionId,
  env = process.env,
  client = defaultClient,
  adapter = defaultAdapter,
  listJobsFn = defaultListJobs,
  readResultFn = defaultReadResult,
  updateResultFn = defaultUpdateResult,
  appendEventFn = defaultAppendEvent,
  finishRemoteJobFn = defaultFinishRemoteJob,
  getAccountSecretFn = defaultGetAccountSecret,
  activityPageSize = 100,
} = {}) {
  if (!jobId && !sessionId) {
    throw new Error('checkRemoteSession requires a jobId or a sessionId')
  }

  let resolvedJobId = jobId ?? null
  let resolvedSessionId = sessionId ?? null
  let resolvedAccountId = null

  if (jobId) {
    const record = readResultFn(jobId, env)
    const recorded = record?.remote?.sessionId
    if (!recorded) throw new Error(`job ${jobId} has no Jules session recorded`)
    resolvedSessionId = sessionId ?? recorded
    resolvedAccountId = record?.remote?.accountId ?? null
  } else {
    // A bare sessionId is not a jobId, but this machine may still hold the job
    // that started it — look it up so the caller gets a jobId to finalize and,
    // with it, the account that owns the session.
    let jobs = []
    try {
      jobs = listJobsFn(env)
    } catch {
      // A broken runs dir must never turn a read-only check into a failure.
    }
    const match = Array.isArray(jobs) ? jobs.find((job) => job?.remote?.sessionId === resolvedSessionId) : null
    if (match) {
      resolvedJobId = match.jobId
      resolvedAccountId = match.remote?.accountId ?? null
    }
  }

  // Poll with the account that started the session; only a job with no recorded
  // account (or the implicit 'env' account) falls back to env.JULES_API_KEY.
  let apiKey = null
  if (resolvedAccountId && resolvedAccountId !== 'env') apiKey = getAccountSecretFn(resolvedAccountId, env)
  if (!apiKey || apiKey.length === 0) apiKey = env.JULES_API_KEY
  if (!apiKey || apiKey.length === 0) {
    throw new Error('JULES_API_KEY is not set — set it in the environment to check a Jules session.')
  }

  const session = await client.getSession({ apiKey, sessionId: resolvedSessionId })
  const activities = await collectActivities({
    client,
    apiKey,
    sessionId: resolvedSessionId,
    pageSize: activityPageSize,
  })
  const summary = adapter.summarizeActivities(activities)

  const state = adapter.sessionState(session)
  const prUrl = summary?.prUrl ?? adapter.prUrlFromSession(session) ?? null
  const branch = adapter.branchFromSession(session) ?? null
  const sessionUrl = adapter.sessionUrl(session)
  const lastMessage = summary?.lastAgentMessage ?? null
  const terminal = adapter.isTerminalState(state)

  let finalized = false
  if (resolvedJobId) {
    const current = readResultFn(resolvedJobId, env)
    const currentRemote = current?.remote ?? {}
    // Only a real state string is fresh; the adapter's 'UNKNOWN' fallback must
    // not clobber a state learned while the machine was up.
    const freshState = typeof session?.state === 'string' && session.state.length > 0 ? session.state : null
    updateResultFn(
      resolvedJobId,
      {
        remote: {
          ...currentRemote,
          state: freshState ?? currentRemote.state ?? null,
          prUrl: prUrl ?? currentRemote.prUrl ?? null,
          branch: branch ?? currentRemote.branch ?? null,
        },
      },
      env
    )

    if (terminal && current?.status === 'running') {
      finishRemoteJobFn({
        jobId: resolvedJobId,
        outcome: state === 'COMPLETED' ? 'completed' : 'failed',
        state,
        summary,
        session,
        apiError: null,
        adapter,
        env,
        readResultFn,
        updateResultFn,
        appendEventFn,
      })
      finalized = true
    }
  }

  return {
    jobId: resolvedJobId,
    sessionId: resolvedSessionId,
    state,
    prUrl,
    branch,
    sessionUrl,
    lastMessage,
    finalized,
    terminal,
  }
}

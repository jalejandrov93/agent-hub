import { startRemoteJob as defaultStartRemoteJob } from '../cloud/runner.mjs'
import { checkRemoteSession as defaultCheckRemoteSession } from '../cloud/check.mjs'
import { listJobs as defaultListJobs } from '../jobstore.mjs'
import * as defaultClient from '../cloud/jules/client.mjs'
import * as defaultAdapter from '../cloud/jules/adapter.mjs'
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
 */
export async function julesSessionsTool({ limit = 20, state, env = process.env, client = defaultClient, listJobsFn = defaultListJobs, adapter = defaultAdapter } = {}) {
  const apiKey = env.JULES_API_KEY
  if (!apiKey) throw new Error('JULES_API_KEY is missing or rejected')

  let page
  try {
    page = await client.listSessions({ apiKey, pageSize: limit })
  } catch (error) {
    if (error?.status === 401 || error?.status === 403) throw new Error('JULES_API_KEY is missing or rejected')
    throw error
  }

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

  const sessions = Array.isArray(page?.sessions) ? page.sessions : []
  return {
    sessions: sessions
      .filter((session) => (state ? adapter.sessionState(session) === state : true))
      .map((session) => {
        const sessionId = sessionIdOf(session)
        return {
          sessionId,
          title: typeof session?.title === 'string' && session.title.length > 0 ? session.title : null,
          state: adapter.sessionState(session),
          prUrl: adapter.prUrlFromSession(session),
          branch: adapter.branchFromSession(session),
          sessionUrl: adapter.sessionUrl(session),
          createTime: typeof session?.createTime === 'string' && session.createTime.length > 0 ? session.createTime : null,
          jobId: sessionId ? jobIdBySession.get(sessionId) ?? null : null,
        }
      })
      .sort((a, b) => (b.createTime ?? '').localeCompare(a.createTime ?? ''))
      .slice(0, limit),
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
 * List the GitHub repos connected to the configured Jules account. Sources
 * are connected in the Jules web UI — there is no API to add one.
 */
export async function julesSourcesTool({ env = process.env, client = defaultClient, fetchImpl } = {}) {
  const apiKey = env.JULES_API_KEY
  if (!apiKey) {
    throw new Error('JULES_API_KEY is missing or rejected')
  }

  let page
  try {
    page = await client.listSources({ apiKey, fetchImpl })
  } catch (error) {
    if (error?.status === 401 || error?.status === 403) {
      throw new Error('JULES_API_KEY is missing or rejected')
    }
    throw error
  }

  const sources = Array.isArray(page?.sources) ? page.sources : []
  return {
    sources: sources.map((s) => {
      const fallback = ownerRepoFromName(s?.name)
      return {
        name: s?.name ?? null,
        owner: s?.githubRepo?.owner ?? fallback.owner,
        repo: s?.githubRepo?.repo ?? fallback.repo,
      }
    }),
  }
}

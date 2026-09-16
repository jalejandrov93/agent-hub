import { startRemoteJob as defaultStartRemoteJob } from '../cloud/runner.mjs'
import * as defaultClient from '../cloud/jules/client.mjs'
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

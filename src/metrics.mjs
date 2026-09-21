import fs from 'node:fs'
import path from 'node:path'
import { paths } from './config.mjs'

/**
 * Delegation metrics per (agent, model, mode, taskType), derived from job
 * records under runs/. Feeds adaptive timeouts, routing proposals, the
 * agents_metrics MCP tool and GET /api/metrics.
 */

export const DEFAULT_GROUP_BY = ['agent', 'model', 'mode', 'taskType']

const TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'canceled'])
const EXCLUDED_ERROR_KINDS = new Set(['locked', 'worktree_denied', 'orphaned', 'canceled_by_user'])

/**
 * Cache entry holding file metadata and the parsed job record.
 * @typedef {{ mtimeMs: number, size: number, ino: number, job: import('./schemas.mjs').JobRecord }} CacheEntry
 */

/**
 * In-memory incremental index keyed by runsDir path.
 * Retains parsed records across calls and invalidates only on mtimeMs/size changes.
 * @type {Map<string, Map<string, CacheEntry>>}
 */
const indexCache = new Map()

/**
 * Reads or updates the in-memory cache of job records for a runs directory.
 * Preserves the last known good record if result.json is temporarily corrupt.
 *
 * @param {string} runsDir
 * @returns {import('./schemas.mjs').JobRecord[]}
 */
function getOrUpdateIndex(runsDir) {
  let dirIndex = indexCache.get(runsDir)
  if (!dirIndex) {
    dirIndex = new Map()
    indexCache.set(runsDir, dirIndex)
  }

  let entries
  try {
    entries = fs.readdirSync(runsDir, { withFileTypes: true })
  } catch (error) {
    if (error.code === 'ENOENT') {
      dirIndex.clear()
      return []
    }
    throw error
  }

  const seen = new Set()
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === '.locks') continue
    const jobId = entry.name
    seen.add(jobId)

    const resultPath = path.join(runsDir, jobId, 'result.json')
    let stat
    try {
      stat = fs.statSync(resultPath)
    } catch {
      // result.json may still be writing or missing
      continue
    }

    const cached = dirIndex.get(jobId)
    // writeJsonAtomic replaces result.json via rename, which yields a new
    // inode; two writes can coincidentally match on mtimeMs and size (coarse
    // mtime granularity, equal-length content), so stat.ino must also match
    // before a cached record may be reused.
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size && cached.ino === stat.ino) {
      continue
    }

    try {
      const content = fs.readFileSync(resultPath, 'utf8')
      const parsed = JSON.parse(content)
      dirIndex.set(jobId, { mtimeMs: stat.mtimeMs, size: stat.size, ino: stat.ino, job: parsed })
    } catch {
      // If result.json is temporarily malformed, keep the previous valid record
    }
  }

  // Drop directories that no longer exist on disk
  for (const cachedId of dirIndex.keys()) {
    if (!seen.has(cachedId)) {
      dirIndex.delete(cachedId)
    }
  }

  const jobs = []
  for (const entry of dirIndex.values()) {
    if (entry.job) {
      jobs.push(entry.job)
    }
  }
  return jobs
}

function round2(value) {
  return Math.round(value * 100) / 100
}

function round4(value) {
  return Math.round(value * 10000) / 10000
}

function round6(value) {
  return Math.round(value * 1000000) / 1000000
}

/**
 * Computes the duration in milliseconds between createdAt and updatedAt.
 *
 * @param {import('./schemas.mjs').JobRecord} job
 * @returns {number}
 */
function jobDurationMs(job) {
  const start = new Date(job.createdAt).getTime()
  const end = new Date(job.updatedAt).getTime()
  if (Number.isFinite(start) && Number.isFinite(end) && end >= start) {
    return end - start
  }
  return 0
}

/**
 * Calculates a percentile using the nearest-rank method on a sorted array of numbers.
 *
 * @param {number[]} sorted
 * @param {number} p - Percentile between 0 and 100
 * @returns {number|null}
 */
function nearestRankPercentile(sorted, p) {
  if (sorted.length === 0) return null
  const rank = Math.ceil((p / 100) * sorted.length)
  const index = Math.min(Math.max(rank - 1, 0), sorted.length - 1)
  return sorted[index]
}

/**
 * Aggregates delegation runs into metrics rows grouped by specified dimensions.
 *
 * @param {object} [options]
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {string[]} [options.groupBy]
 * @returns {{generatedAt: string, groupBy: string[], rows: import('./schemas.mjs').MetricsRow[]}}
 */
export function computeMetrics({ env = process.env, groupBy = DEFAULT_GROUP_BY } = {}) {
  const { runsDir } = paths(env)
  const jobs = getOrUpdateIndex(runsDir)

  // Filter for terminal jobs and drop operational errorKinds
  const included = []
  for (const job of jobs) {
    if (!TERMINAL_STATUSES.has(job.status)) continue
    if (job.errorKind && EXCLUDED_ERROR_KINDS.has(job.errorKind)) continue
    included.push(job)
  }

  // Group included jobs by requested groupBy keys
  const groups = new Map()
  for (const job of included) {
    const keyValues = {}
    for (const dim of groupBy) {
      keyValues[dim] = dim === 'taskType' ? (job.taskType ?? null) : (job[dim] ?? null)
    }
    const groupKey = groupBy.map((dim) => String(keyValues[dim])).join('\0')
    let group = groups.get(groupKey)
    if (!group) {
      group = { keyValues, jobs: [] }
      groups.set(groupKey, group)
    }
    group.jobs.push(job)
  }

  const rows = []
  for (const group of groups.values()) {
    const groupJobs = group.jobs
    const samples = groupJobs.length
    let succeeded = 0
    let failed = 0
    let canceled = 0
    const succeededDurations = []
    const errorKinds = {}
    let tokensTotal = 0
    let tokenJobsCount = 0
    let costSum = 0
    let costJobsCount = 0
    let verifiedSamples = 0
    let verifiedCount = 0
    let verificationFailures = 0
    const judgeVerdicts = {}
    let revisionTotal = 0
    let revisionJobsCount = 0
    let retryCount = 0

    for (const job of groupJobs) {
      if (job.status === 'succeeded') {
        succeeded++
        succeededDurations.push(jobDurationMs(job))
      } else if (job.status === 'failed') {
        failed++
        if (job.errorKind) {
          errorKinds[job.errorKind] = (errorKinds[job.errorKind] || 0) + 1
        }
      } else if (job.status === 'canceled') {
        canceled++
        if (job.errorKind) {
          errorKinds[job.errorKind] = (errorKinds[job.errorKind] || 0) + 1
        }
      }

      if (typeof job.tokens === 'number' && Number.isFinite(job.tokens)) {
        tokensTotal += job.tokens
        tokenJobsCount++
      }

      if (typeof job.costUsd === 'number' && Number.isFinite(job.costUsd)) {
        costSum += job.costUsd
        costJobsCount++
      }

      if (typeof job.verified === 'boolean') {
        verifiedSamples++
        if (job.verified === true) {
          verifiedCount++
        } else {
          verificationFailures++
        }
      }

      if (typeof job.judge_verdict === 'string' && job.judge_verdict.length > 0) {
        judgeVerdicts[job.judge_verdict] = (judgeVerdicts[job.judge_verdict] || 0) + 1
      }

      if (Number.isInteger(job.revision)) {
        revisionTotal += job.revision
        revisionJobsCount++
      }

      if (Number.isInteger(job.attempt) && job.attempt > 1) {
        retryCount++
      }
    }

    succeededDurations.sort((a, b) => a - b)

    const p50Ms = succeeded > 0 ? nearestRankPercentile(succeededDurations, 50) : null
    const p95Ms = succeeded > 0 ? nearestRankPercentile(succeededDurations, 95) : null
    const successRate = samples === 0 ? null : Math.round((succeeded / samples) * 10000) / 10000
    const tokensAvg = tokenJobsCount > 0 ? Math.round(tokensTotal / tokenJobsCount) : null
    const costUsdTotal = costJobsCount > 0 ? round6(costSum) : 0
    const costUsdAvg = costJobsCount > 0 ? round6(costSum / costJobsCount) : null
    const verifiedRate = verifiedSamples > 0 ? round4(verifiedCount / verifiedSamples) : null
    const revisionAvg = revisionJobsCount > 0 ? round2(revisionTotal / revisionJobsCount) : null
    const qualityScore = verifiedSamples > 0 ? Math.round((10 * verifiedCount / verifiedSamples) * 10) / 10 : null

    // Ensure required schema attributes are populated
    const firstJob = groupJobs[0] || {}
    const row = {
      agent: group.keyValues.agent ?? firstJob.agent ?? '',
      model: group.keyValues.model ?? firstJob.model ?? '',
      mode: group.keyValues.mode ?? firstJob.mode ?? 'read',
      taskType: group.keyValues.taskType !== undefined ? group.keyValues.taskType : (firstJob.taskType ?? null),
      samples,
      succeeded,
      failed,
      canceled,
      successRate,
      p50Ms,
      p95Ms,
      errorKinds,
      tokensTotal,
      tokensAvg,
      costUsdTotal,
      costUsdAvg,
      verifiedCount,
      verifiedSamples,
      verifiedRate,
      verificationFailures,
      judgeVerdicts,
      revisionTotal,
      revisionAvg,
      retryCount,
      qualityScore,
    }

    rows.push(row)
  }

  // Deterministic sorting across output rows
  rows.sort((a, b) => {
    const agentCmp = (a.agent || '').localeCompare(b.agent || '')
    if (agentCmp !== 0) return agentCmp
    const modelCmp = (a.model || '').localeCompare(b.model || '')
    if (modelCmp !== 0) return modelCmp
    const modeCmp = (a.mode || '').localeCompare(b.mode || '')
    if (modeCmp !== 0) return modeCmp
    return (a.taskType || '').localeCompare(b.taskType || '')
  })

  return {
    generatedAt: new Date().toISOString(),
    groupBy: [...groupBy],
    rows,
  }
}

/**
 * The single metrics row for one exact key, or null when there is no history.
 *
 * @param {object} [params]
 * @param {string} [params.agent]
 * @param {string} [params.model]
 * @param {string} [params.mode]
 * @param {string|null} [params.taskType]
 * @param {NodeJS.ProcessEnv} [params.env]
 * @returns {import('./schemas.mjs').MetricsRow | null}
 */
export function metricsFor({ agent, model, mode = 'read', taskType = null, env = process.env } = {}) {
  const { rows } = computeMetrics({ env })
  const match = rows.find(
    (r) =>
      r.agent === agent &&
      r.model === model &&
      r.mode === mode &&
      (r.taskType ?? null) === (taskType ?? null)
  )
  return match ?? null
}

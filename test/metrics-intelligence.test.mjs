import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { MetricsRow, JobRecord } from '../src/schemas.mjs'
import { createJob, updateResult, readResult } from '../src/jobstore.mjs'
import { computeMetrics, metricsFor } from '../src/metrics.mjs'
import { runWorkflow } from '../src/workflow/engine.mjs'
import { closeDb } from '../src/storage/index.mjs'

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-metrics-intel-test-'))
}

function writeJob(home, record) {
  const dir = path.join(home, 'runs', record.jobId)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(record, null, 2), 'utf8')
}

test('createJob accepts optional revision and JobRecord schema validates it', () => {
  const home = tmpHome()
  const env = { AGENT_HUB_HOME: home }

  const job = createJob({
    agent: 'agy',
    model: 'gemini-3.8-flash-high',
    task: 'test revision plumbing',
    mode: 'write',
    revision: 2,
    env,
  })

  assert.equal(job.revision, 2)
  const parsed = JobRecord.parse(job)
  assert.equal(parsed.revision, 2)

  const defaultJob = createJob({
    agent: 'agy',
    model: 'gemini-3.8-flash-high',
    task: 'test default revision',
    mode: 'write',
    env,
  })

  assert.equal(defaultJob.revision, null)
  const parsedDefault = JobRecord.parse(defaultJob)
  assert.equal(parsedDefault.revision, null)
})

test('aggregates costUsdTotal and costUsdAvg over finite numeric costUsd only', () => {
  const home = tmpHome()
  const env = { AGENT_HUB_HOME: home }

  writeJob(home, {
    jobId: 'job-1',
    agent: 'agy',
    model: 'm1',
    mode: 'write',
    taskType: 'recon',
    status: 'succeeded',
    costUsd: 0.012345,
    createdAt: '2026-09-20T00:00:00.000Z',
    updatedAt: '2026-09-20T00:00:10.000Z',
  })
  writeJob(home, {
    jobId: 'job-2',
    agent: 'agy',
    model: 'm1',
    mode: 'write',
    taskType: 'recon',
    status: 'succeeded',
    costUsd: 0.024680,
    createdAt: '2026-09-20T00:00:00.000Z',
    updatedAt: '2026-09-20T00:00:10.000Z',
  })
  writeJob(home, {
    jobId: 'job-3',
    agent: 'agy',
    model: 'm1',
    mode: 'write',
    taskType: 'recon',
    status: 'failed',
    costUsd: null,
    createdAt: '2026-09-20T00:00:00.000Z',
    updatedAt: '2026-09-20T00:00:10.000Z',
  })
  writeJob(home, {
    jobId: 'job-4',
    agent: 'agy',
    model: 'm1',
    mode: 'write',
    taskType: 'recon',
    status: 'succeeded',
    costUsd: 'invalid',
    createdAt: '2026-09-20T00:00:00.000Z',
    updatedAt: '2026-09-20T00:00:10.000Z',
  })

  const { rows } = computeMetrics({ env })
  assert.equal(rows.length, 1)
  const row = rows[0]

  assert.equal(row.costUsdTotal, 0.037025)
  assert.equal(row.costUsdAvg, 0.018513)
  MetricsRow.parse(row)
})

test('costUsdTotal is 0 and costUsdAvg is null when no job carries numeric costUsd', () => {
  const home = tmpHome()
  const env = { AGENT_HUB_HOME: home }

  writeJob(home, {
    jobId: 'job-1',
    agent: 'agy',
    model: 'm1',
    mode: 'write',
    taskType: 'recon',
    status: 'succeeded',
    createdAt: '2026-09-20T00:00:00.000Z',
    updatedAt: '2026-09-20T00:00:10.000Z',
  })

  const { rows } = computeMetrics({ env })
  assert.equal(rows.length, 1)
  const row = rows[0]

  assert.equal(row.costUsdTotal, 0)
  assert.equal(row.costUsdAvg, null)
  MetricsRow.parse(row)
})

test('aggregates verification metrics: verifiedSamples, verifiedCount, verifiedRate, verificationFailures', () => {
  const home = tmpHome()
  const env = { AGENT_HUB_HOME: home }

  // 2 verified true, 1 verified false, 1 verified null, 1 non-boolean string
  writeJob(home, {
    jobId: 'job-v1',
    agent: 'agy',
    model: 'm1',
    mode: 'write',
    taskType: 'recon',
    status: 'succeeded',
    verified: true,
    createdAt: '2026-09-20T00:00:00.000Z',
    updatedAt: '2026-09-20T00:00:10.000Z',
  })
  writeJob(home, {
    jobId: 'job-v2',
    agent: 'agy',
    model: 'm1',
    mode: 'write',
    taskType: 'recon',
    status: 'succeeded',
    verified: true,
    createdAt: '2026-09-20T00:00:00.000Z',
    updatedAt: '2026-09-20T00:00:10.000Z',
  })
  writeJob(home, {
    jobId: 'job-v3',
    agent: 'agy',
    model: 'm1',
    mode: 'write',
    taskType: 'recon',
    status: 'failed',
    verified: false,
    createdAt: '2026-09-20T00:00:00.000Z',
    updatedAt: '2026-09-20T00:00:10.000Z',
  })
  writeJob(home, {
    jobId: 'job-v4',
    agent: 'agy',
    model: 'm1',
    mode: 'write',
    taskType: 'recon',
    status: 'succeeded',
    verified: null,
    createdAt: '2026-09-20T00:00:00.000Z',
    updatedAt: '2026-09-20T00:00:10.000Z',
  })
  writeJob(home, {
    jobId: 'job-v5',
    agent: 'agy',
    model: 'm1',
    mode: 'write',
    taskType: 'recon',
    status: 'succeeded',
    verified: 'true',
    createdAt: '2026-09-20T00:00:00.000Z',
    updatedAt: '2026-09-20T00:00:10.000Z',
  })

  const { rows } = computeMetrics({ env })
  assert.equal(rows.length, 1)
  const row = rows[0]

  assert.equal(row.verifiedSamples, 3)
  assert.equal(row.verifiedCount, 2)
  assert.equal(row.verificationFailures, 1)
  assert.equal(row.verifiedRate, 0.6667)
  MetricsRow.parse(row)
})

test('aggregates judgeVerdicts histogram skipping empty or non-string values', () => {
  const home = tmpHome()
  const env = { AGENT_HUB_HOME: home }

  writeJob(home, {
    jobId: 'job-j1',
    agent: 'agy',
    model: 'm1',
    mode: 'write',
    taskType: 'recon',
    status: 'succeeded',
    judge_verdict: 'accepted',
    createdAt: '2026-09-20T00:00:00.000Z',
    updatedAt: '2026-09-20T00:00:10.000Z',
  })
  writeJob(home, {
    jobId: 'job-j2',
    agent: 'agy',
    model: 'm1',
    mode: 'write',
    taskType: 'recon',
    status: 'succeeded',
    judge_verdict: 'accepted',
    createdAt: '2026-09-20T00:00:00.000Z',
    updatedAt: '2026-09-20T00:00:10.000Z',
  })
  writeJob(home, {
    jobId: 'job-j3',
    agent: 'agy',
    model: 'm1',
    mode: 'write',
    taskType: 'recon',
    status: 'failed',
    judge_verdict: 'rejected',
    createdAt: '2026-09-20T00:00:00.000Z',
    updatedAt: '2026-09-20T00:00:10.000Z',
  })
  writeJob(home, {
    jobId: 'job-j4',
    agent: 'agy',
    model: 'm1',
    mode: 'write',
    taskType: 'recon',
    status: 'failed',
    judge_verdict: '',
    createdAt: '2026-09-20T00:00:00.000Z',
    updatedAt: '2026-09-20T00:00:10.000Z',
  })
  writeJob(home, {
    jobId: 'job-j5',
    agent: 'agy',
    model: 'm1',
    mode: 'write',
    taskType: 'recon',
    status: 'failed',
    judge_verdict: null,
    createdAt: '2026-09-20T00:00:00.000Z',
    updatedAt: '2026-09-20T00:00:10.000Z',
  })

  const { rows } = computeMetrics({ env })
  assert.equal(rows.length, 1)
  const row = rows[0]

  assert.deepEqual(row.judgeVerdicts, { accepted: 2, rejected: 1 })
  MetricsRow.parse(row)
})

test('aggregates revisionTotal and revisionAvg over integer revisions only', () => {
  const home = tmpHome()
  const env = { AGENT_HUB_HOME: home }

  writeJob(home, {
    jobId: 'job-r1',
    agent: 'agy',
    model: 'm1',
    mode: 'write',
    taskType: 'recon',
    status: 'succeeded',
    revision: 1,
    createdAt: '2026-09-20T00:00:00.000Z',
    updatedAt: '2026-09-20T00:00:10.000Z',
  })
  writeJob(home, {
    jobId: 'job-r2',
    agent: 'agy',
    model: 'm1',
    mode: 'write',
    taskType: 'recon',
    status: 'succeeded',
    revision: 2,
    createdAt: '2026-09-20T00:00:00.000Z',
    updatedAt: '2026-09-20T00:00:10.000Z',
  })
  writeJob(home, {
    jobId: 'job-r3',
    agent: 'agy',
    model: 'm1',
    mode: 'write',
    taskType: 'recon',
    status: 'succeeded',
    revision: 0,
    createdAt: '2026-09-20T00:00:00.000Z',
    updatedAt: '2026-09-20T00:00:10.000Z',
  })
  writeJob(home, {
    jobId: 'job-r4',
    agent: 'agy',
    model: 'm1',
    mode: 'write',
    taskType: 'recon',
    status: 'succeeded',
    revision: 1.5,
    createdAt: '2026-09-20T00:00:00.000Z',
    updatedAt: '2026-09-20T00:00:10.000Z',
  })
  writeJob(home, {
    jobId: 'job-r5',
    agent: 'agy',
    model: 'm1',
    mode: 'write',
    taskType: 'recon',
    status: 'succeeded',
    revision: null,
    createdAt: '2026-09-20T00:00:00.000Z',
    updatedAt: '2026-09-20T00:00:10.000Z',
  })

  const { rows } = computeMetrics({ env })
  assert.equal(rows.length, 1)
  const row = rows[0]

  assert.equal(row.revisionTotal, 3)
  assert.equal(row.revisionAvg, 1)
  MetricsRow.parse(row)
})

test('revisionTotal is 0 and revisionAvg is null when no integer revisions exist', () => {
  const home = tmpHome()
  const env = { AGENT_HUB_HOME: home }

  writeJob(home, {
    jobId: 'job-1',
    agent: 'agy',
    model: 'm1',
    mode: 'write',
    taskType: 'recon',
    status: 'succeeded',
    createdAt: '2026-09-20T00:00:00.000Z',
    updatedAt: '2026-09-20T00:00:10.000Z',
  })

  const { rows } = computeMetrics({ env })
  assert.equal(rows.length, 1)
  const row = rows[0]

  assert.equal(row.revisionTotal, 0)
  assert.equal(row.revisionAvg, null)
  MetricsRow.parse(row)
})

test('aggregates retryCount counting attempt > 1', () => {
  const home = tmpHome()
  const env = { AGENT_HUB_HOME: home }

  writeJob(home, {
    jobId: 'job-a1',
    agent: 'agy',
    model: 'm1',
    mode: 'write',
    taskType: 'recon',
    status: 'succeeded',
    attempt: 1,
    createdAt: '2026-09-20T00:00:00.000Z',
    updatedAt: '2026-09-20T00:00:10.000Z',
  })
  writeJob(home, {
    jobId: 'job-a2',
    agent: 'agy',
    model: 'm1',
    mode: 'write',
    taskType: 'recon',
    status: 'succeeded',
    attempt: 2,
    createdAt: '2026-09-20T00:00:00.000Z',
    updatedAt: '2026-09-20T00:00:10.000Z',
  })
  writeJob(home, {
    jobId: 'job-a3',
    agent: 'agy',
    model: 'm1',
    mode: 'write',
    taskType: 'recon',
    status: 'failed',
    attempt: 3,
    createdAt: '2026-09-20T00:00:00.000Z',
    updatedAt: '2026-09-20T00:00:10.000Z',
  })
  writeJob(home, {
    jobId: 'job-a4',
    agent: 'agy',
    model: 'm1',
    mode: 'write',
    taskType: 'recon',
    status: 'succeeded',
    attempt: 0,
    createdAt: '2026-09-20T00:00:00.000Z',
    updatedAt: '2026-09-20T00:00:10.000Z',
  })
  writeJob(home, {
    jobId: 'job-a5',
    agent: 'agy',
    model: 'm1',
    mode: 'write',
    taskType: 'recon',
    status: 'succeeded',
    attempt: '2',
    createdAt: '2026-09-20T00:00:00.000Z',
    updatedAt: '2026-09-20T00:00:10.000Z',
  })

  const { rows } = computeMetrics({ env })
  assert.equal(rows.length, 1)
  const row = rows[0]

  assert.equal(row.retryCount, 2)
  MetricsRow.parse(row)
})

test('computes qualityScore: null when no verified samples, and 10*verifiedRate rounded to 1 decimal', () => {
  const home1 = tmpHome()
  const env1 = { AGENT_HUB_HOME: home1 }

  // 3 verified out of 4 samples -> 7.5
  for (let i = 1; i <= 3; i++) {
    writeJob(home1, {
      jobId: `job-q-${i}`,
      agent: 'agy',
      model: 'm1',
      mode: 'write',
      taskType: 'recon',
      status: 'succeeded',
      verified: true,
      createdAt: '2026-09-20T00:00:00.000Z',
      updatedAt: '2026-09-20T00:00:10.000Z',
    })
  }
  writeJob(home1, {
    jobId: 'job-q-4',
    agent: 'agy',
    model: 'm1',
    mode: 'write',
    taskType: 'recon',
    status: 'failed',
    verified: false,
    createdAt: '2026-09-20T00:00:00.000Z',
    updatedAt: '2026-09-20T00:00:10.000Z',
  })

  const res1 = computeMetrics({ env: env1 })
  assert.equal(res1.rows[0].qualityScore, 7.5)
  MetricsRow.parse(res1.rows[0])

  // No verified samples -> null
  const home2 = tmpHome()
  const env2 = { AGENT_HUB_HOME: home2 }
  writeJob(home2, {
    jobId: 'job-q-none',
    agent: 'agy',
    model: 'm1',
    mode: 'write',
    taskType: 'recon',
    status: 'succeeded',
    createdAt: '2026-09-20T00:00:00.000Z',
    updatedAt: '2026-09-20T00:00:10.000Z',
  })

  const res2 = computeMetrics({ env: env2 })
  assert.equal(res2.rows[0].qualityScore, null)
  MetricsRow.parse(res2.rows[0])
})

test('jobs with non-numeric fields never yield NaN', () => {
  const home = tmpHome()
  const env = { AGENT_HUB_HOME: home }

  writeJob(home, {
    jobId: 'job-nan',
    agent: 'agy',
    model: 'm1',
    mode: 'write',
    taskType: 'recon',
    status: 'succeeded',
    costUsd: NaN,
    tokens: NaN,
    attempt: NaN,
    revision: NaN,
    verified: 'not-a-boolean',
    createdAt: '2026-09-20T00:00:00.000Z',
    updatedAt: '2026-09-20T00:00:10.000Z',
  })

  const { rows } = computeMetrics({ env })
  assert.equal(rows.length, 1)
  const row = rows[0]

  assert.equal(Number.isNaN(row.costUsdTotal), false)
  assert.equal(row.costUsdAvg, null)
  assert.equal(Number.isNaN(row.tokensTotal), false)
  assert.equal(row.tokensAvg, null)
  assert.equal(Number.isNaN(row.revisionTotal), false)
  assert.equal(row.revisionAvg, null)
  assert.equal(Number.isNaN(row.retryCount), false)
  assert.equal(row.qualityScore, null)
  MetricsRow.parse(row)
})

test('groups with zero terminal jobs are not emitted', () => {
  const home = tmpHome()
  const env = { AGENT_HUB_HOME: home }

  writeJob(home, {
    jobId: 'job-queued',
    agent: 'agy',
    model: 'm1',
    mode: 'write',
    taskType: 'recon',
    status: 'queued',
    createdAt: '2026-09-20T00:00:00.000Z',
    updatedAt: '2026-09-20T00:00:10.000Z',
  })

  const { rows } = computeMetrics({ env })
  assert.equal(rows.length, 0)
})

test('engine mirrors verified, judge_verdict, and revision onto job record even when rejected', async () => {
  const home = tmpHome()
  const env = { AGENT_HUB_HOME: home }

  const job = createJob({
    agent: 'agy',
    model: 'test-model',
    task: 'workflow judge mirror test',
    cwd: null,
    workflow_id: 'wf-judge-mirror',
    step_id: 'step1',
    env,
  })
  const jobId = job.jobId
  updateResult(jobId, { status: 'succeeded' }, env)

  const workflow = {
    id: 'wf-judge-mirror',
    name: 'judge mirror test',
    nodes: [
      {
        id: 'step1',
        type: 'delegate',
        task: 'Failing verify node',
        maxRevisionAttempts: 0,
        verify: {
          checks: [{ name: 'tests', argv: ['npm', 'test'] }],
          required: true,
        },
      },
    ],
  }

  const runCommandFn = async () => ({
    stdout: '',
    stderr: 'fail',
    code: 1,
    timedOut: false,
  })

  const mockDispatch = async () => ({
    success: true,
    jobId,
  })

  await runWorkflow({
    workflow,
    env,
    dispatchFn: mockDispatch,
    runCommandFn,
  })

  const updatedJob = readResult(jobId, env)
  assert.equal(updatedJob.verified, false)
  assert.equal(updatedJob.judge_verdict, 'rejected')
  assert.equal(updatedJob.revision, 0)

  closeDb(env)
})

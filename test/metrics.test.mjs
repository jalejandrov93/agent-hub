import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { MetricsRow } from '../src/schemas.mjs'

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-metrics-test-'))
}

function writeJob(home, record) {
  const dir = path.join(home, 'runs', record.jobId)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(record, null, 2), 'utf8')
}

async function freshMetrics() {
  const bust = `?t=${Date.now()}_${Math.random()}`
  return import(`../src/metrics.mjs${bust}`)
}

test('computeMetrics on empty home: returns empty rows and metricsFor returns null', async () => {
  const home = tmpHome()
  const env = { AGENT_HUB_HOME: home }
  const { computeMetrics, metricsFor } = await freshMetrics()

  const result = computeMetrics({ env })
  assert.equal(typeof result.generatedAt, 'string')
  assert.deepEqual(result.groupBy, ['agent', 'model', 'mode', 'taskType'])
  assert.deepEqual(result.rows, [])

  const row = metricsFor({ agent: 'agy', model: 'gemini-3.8-flash-low', env })
  assert.equal(row, null)
})

test('filters out non-terminal jobs (queued, running)', async () => {
  const home = tmpHome()
  const env = { AGENT_HUB_HOME: home }
  const { computeMetrics } = await freshMetrics()

  writeJob(home, {
    jobId: 'job-queued',
    agent: 'agy',
    model: 'm1',
    mode: 'read',
    status: 'queued',
    createdAt: '2026-09-15T00:00:00.000Z',
    updatedAt: '2026-09-15T00:00:10.000Z',
  })
  writeJob(home, {
    jobId: 'job-running',
    agent: 'agy',
    model: 'm1',
    mode: 'read',
    status: 'running',
    createdAt: '2026-09-15T00:00:00.000Z',
    updatedAt: '2026-09-15T00:00:10.000Z',
  })

  const result = computeMetrics({ env })
  assert.equal(result.rows.length, 0)
})

test('excludes jobs with errorKind locked, worktree_denied, orphaned, canceled_by_user', async () => {
  const home = tmpHome()
  const env = { AGENT_HUB_HOME: home }
  const { computeMetrics } = await freshMetrics()

  const excludedKinds = ['locked', 'worktree_denied', 'orphaned', 'canceled_by_user']
  for (const [idx, errorKind] of excludedKinds.entries()) {
    writeJob(home, {
      jobId: `job-excluded-${idx}`,
      agent: 'agy',
      model: 'm1',
      mode: 'read',
      status: errorKind === 'canceled_by_user' ? 'canceled' : 'failed',
      errorKind,
      createdAt: '2026-09-15T00:00:00.000Z',
      updatedAt: '2026-09-15T00:00:10.000Z',
    })
  }

  const result = computeMetrics({ env })
  assert.equal(result.rows.length, 0)
})

test('computes aggregation, successRate, errorKinds, and tokens accurately', async () => {
  const home = tmpHome()
  const env = { AGENT_HUB_HOME: home }
  const { computeMetrics, metricsFor } = await freshMetrics()

  // 2 succeeded jobs
  writeJob(home, {
    jobId: 'job-1',
    agent: 'agy',
    model: 'gemini-3.8-flash-low',
    mode: 'read',
    taskType: 'recon',
    status: 'succeeded',
    tokens: 1000,
    createdAt: '2026-09-15T00:00:00.000Z',
    updatedAt: '2026-09-15T00:00:10.000Z', // 10s = 10000ms
  })
  writeJob(home, {
    jobId: 'job-2',
    agent: 'agy',
    model: 'gemini-3.8-flash-low',
    mode: 'read',
    taskType: 'recon',
    status: 'succeeded',
    tokens: 3000,
    createdAt: '2026-09-15T00:00:00.000Z',
    updatedAt: '2026-09-15T00:00:30.000Z', // 30s = 30000ms
  })
  // 1 failed job with errorKind crash
  writeJob(home, {
    jobId: 'job-3',
    agent: 'agy',
    model: 'gemini-3.8-flash-low',
    mode: 'read',
    taskType: 'recon',
    status: 'failed',
    errorKind: 'crash',
    createdAt: '2026-09-15T00:00:00.000Z',
    updatedAt: '2026-09-15T00:00:05.000Z',
  })
  // 1 canceled job with errorKind timeout (not canceled_by_user)
  writeJob(home, {
    jobId: 'job-4',
    agent: 'agy',
    model: 'gemini-3.8-flash-low',
    mode: 'read',
    taskType: 'recon',
    status: 'canceled',
    errorKind: 'timeout',
    tokens: 500,
    createdAt: '2026-09-15T00:00:00.000Z',
    updatedAt: '2026-09-15T00:00:20.000Z',
  })

  const result = computeMetrics({ env })
  assert.equal(result.rows.length, 1)
  const row = result.rows[0]

  assert.equal(row.agent, 'agy')
  assert.equal(row.model, 'gemini-3.8-flash-low')
  assert.equal(row.mode, 'read')
  assert.equal(row.taskType, 'recon')
  assert.equal(row.samples, 4)
  assert.equal(row.succeeded, 2)
  assert.equal(row.failed, 1)
  assert.equal(row.canceled, 1)
  assert.equal(row.successRate, 0.5)
  assert.deepEqual(row.errorKinds, { crash: 1, timeout: 1 })
  assert.equal(row.tokensTotal, 4500)
  assert.equal(row.tokensAvg, 1500) // 4500 / 3 jobs with tokens

  // Nearest-rank percentiles on succeeded [10000, 30000]
  // p50: ceil(0.5 * 2) - 1 = 0 -> 10000
  // p95: ceil(0.95 * 2) - 1 = 1 -> 30000
  assert.equal(row.p50Ms, 10000)
  assert.equal(row.p95Ms, 30000)

  // Validate with Zod schema
  MetricsRow.parse(row)

  // Test metricsFor
  const queried = metricsFor({ agent: 'agy', model: 'gemini-3.8-flash-low', mode: 'read', taskType: 'recon', env })
  assert.deepEqual(queried, row)
})

test('percentile nearest-rank calculation with multiple succeeded durations', async () => {
  const home = tmpHome()
  const env = { AGENT_HUB_HOME: home }
  const { computeMetrics } = await freshMetrics()

  // Create 10 succeeded jobs with durations 10s, 20s, ..., 100s
  for (let i = 1; i <= 10; i++) {
    writeJob(home, {
      jobId: `job-${i}`,
      agent: 'opencode',
      model: 'm1',
      mode: 'read',
      status: 'succeeded',
      createdAt: '2026-09-15T00:00:00.000Z',
      updatedAt: new Date(new Date('2026-09-15T00:00:00.000Z').getTime() + i * 10000).toISOString(),
    })
  }

  const { rows } = computeMetrics({ env })
  assert.equal(rows.length, 1)
  // Durations: [10000, 20000, ..., 100000] (N=10)
  // p50: ceil(0.50 * 10) - 1 = 4 -> 50000
  // p95: ceil(0.95 * 10) - 1 = 9 -> 100000
  assert.equal(rows[0].p50Ms, 50000)
  assert.equal(rows[0].p95Ms, 100000)
  assert.equal(rows[0].successRate, 1)
  MetricsRow.parse(rows[0])
})

test('successRate is 0 when 0 succeeded jobs; p50Ms/p95Ms are null', async () => {
  const home = tmpHome()
  const env = { AGENT_HUB_HOME: home }
  const { computeMetrics } = await freshMetrics()

  writeJob(home, {
    jobId: 'job-f1',
    agent: 'copilot',
    model: 'auto',
    mode: 'read',
    taskType: 'triage',
    status: 'failed',
    errorKind: 'crash',
    createdAt: '2026-09-15T00:00:00.000Z',
    updatedAt: '2026-09-15T00:00:10.000Z',
  })

  const { rows } = computeMetrics({ env })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].samples, 1)
  assert.equal(rows[0].succeeded, 0)
  assert.equal(rows[0].failed, 1)
  assert.equal(rows[0].successRate, 0)
  assert.equal(rows[0].p50Ms, null)
  assert.equal(rows[0].p95Ms, null)
  assert.equal(rows[0].tokensTotal, 0)
  assert.equal(rows[0].tokensAvg, null)
  MetricsRow.parse(rows[0])
})

test('a group with 4 failed and 0 succeeded jobs reports successRate 0', async () => {
  const home = tmpHome()
  const env = { AGENT_HUB_HOME: home }
  const { computeMetrics } = await freshMetrics()

  for (let i = 1; i <= 4; i++) {
    writeJob(home, {
      jobId: `job-failed-${i}`,
      agent: 'agy',
      model: 'gemini-3.8-flash-low',
      mode: 'read',
      taskType: 'recon',
      status: 'failed',
      errorKind: 'crash',
      createdAt: '2026-09-15T00:00:00.000Z',
      updatedAt: '2026-09-15T00:00:05.000Z',
    })
  }

  const { rows } = computeMetrics({ env })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].samples, 4)
  assert.equal(rows[0].succeeded, 0)
  assert.equal(rows[0].failed, 4)
  assert.equal(rows[0].successRate, 0)
  assert.equal(rows[0].p50Ms, null)
  assert.equal(rows[0].p95Ms, null)
  MetricsRow.parse(rows[0])
})

test('legacy jobs without taskType are grouped under taskType null', async () => {
  const home = tmpHome()
  const env = { AGENT_HUB_HOME: home }
  const { computeMetrics, metricsFor } = await freshMetrics()

  writeJob(home, {
    jobId: 'job-legacy',
    agent: 'agy',
    model: 'gemini-3.8-flash-low',
    mode: 'read',
    // taskType omitted
    status: 'succeeded',
    createdAt: '2026-09-15T00:00:00.000Z',
    updatedAt: '2026-09-15T00:00:05.000Z',
  })

  const { rows } = computeMetrics({ env })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].taskType, null)
  MetricsRow.parse(rows[0])

  const found = metricsFor({ agent: 'agy', model: 'gemini-3.8-flash-low', mode: 'read', taskType: null, env })
  assert.ok(found)
  assert.equal(found.taskType, null)
})

test('custom groupBy parameter groups by specified dimensions', async () => {
  const home = tmpHome()
  const env = { AGENT_HUB_HOME: home }
  const { computeMetrics } = await freshMetrics()

  writeJob(home, {
    jobId: 'j1',
    agent: 'agy',
    model: 'm1',
    mode: 'read',
    status: 'succeeded',
    createdAt: '2026-09-15T00:00:00.000Z',
    updatedAt: '2026-09-15T00:00:05.000Z',
  })
  writeJob(home, {
    jobId: 'j2',
    agent: 'agy',
    model: 'm2',
    mode: 'write',
    status: 'succeeded',
    createdAt: '2026-09-15T00:00:00.000Z',
    updatedAt: '2026-09-15T00:00:05.000Z',
  })

  // Group by agent only
  const { groupBy, rows } = computeMetrics({ env, groupBy: ['agent'] })
  assert.deepEqual(groupBy, ['agent'])
  assert.equal(rows.length, 1)
  assert.equal(rows[0].agent, 'agy')
  assert.equal(rows[0].samples, 2)
  MetricsRow.parse(rows[0])
})

test('incremental in-memory index: re-reads only when mtimeMs/size changed', async () => {
  const home = tmpHome()
  const env = { AGENT_HUB_HOME: home }
  const { computeMetrics } = await freshMetrics()

  const jPath = path.join(home, 'runs', 'job-cache-1', 'result.json')
  writeJob(home, {
    jobId: 'job-cache-1',
    agent: 'agy',
    model: 'm1',
    mode: 'read',
    status: 'succeeded',
    tokens: 100,
    createdAt: '2026-09-15T00:00:00.000Z',
    updatedAt: '2026-09-15T00:00:10.000Z',
  })

  const res1 = computeMetrics({ env })
  assert.equal(res1.rows[0].tokensTotal, 100)

  // Modify file content and update mtimeMs
  const updatedJob = {
    jobId: 'job-cache-1',
    agent: 'agy',
    model: 'm1',
    mode: 'read',
    status: 'succeeded',
    tokens: 999,
    createdAt: '2026-09-15T00:00:00.000Z',
    updatedAt: '2026-09-15T00:00:10.000Z',
  }
  fs.writeFileSync(jPath, JSON.stringify(updatedJob, null, 2), 'utf8')
  // Force a newer mtime
  const newTime = new Date(Date.now() + 5000)
  fs.utimesSync(jPath, newTime, newTime)

  const res2 = computeMetrics({ env })
  assert.equal(res2.rows[0].tokensTotal, 999)
})

test('incremental index: drops removed job directories', async () => {
  const home = tmpHome()
  const env = { AGENT_HUB_HOME: home }
  const { computeMetrics } = await freshMetrics()

  writeJob(home, {
    jobId: 'job-to-drop',
    agent: 'agy',
    model: 'm1',
    mode: 'read',
    status: 'succeeded',
    createdAt: '2026-09-15T00:00:00.000Z',
    updatedAt: '2026-09-15T00:00:10.000Z',
  })

  const res1 = computeMetrics({ env })
  assert.equal(res1.rows.length, 1)

  // Remove directory
  fs.rmSync(path.join(home, 'runs', 'job-to-drop'), { recursive: true, force: true })

  const res2 = computeMetrics({ env })
  assert.equal(res2.rows.length, 0)
})

test('incremental index: keeps last good record when result.json is temporarily invalid JSON', async () => {
  const home = tmpHome()
  const env = { AGENT_HUB_HOME: home }
  const { computeMetrics } = await freshMetrics()

  const jPath = path.join(home, 'runs', 'job-corrupt', 'result.json')
  writeJob(home, {
    jobId: 'job-corrupt',
    agent: 'agy',
    model: 'm1',
    mode: 'read',
    status: 'succeeded',
    tokens: 42,
    createdAt: '2026-09-15T00:00:00.000Z',
    updatedAt: '2026-09-15T00:00:10.000Z',
  })

  const res1 = computeMetrics({ env })
  assert.equal(res1.rows.length, 1)
  assert.equal(res1.rows[0].tokensTotal, 42)

  // Corrupt the result.json file (e.g. truncated in-flight write)
  fs.writeFileSync(jPath, '{"jobId": "job-corrupt", "inval', 'utf8')
  const newTime = new Date(Date.now() + 5000)
  fs.utimesSync(jPath, newTime, newTime)

  const res2 = computeMetrics({ env })
  assert.equal(res2.rows.length, 1, 'retains the last valid parsed record')
  assert.equal(res2.rows[0].tokensTotal, 42)
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { MetricsResponse } from '../src/schemas.mjs'

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-tools-insights-test-'))
}

function writeJob(home, record) {
  const dir = path.join(home, 'runs', record.jobId)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(record, null, 2), 'utf8')
}

async function freshInsights() {
  const bust = `?t=${Date.now()}_${Math.random()}`
  return import(`../src/tools/insights.mjs${bust}`)
}

test('metricsTool returns computeMetrics payload matching MetricsResponse schema', async () => {
  const home = tmpHome()
  const env = { AGENT_HUB_HOME: home }
  const { metricsTool } = await freshInsights()

  writeJob(home, {
    jobId: 'j1',
    agent: 'agy',
    model: 'gemini-3.8-flash-low',
    mode: 'read',
    taskType: 'recon',
    status: 'succeeded',
    tokens: 2000,
    createdAt: '2026-09-15T00:00:00.000Z',
    updatedAt: '2026-09-15T00:00:10.000Z',
  })

  const res = await metricsTool({ env })
  assert.equal(typeof res.generatedAt, 'string')
  assert.deepEqual(res.groupBy, ['agent', 'model', 'mode', 'taskType'])
  assert.equal(res.rows.length, 1)
  assert.equal(res.rows[0].agent, 'agy')
  assert.equal(res.rows[0].samples, 1)

  // Verify against Zod schema
  MetricsResponse.parse(res)
})

test('metricsTool forwards custom groupBy and env', async () => {
  const home = tmpHome()
  const env = { AGENT_HUB_HOME: home }
  const { metricsTool } = await freshInsights()

  writeJob(home, {
    jobId: 'j1',
    agent: 'agy',
    model: 'm1',
    mode: 'read',
    status: 'succeeded',
    createdAt: '2026-09-15T00:00:00.000Z',
    updatedAt: '2026-09-15T00:00:05.000Z',
  })

  const res = await metricsTool({ groupBy: ['agent'], env })
  assert.deepEqual(res.groupBy, ['agent'])
  assert.equal(res.rows.length, 1)
  assert.equal(res.rows[0].agent, 'agy')
})

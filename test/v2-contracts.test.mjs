// Contract tests for the v2 modules. They pin signatures and empty-state
// behavior, so they stay valid when the real implementations replace the stubs.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-v2-contracts-'))
}

async function fresh(home) {
  process.env.AGENT_HUB_HOME = home
  const bust = `?t=${Date.now()}${Math.random()}`
  return {
    config: await import(`../src/config.mjs${bust}`),
    metrics: await import(`../src/metrics.mjs${bust}`),
    timeouts: await import(`../src/timeouts.mjs${bust}`),
    proposals: await import(`../src/proposals.mjs${bust}`),
    learnings: await import(`../src/learnings.mjs${bust}`),
  }
}

test('config exposes v2 store paths and constants', async () => {
  const home = tmpHome()
  const { config } = await fresh(home)
  const p = config.paths({ AGENT_HUB_HOME: home })
  assert.equal(p.proposalsFile, path.join(home, 'proposals.json'))
  assert.equal(p.learningsFile, path.join(home, 'learnings.json'))
  assert.equal(config.METRICS_MIN_SAMPLES, 10)
  assert.equal(config.TURN_DEPTH_WARNING, 5)
  assert.equal(config.LEARNINGS_MAX, 3)
  assert.equal(config.LEARNING_TEXT_MAX, 300)
  assert.equal(typeof config.ADAPTIVE_TIMEOUT.multiplier, 'number')
  assert.equal(typeof config.ADAPTIVE_TIMEOUT.capS, 'number')
  assert.equal(config.PROPOSAL_REJECT_COOLDOWN_MS, 7 * 24 * 60 * 60 * 1000)
})

test('metrics on an empty home: no rows, metricsFor returns null', async () => {
  const home = tmpHome()
  const { metrics } = await fresh(home)
  const env = { AGENT_HUB_HOME: home }
  const result = metrics.computeMetrics({ env })
  assert.deepEqual(result.rows, [])
  assert.deepEqual(result.groupBy, ['agent', 'model', 'mode', 'taskType'])
  assert.equal(typeof result.generatedAt, 'string')
  assert.equal(metrics.metricsFor({ agent: 'agy', model: 'gemini-3.8-flash-low', mode: 'read', taskType: 'recon', env }), null)
})

test('timeouts: explicit wins; with no history the static default is used', async () => {
  const home = tmpHome()
  const { timeouts, config } = await fresh(home)
  const env = { AGENT_HUB_HOME: home }
  assert.deepEqual(timeouts.resolveEffectiveTimeoutS({ agent: 'agy', model: 'gemini-3.8-flash-low', mode: 'read', explicit: 42, env }), {
    timeoutS: 42,
    source: 'explicit',
    p95Ms: null,
    samples: 0,
  })
  const fallback = timeouts.resolveEffectiveTimeoutS({ agent: 'agy', model: 'gemini-3.8-flash-low', mode: 'read', env })
  assert.equal(fallback.timeoutS, config.resolveTimeoutS('agy', 'gemini-3.8-flash-low'))
  assert.equal(fallback.source, 'default')
})

test('proposals on an empty home: nothing computed, listed or applied; unknown ids throw', async () => {
  const home = tmpHome()
  const { proposals } = await fresh(home)
  const env = { AGENT_HUB_HOME: home }
  assert.deepEqual(proposals.computeProposals({ metrics: { rows: [] }, map: {} }), [])
  assert.deepEqual(proposals.listProposals({}, env), [])
  assert.equal(proposals.acceptedOrderFor('recon', env), null)
  assert.throws(() => proposals.decideProposal('missing', 'accepted', env), /proposal not found/)
  assert.ok(Array.isArray(proposals.refreshProposals({ env })))
})

test('learnings on an empty home: nothing listed or selected; augmentTask with none is a no-op', async () => {
  const home = tmpHome()
  const { learnings } = await fresh(home)
  const env = { AGENT_HUB_HOME: home }
  assert.deepEqual(learnings.listLearnings({}, env), [])
  assert.deepEqual(learnings.selectLearnings({ agent: 'agy', model: 'x', taskType: 'recon', env }), [])
  assert.deepEqual(learnings.augmentTask('do the thing', []), { task: 'do the thing', learningIds: [] })
  assert.throws(() => learnings.decideLearning('missing', 'approved', env), /learning not found/)
  assert.throws(() => learnings.deleteLearning('missing', env), /learning not found/)
  assert.equal(typeof learnings.proposeLearning, 'function')
})

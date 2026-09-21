import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {
  DEFAULT_POLICY,
  normalizePolicy,
  decideNotification,
} from '../src/notify/policy.mjs'

test('DEFAULT_POLICY is frozen and has all required categories', () => {
  assert.ok(Object.isFrozen(DEFAULT_POLICY))
  const categories = [
    'job.finished',
    'job.failed',
    'jules.waiting',
    'jules.attention_required',
    'workflow.completed',
  ]
  for (const cat of categories) {
    assert.ok(DEFAULT_POLICY[cat], `missing category ${cat}`)
    assert.ok(Object.isFrozen(DEFAULT_POLICY[cat]))
    assert.ok(Object.isFrozen(DEFAULT_POLICY[cat].channels))
    assert.ok(Array.isArray(DEFAULT_POLICY[cat].channels))
    assert.ok(['info', 'warn', 'error'].includes(DEFAULT_POLICY[cat].severity))
    assert.equal(typeof DEFAULT_POLICY[cat].dedupMs, 'number')
  }
  assert.deepEqual(DEFAULT_POLICY['job.finished'], { channels: ['console'], severity: 'info', dedupMs: 0 })
  assert.deepEqual(DEFAULT_POLICY['job.failed'], { channels: ['console', 'file'], severity: 'error', dedupMs: 0 })
  assert.deepEqual(DEFAULT_POLICY['jules.waiting'], { channels: ['console', 'file'], severity: 'warn', dedupMs: 60000 })
  assert.deepEqual(DEFAULT_POLICY['jules.attention_required'], { channels: ['console', 'file', 'webhook'], severity: 'error', dedupMs: 300000 })
  assert.deepEqual(DEFAULT_POLICY['workflow.completed'], { channels: ['console', 'file'], severity: 'info', dedupMs: 0 })
})

test('normalizePolicy merges defaults and drops junk', () => {
  const custom = {
    'job.finished': { channels: ['console', 'slack', 'carrier-pigeon'], dedupMs: NaN },
    'jules.waiting': { dedupMs: Infinity },
    'job.failed': { channels: ['file'], severity: 'warn', dedupMs: 12000 },
  }
  const policy = normalizePolicy(custom)

  assert.deepEqual(policy['job.finished'], {
    channels: ['console'],
    severity: 'info',
    dedupMs: 0,
  })

  assert.deepEqual(policy['jules.waiting'], {
    channels: ['console', 'file'],
    severity: 'warn',
    dedupMs: 60000,
  })

  assert.deepEqual(policy['job.failed'], {
    channels: ['file'],
    severity: 'warn',
    dedupMs: 12000,
  })

  assert.deepEqual(policy['workflow.completed'], DEFAULT_POLICY['workflow.completed'])
  assert.deepEqual(policy['jules.attention_required'], DEFAULT_POLICY['jules.attention_required'])

  assert.doesNotThrow(() => normalizePolicy(null))
  assert.doesNotThrow(() => normalizePolicy(undefined))
  assert.doesNotThrow(() => normalizePolicy('invalid'))
  assert.deepEqual(normalizePolicy(null)['job.finished'], DEFAULT_POLICY['job.finished'])
})

test('decideNotification returns the documented shapes', () => {
  const res = decideNotification({ category: 'job.finished' })
  assert.equal(typeof res.deliver, 'boolean')
  assert.ok(Array.isArray(res.channels))
  assert.equal(typeof res.severity, 'string')
  assert.equal(typeof res.reason, 'string')
  assert.deepEqual(res, {
    deliver: true,
    channels: ['console'],
    severity: 'info',
    reason: 'delivered',
  })
})

test('dedup suppresses a second event inside the window and allows it after', () => {
  const history = {}
  const now = 1000000
  const category = 'jules.waiting'

  const first = decideNotification({ category, history, now })
  assert.equal(first.deliver, true)
  assert.equal(first.reason, 'delivered')
  assert.deepEqual(first.channels, ['console', 'file'])
  assert.equal(first.severity, 'warn')
  history[category] = now

  const inside = decideNotification({ category, history, now: now + 30000 })
  assert.equal(inside.deliver, false)
  assert.equal(inside.reason, 'deduped')
  assert.deepEqual(inside.channels, [])
  assert.equal(inside.severity, 'warn')

  const after = decideNotification({ category, history, now: now + 61000 })
  assert.equal(after.deliver, true)
  assert.equal(after.reason, 'delivered')
  assert.deepEqual(after.channels, ['console', 'file'])
  assert.equal(after.severity, 'warn')
})

test('unknown category is not delivered', () => {
  const res1 = decideNotification({ category: 'unregistered.event' })
  assert.deepEqual(res1, {
    deliver: false,
    channels: [],
    severity: 'info',
    reason: 'unknown category',
  })

  const res2 = decideNotification({ category: null })
  assert.deepEqual(res2, {
    deliver: false,
    channels: [],
    severity: 'info',
    reason: 'unknown category',
  })

  const res3 = decideNotification({})
  assert.deepEqual(res3, {
    deliver: false,
    channels: [],
    severity: 'info',
    reason: 'unknown category',
  })
})

test('a direct custom policy overrides the default channels', () => {
  const customPolicy = {
    'job.finished': {
      channels: ['webhook'],
      severity: 'error',
      dedupMs: 0,
    },
  }

  const res = decideNotification({
    category: 'job.finished',
    policy: customPolicy,
  })

  assert.deepEqual(res, {
    deliver: true,
    channels: ['webhook'],
    severity: 'error',
    reason: 'delivered',
  })
})

test('watcher gates events through policy dedup in watchEvents', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-policy-watch-'))
  const env = { AGENT_HUB_HOME: tmpDir }
  const { appendEvent } = await import(`../src/eventlog.mjs?t=${Date.now()}-policy-test`)
  const { watchEvents } = await import(`../src/notify/watch.mjs?t=${Date.now()}-policy-test`)

  const delivered = []
  const handle = watchEvents({
    env,
    onEvent: (e) => delivered.push(e),
  })

  appendEvent({ kind: 'job.started', waiting: true, title: 'wait 1' }, { env })
  appendEvent({ kind: 'job.started', waiting: true, title: 'wait 2' }, { env })
  await handle.poll()

  assert.equal(delivered.length, 1)
  assert.equal(delivered[0].title, 'wait 1')

  handle.close()
})

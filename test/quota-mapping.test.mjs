import test from 'node:test'
import assert from 'node:assert/strict'
import { quotaFor } from '../src/quota/mapping.mjs'

test('opencode free models are not metered', () => {
  const result = quotaFor({ agent: 'opencode', model: 'opencode/muse-spark-1.3-contributor-free' }, {})
  assert.deepEqual(result, { note: 'not metered by CodexBar' })
})

test('opencode go is metered', () => {
  const usage = {
    opencodego: [{
      usage: {
        primary: { usedPercent: 10, resetsAt: '2026-09-16T17:29:01Z', windowMinutes: 300 },
        secondary: { usedPercent: 20, resetsAt: '2026-09-20T23:59:59Z', windowMinutes: 10080 },
        tertiary: { usedPercent: 30, resetsAt: '2026-10-07T03:40:05Z', windowMinutes: 43200 },
        dataConfidence: 'estimated',
        updatedAt: '2026-09-16T12:29:01Z'
      }
    }]
  }
  const result = quotaFor({ agent: 'opencode', model: 'opencode-go/default' }, usage)
  assert.equal(result.provider, 'opencodego')
  assert.equal(result.exhausted, false)
  assert.equal(result.windows.length, 3)
  assert.equal(result.windows[0].id, 'opencodego-primary')
  assert.equal(result.windows[0].usedPercent, 10)
  assert.equal(result.dataConfidence, 'estimated')
})

test('usageKnown false reports null usedPercent and does not trigger exhausted', () => {
  const usage = {
    antigravity: [{
      usage: {
        primary: { usedPercent: 10 },
        extraRateWindows: [
          {
            id: 'antigravity-quota-summary-3p-5h',
            title: 'Claude/GPT 5-hour',
            usageKnown: false,
            window: { usedPercent: 0, resetsAt: '2026-09-16T17:28:59Z', windowMinutes: 300 }
          }
        ]
      }
    }]
  }
  const result = quotaFor({ agent: 'agy', model: 'claude-sonnet-4-6' }, usage)
  assert.equal(result.exhausted, false)
  const window = result.windows.find(w => w.id === 'antigravity-quota-summary-3p-5h')
  assert.equal(window.usageKnown, false)
  assert.equal(window.usedPercent, null)
})

test('exhausted when >= 100 on known window', () => {
  const usage = {
    copilot: [{
      usage: {
        primary: { usedPercent: 100, resetsAt: '2026-10-01T00:00:00Z' }
      }
    }]
  }
  const result = quotaFor({ agent: 'copilot', model: 'auto' }, usage)
  assert.equal(result.exhausted, true)
  assert.equal(result.nextResetAt, '2026-10-01T00:00:00.000Z')
})


import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { appendEvent } from '../src/eventlog.mjs'

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-router-class-breakers-'))
}

async function fresh(home) {
  process.env.AGENT_HUB_HOME = home
  return import('../src/router.mjs?t=' + Date.now() + Math.random())
}

test('route skips candidate if billing breaker trips after one failure, but not timeout after one failure', async () => {
  const home = tmpHome()
  const { route } = await fresh(home)
  const env = { AGENT_HUB_HOME: home }

  // 1. One timeout error
  appendEvent({
    kind: 'job.failed',
    agent: 'opencode',
    model: 'deepseek/deepseek-v4-flash', // Used in mechanical-edit
    errorClass: 'timeout',
    ts: new Date().toISOString()
  }, { env })

  let result = await route({ taskType: 'mechanical-edit', env })

  // Opencode should still be usable (timeout threshold is 3)
  assert.equal(
    result.skipped.find(s => s.agent === 'opencode' && s.model === 'deepseek/deepseek-v4-flash'),
    undefined,
    'opencode should not be skipped due to a single timeout failure'
  )

  // 2. One billing error
  appendEvent({
    kind: 'job.failed',
    agent: 'copilot',
    model: 'auto', // Used in mechanical-edit
    errorClass: 'billing',
    ts: new Date().toISOString()
  }, { env })

  result = await route({ taskType: 'mechanical-edit', env })

  // Copilot should be skipped because billing threshold is 1
  const skippedCopilot = result.skipped.find(s => s.agent === 'copilot' && s.model === 'auto')
  assert.ok(skippedCopilot, 'copilot should be skipped due to a single billing failure')
  assert.equal(skippedCopilot.reason, 'breaker_open:billing')
})

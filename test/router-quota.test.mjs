import test from 'node:test'
import assert from 'node:assert/strict'
import { route, DELEGATION_MAP } from '../src/router.mjs'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const dirname = path.dirname(fileURLToPath(import.meta.url))
const readJson = (file) => JSON.parse(fs.readFileSync(path.join(dirname, 'fixtures', 'codexbar', file), 'utf8'))

function isolated(overrides = {}) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-test-'))
  return {
    ...process.env,
    AGENT_HUB_HOME: tempDir,
    AGENT_HUB_CODEXBAR_URL: 'http://127.0.0.1:8787',
    ...overrides,
  }
}

test('route returns identical result with quota data present and absent', async () => {
  const env = isolated()

  // Base case without quota data (fetch throws)
  const fetchAbsent = async () => {
    throw new Error('fetch failed')
  }

  // Base case with exhausted quota data
  const fetchPresent = async (url) => {
    if (url.includes('antigravity')) return { ok: true, json: async () => readJson('antigravity.json') }
    if (url.includes('copilot')) return { ok: true, json: async () => readJson('copilot.json') }
    throw new Error('Not found')
  }

  // Intercept the fetch inside codexbar by overwriting global fetch
  const originalFetch = global.fetch

  try {
    global.fetch = fetchAbsent
    const resultAbsent = await route({ taskType: 'triage', env })
    
    global.fetch = fetchPresent
    const resultPresent = await route({ taskType: 'triage', env })

    // Strip out the .quota object from the present result to compare structurally
    const stripQuota = (res) => {
      const cloned = JSON.parse(JSON.stringify(res))
      if (cloned.primary) delete cloned.primary.quota
      cloned.fallbacks.forEach(f => delete f.quota)
      return cloned
    }

    assert.deepEqual(stripQuota(resultAbsent), stripQuota(resultPresent))

    // Confirm that the 'present' result correctly detected the exhaustion
    assert.deepEqual(resultPresent.primary.quota, { note: 'not metered by CodexBar' }) // muse-spark is free (not metered)
    assert.equal(resultPresent.fallbacks[0].quota.exhausted, true) // copilot is exhausted in fixture

  } finally {
    global.fetch = originalFetch
  }
})

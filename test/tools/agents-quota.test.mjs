import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { agentsQuotaTool } from '../../src/tools/agents.mjs'

const tmpEnv = () => ({ AGENT_HUB_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-quota-tool-')) })

const codexUsage = {
  codex: [{ provider: 'codex', usage: { primary: { usedPercent: 54, resetsAt: '2026-10-08T18:03:47Z', windowMinutes: 43200 } } }],
}

// Observed for real right after the quota work merged: codex:default appeared
// twice in agents_quota. The tool appended codex whenever discovery found it,
// written before codex joined the delegation map — and once it joined, the
// pair came from both places.
test('agents_quota returns exactly one row per agent/model, even when codex is both in the map and discovered', async () => {
  const result = await agentsQuotaTool({
    env: tmpEnv(),
    pairsFn: () => [{ agent: 'copilot', model: 'auto' }, { agent: 'codex', model: 'default' }],
    readDiscoveryFn: () => ({ codex: { binPath: '/bin/codex' } }),
    fetchUsageFn: async () => codexUsage,
  })
  const keys = result.map((row) => `${row.agent}:${row.model}`)
  assert.deepEqual(keys, [...new Set(keys)])
  assert.equal(keys.filter((key) => key === 'codex:default').length, 1)
})

test('agents_quota still adds codex when it is discovered but absent from the delegation map', async () => {
  const result = await agentsQuotaTool({
    env: tmpEnv(),
    pairsFn: () => [{ agent: 'copilot', model: 'auto' }],
    readDiscoveryFn: () => ({ codex: { binPath: '/bin/codex' } }),
    fetchUsageFn: async () => codexUsage,
  })
  assert.deepEqual(result.map((row) => `${row.agent}:${row.model}`), ['copilot:auto', 'codex:default'])
})

test('agents_quota does not add codex when it is not discovered', async () => {
  const result = await agentsQuotaTool({
    env: tmpEnv(),
    pairsFn: () => [{ agent: 'copilot', model: 'auto' }],
    readDiscoveryFn: () => ({}),
    fetchUsageFn: async () => ({}),
  })
  assert.deepEqual(result.map((row) => `${row.agent}:${row.model}`), ['copilot:auto'])
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-tools-learnings-'))
}

async function fresh(home) {
  process.env.AGENT_HUB_HOME = home
  return import('../src/tools/learnings.mjs?t=' + Date.now() + Math.random())
}

test('learningProposeTool stores the learning as pending and returns a note pointing at the dashboard approvals tab', async () => {
  const home = tmpHome()
  const env = { AGENT_HUB_HOME: home }
  const { learningProposeTool } = await fresh(home)

  const result = await learningProposeTool({ agent: 'agy', model: 'x', taskType: 'recon', text: 'hangs on long prompts' }, { env })

  assert.equal(result.learning.status, 'pending')
  assert.equal(result.learning.agent, 'agy')
  assert.equal(result.learning.text, 'hangs on long prompts')
  assert.equal(result.note, 'Stored as pending. A human must approve it in the dashboard (#/approvals?tab=learnings) before it is used.')

  const file = JSON.parse(fs.readFileSync(path.join(home, 'learnings.json'), 'utf8'))
  assert.equal(file.learnings.length, 1)
  assert.equal(file.learnings[0].id, result.learning.id)
})

test('learningProposeTool propagates validation errors', async () => {
  const home = tmpHome()
  const env = { AGENT_HUB_HOME: home }
  const { learningProposeTool } = await fresh(home)

  assert.throws(() => learningProposeTool({ text: '' }, { env }))
})

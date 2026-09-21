import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { writeArtifact } from '../src/artifacts.mjs'
import { resetDbInstances } from '../src/storage/db.mjs'

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-context-test-'))
}

async function loadContext() {
  return import(`../src/context.mjs?t=${Date.now()}_${Math.random()}`)
}

afterEach(() => {
  resetDbInstances()
})

test('write/read round-trip', async () => {
  const home = tmpHome()
  const env = { AGENT_HUB_HOME: home }
  const { writeHandoff, readHandoff } = await loadContext()

  const handoff = { summary: 'Implementation complete', findings: ['Found auth bug'] }
  const written = writeHandoff({ workflowId: 'wf-1', stepId: 'step-1', handoff }, env)
  assert.equal(written.summary, 'Implementation complete')
  assert.deepEqual(written.findings, ['Found auth bug'])

  const read = readHandoff({ workflowId: 'wf-1', stepId: 'step-1' }, env)
  assert.deepEqual(read, written)
})

test('invalid handoff throws and nothing is persisted', async () => {
  const home = tmpHome()
  const env = { AGENT_HUB_HOME: home }
  const { writeHandoff, readHandoff } = await loadContext()

  assert.throws(
    () => {
      writeHandoff({ workflowId: 'wf-inv', stepId: 'step-inv', handoff: { summary: '' } }, env)
    },
    (err) => {
      return err instanceof Error &&
        err.message.startsWith('invalid handoff:') &&
        err.message.includes('summary')
    }
  )

  const read = readHandoff({ workflowId: 'wf-inv', stepId: 'step-inv' }, env)
  assert.equal(read, null)

  const siblingPath = path.join(home, 'runs', 'wf-inv', 'step-inv', 'artifacts', 'handoff.json')
  assert.equal(fs.existsSync(siblingPath), false)
})

test('the JSON sibling exists at runs/<wf>/<step>/artifacts/handoff.json', async () => {
  const home = tmpHome()
  const env = { AGENT_HUB_HOME: home }
  const { writeHandoff } = await loadContext()

  writeHandoff({ workflowId: 'wf-sib', stepId: 'step-sib', handoff: { summary: 'Sibling check' } }, env)

  const siblingPath = path.join(home, 'runs', 'wf-sib', 'step-sib', 'artifacts', 'handoff.json')
  assert.equal(fs.existsSync(siblingPath), true)
  const content = JSON.parse(fs.readFileSync(siblingPath, 'utf8'))
  assert.equal(content.summary, 'Sibling check')
})

test('listHandoffs returns all handoffs for workflow', async () => {
  const home = tmpHome()
  const env = { AGENT_HUB_HOME: home }
  const { writeHandoff, listHandoffs } = await loadContext()

  writeHandoff({ workflowId: 'wf-list', stepId: 'step-a', handoff: { summary: 'Step A done' } }, env)
  writeHandoff({ workflowId: 'wf-list', stepId: 'step-b', handoff: { summary: 'Step B done' } }, env)

  const list = listHandoffs('wf-list', env)
  assert.equal(list.length, 2)
  assert.equal(list[0].stepId, 'step-a')
  assert.equal(list[0].handoff.summary, 'Step A done')
  assert.equal(list[1].stepId, 'step-b')
  assert.equal(list[1].handoff.summary, 'Step B done')
})

test('addContext validation (unknown kind throws) and listContext ordering/filtering', async () => {
  const home = tmpHome()
  const env = { AGENT_HUB_HOME: home }
  const { addContext, listContext } = await loadContext()

  assert.throws(
    () => {
      addContext({ workflowId: 'wf-ctx', kind: 'unknown-kind', text: 'bad' }, env)
    },
    (err) => err instanceof Error && /kind/i.test(err.message)
  )

  const e1 = addContext({ workflowId: 'wf-ctx', stepId: 'step-1', kind: 'note', text: 'first note' }, env)
  const e2 = addContext({ workflowId: 'wf-ctx', stepId: 'step-2', kind: 'decision', text: 'chose sqlite' }, env)
  const e3 = addContext({ workflowId: 'wf-ctx', stepId: 'step-1', kind: 'finding', text: 'wal mode needed' }, env)

  assert.ok(e1.id)
  assert.ok(e2.id > e1.id)
  assert.ok(e3.id > e2.id)

  const all = listContext({ workflowId: 'wf-ctx' }, env)
  assert.equal(all.length, 3)
  assert.deepEqual(all.map((e) => e.id), [e1.id, e2.id, e3.id])

  const step1Entries = listContext({ workflowId: 'wf-ctx', stepId: 'step-1' }, env)
  assert.equal(step1Entries.length, 2)
  assert.equal(step1Entries[0].id, e1.id)
  assert.equal(step1Entries[1].id, e3.id)

  const step2Entries = listContext({ workflowId: 'wf-ctx', stepId: 'step-2' }, env)
  assert.equal(step2Entries.length, 1)
  assert.equal(step2Entries[0].id, e2.id)
})

test('fallback read from the JSON sibling when the DB has no row', async () => {
  const home = tmpHome()
  const env = { AGENT_HUB_HOME: home }
  const { readHandoff } = await loadContext()

  const directHandoff = { summary: 'Direct artifact handoff', findings: [] }
  writeArtifact({
    workflowId: 'wf-fallback',
    stepId: 'step-fb',
    name: 'handoff.json',
    content: JSON.stringify(directHandoff, null, 2)
  }, env)

  const read = readHandoff({ workflowId: 'wf-fallback', stepId: 'step-fb' }, env)
  assert.ok(read)
  assert.equal(read.summary, 'Direct artifact handoff')
})

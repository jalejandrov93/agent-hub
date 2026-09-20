import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { recordOrigin, getOrigin, recordDispatchOrigin, harnessSessionIdFromExtra } from '../src/harness/origin.mjs'
import { closeDb } from '../src/storage/index.mjs'
import { generic } from '../src/harness/generic.mjs'
import { claudeCode } from '../src/harness/claude-code.mjs'
import { opencode } from '../src/harness/opencode.mjs'

function tmpEnv() {
  return { AGENT_HUB_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-c12-origin-')) }
}

test('C1.2 origin: record/get round-trip jobId -> harness session', () => {
  const env = tmpEnv()
  try {
    const row = recordOrigin({ jobId: 'job-1', harnessSessionId: 'sess-abc', harness: 'claude-code', env })
    assert.equal(row.job_id, 'job-1')
    assert.equal(row.harness_session_id, 'sess-abc')
    assert.equal(row.harness, 'claude-code')
    assert.deepEqual(getOrigin('job-1', { env }), row)
  } finally { closeDb(env) }
})

test('C1.2 origin: get desconocido -> null; record sin jobId -> null', () => {
  const env = tmpEnv()
  try {
    assert.equal(getOrigin('ghost', { env }), null)
    assert.equal(recordOrigin({ harnessSessionId: 's', env }), null)
    assert.equal(recordOrigin({ jobId: '', harnessSessionId: 's', env }), null)
  } finally { closeDb(env) }
})

test('C1.2 origin: upsert sobrescribe el mismo jobId', () => {
  const env = tmpEnv()
  try {
    recordOrigin({ jobId: 'job-1', harnessSessionId: 'sess-old', harness: 'generic', env })
    recordOrigin({ jobId: 'job-1', harnessSessionId: 'sess-new', harness: 'opencode', env })
    const row = getOrigin('job-1', { env })
    assert.equal(row.harness_session_id, 'sess-new')
    assert.equal(row.harness, 'opencode')
  } finally { closeDb(env) }
})

test('C1.2 origin: harnessSessionIdFromExtra lee _meta/sessionId y variantes', () => {
  assert.equal(harnessSessionIdFromExtra({ _meta: { sessionId: 'm1' } }), 'm1')
  assert.equal(harnessSessionIdFromExtra({ sessionId: 's1' }), 's1')
  assert.equal(harnessSessionIdFromExtra({ harnessSessionId: 'h1' }), 'h1')
  assert.equal(harnessSessionIdFromExtra({}), null)
  assert.equal(harnessSessionIdFromExtra(null), null)
  assert.equal(harnessSessionIdFromExtra('nope'), null)
})

test('C1.2 origin: recordDispatchOrigin solo persiste con jobId + sesión', () => {
  const env = tmpEnv()
  try {
    const row = recordDispatchOrigin({ jobId: 'job-9', extra: { _meta: { sessionId: 'hs-9' } }, harness: 'opencode', env })
    assert.equal(row.harness_session_id, 'hs-9')
    assert.equal(recordDispatchOrigin({ jobId: 'job-10', extra: {}, env }), null)
    assert.equal(getOrigin('job-10', { env }), null)
    assert.equal(recordDispatchOrigin({ extra: { sessionId: 'hs-x' }, env }), null)
  } finally { closeDb(env) }
})

test('C1.2 origin: recordDispatchOrigin nunca lanza', () => {
  assert.equal(recordDispatchOrigin({ jobId: 'j', extra: { get _meta() { throw new Error('boom') } } }), null)
})

test('C1.2 origin: todos los profiles declaran supportsWake=false (mapping-only, sin wake-up)', () => {
  for (const profile of [generic, claudeCode, opencode]) {
    assert.equal(profile.supportsWake, false, `profile ${profile.id} debe declarar supportsWake=false`)
  }
})

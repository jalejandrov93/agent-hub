import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { paths } from '../src/config.mjs'
import {
  listAccounts,
  getAccountSecret,
  createAccount,
  updateAccount,
  deleteAccount,
  readPolicy,
  setPolicy,
  markAccountUsed,
  usageFor,
} from '../src/accounts.mjs'
import { createJob, updateResult } from '../src/jobstore.mjs'

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-accounts-'))
}

const envFor = (home) => ({ AGENT_HUB_HOME: home })

test('createAccount stores the raw key but returns a MASKED account (no apiKey)', () => {
  const env = envFor(tmpHome())
  const account = createAccount({ label: 'pro-a', apiKey: 'key-aaa' }, env)

  assert.ok(account.id)
  assert.equal(account.label, 'pro-a')
  assert.equal(account.apiKey, undefined, 'createAccount must never echo the raw key back')
  assert.equal(account.keyPresent, true)
  assert.equal(account.keyLast4, '-aaa')
  assert.equal(getAccountSecret(account.id, env), 'key-aaa')
})

test('listAccounts NEVER contains a raw key — the property the dashboard depends on', () => {
  const env = envFor(tmpHome())
  createAccount({ label: 'a', apiKey: 'key-aaa' }, env)
  createAccount({ label: 'b', apiKey: 'key-bbb' }, env)

  const accounts = listAccounts(env)
  assert.equal(accounts.length, 2)
  const serialized = JSON.stringify(accounts)
  assert.ok(!serialized.includes('key-aaa'), 'raw key A must not appear anywhere in listAccounts output')
  assert.ok(!serialized.includes('key-bbb'), 'raw key B must not appear anywhere in listAccounts output')
  for (const account of accounts) {
    assert.equal(account.apiKey, undefined)
    assert.equal(account.keyPresent, true)
    assert.equal(account.keyLast4.length, 4)
  }
})

test('accounts.json is created with mode 0600 because it holds credentials', () => {
  const home = tmpHome()
  const env = envFor(home)
  createAccount({ label: 'a', apiKey: 'key-aaa' }, env)

  const mode = fs.statSync(paths(env).accountsFile).mode & 0o777
  assert.equal(mode, 0o600)
})

test('createAccount applies the documented defaults (enabled, 100/24h, 15 concurrent, append-order priority)', () => {
  const env = envFor(tmpHome())
  const first = createAccount({ label: 'a', apiKey: 'key-aaa' }, env)
  const second = createAccount({ label: 'b', apiKey: 'key-bbb' }, env)

  assert.equal(first.enabled, true)
  assert.equal(first.dailyLimit, 100)
  assert.equal(first.concurrentLimit, 15)
  assert.equal(first.priority, 0)
  assert.equal(second.priority, 1)
  assert.equal(first.lastUsedAt, null)
  assert.ok(first.createdAt)
  assert.ok(first.updatedAt)
})

test('getAccountSecret returns null for an unknown id (never throws)', () => {
  const env = envFor(tmpHome())
  assert.equal(getAccountSecret('nope', env), null)
})

test('updateAccount omitting apiKey keeps the stored key; a blank string is rejected', () => {
  const env = envFor(tmpHome())
  const account = createAccount({ label: 'a', apiKey: 'key-aaa' }, env)

  const renamed = updateAccount(account.id, { label: 'renamed' }, env)
  assert.equal(renamed.label, 'renamed')
  assert.equal(getAccountSecret(account.id, env), 'key-aaa', 'the stored key survives a patch that omits apiKey')

  assert.throws(() => updateAccount(account.id, { apiKey: '' }, env), /invalid apiKey/)
  assert.throws(() => updateAccount(account.id, { apiKey: '   ' }, env), /invalid apiKey/)
  assert.equal(getAccountSecret(account.id, env), 'key-aaa', 'a rejected patch must not touch the stored key')
})

test('updateAccount can rotate the key and change limits/enabled/priority', () => {
  const env = envFor(tmpHome())
  const account = createAccount({ label: 'a', apiKey: 'key-aaa' }, env)

  const updated = updateAccount(account.id, { apiKey: 'key-zzz', dailyLimit: 5, concurrentLimit: 2, enabled: false, priority: 9 }, env)
  assert.equal(updated.enabled, false)
  assert.equal(updated.dailyLimit, 5)
  assert.equal(updated.concurrentLimit, 2)
  assert.equal(updated.priority, 9)
  assert.equal(updated.keyLast4, '-zzz')
  assert.equal(getAccountSecret(account.id, env), 'key-zzz')
})

test('updateAccount and deleteAccount throw the proposals-style "account not found: <id>" for an unknown id', () => {
  const env = envFor(tmpHome())
  assert.throws(() => updateAccount('nope', { label: 'x' }, env), /account not found: nope/)
  assert.throws(() => deleteAccount('nope', env), /account not found: nope/)
})

test('deleteAccount removes the account and its secret', () => {
  const env = envFor(tmpHome())
  const account = createAccount({ label: 'a', apiKey: 'key-aaa' }, env)
  deleteAccount(account.id, env)

  assert.deepEqual(listAccounts(env), [])
  assert.equal(getAccountSecret(account.id, env), null)
})

test('readPolicy defaults to round_robin and setPolicy persists a valid policy', () => {
  const env = envFor(tmpHome())
  assert.equal(readPolicy(env), 'round_robin')
  assert.equal(setPolicy('least_used', env), 'least_used')
  assert.equal(readPolicy(env), 'least_used')
})

test('setPolicy rejects an unknown policy with "invalid policy: <value>"', () => {
  const env = envFor(tmpHome())
  assert.throws(() => setPolicy('bogus', env), /invalid policy: bogus/)
  assert.equal(readPolicy(env), 'round_robin', 'a rejected policy must not change the stored setting')
})

test('markAccountUsed stamps lastUsedAt for round_robin ordering', () => {
  const env = envFor(tmpHome())
  const account = createAccount({ label: 'a', apiKey: 'key-aaa' }, env)
  assert.equal(account.lastUsedAt, null)

  const used = markAccountUsed(account.id, env)
  assert.ok(used.lastUsedAt)
  assert.equal(listAccounts(env)[0].lastUsedAt, used.lastUsedAt)
})

test('markAccountUsed throws "account not found: <id>" for an unknown id', () => {
  const env = envFor(tmpHome())
  assert.throws(() => markAccountUsed('nope', env), /account not found: nope/)
})

test('usageFor counts running jobs and jobs created within a rolling 24h window for that account only', () => {
  const home = tmpHome()
  const env = envFor(home)
  const account = createAccount({ label: 'a', apiKey: 'key-aaa' }, env)
  const other = createAccount({ label: 'b', apiKey: 'key-bbb' }, env)

  const running = createJob({ agent: 'jules', model: 'jules', task: 't', cwd: '/repo', mode: 'write', env })
  updateResult(running.jobId, { status: 'running', remote: { provider: 'jules', accountId: account.id, sessionId: 's1' } }, env)

  const oldDone = createJob({ agent: 'jules', model: 'jules', task: 't', cwd: '/repo', mode: 'write', env })
  const oldCreatedAt = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString()
  updateResult(oldDone.jobId, { status: 'succeeded', createdAt: oldCreatedAt, remote: { provider: 'jules', accountId: account.id, sessionId: 's2' } }, env)

  const otherJob = createJob({ agent: 'jules', model: 'jules', task: 't', cwd: '/repo', mode: 'write', env })
  updateResult(otherJob.jobId, { status: 'running', remote: { provider: 'jules', accountId: other.id, sessionId: 's3' } }, env)

  assert.deepEqual(usageFor(account.id, env), { running: 1, last24h: 1 })
  assert.deepEqual(usageFor(other.id, env), { running: 1, last24h: 1 })
  assert.deepEqual(usageFor('unknown-account', env), { running: 0, last24h: 0 })
})

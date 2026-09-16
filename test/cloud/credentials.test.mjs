import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { keyForJob, keyForAccount, NO_KEY_MESSAGE } from '../../src/cloud/credentials.mjs'
import { createAccount } from '../../src/accounts.mjs'

// Every env handed to code under test gets its own throwaway AGENT_HUB_HOME.
// Without one, stateHome() falls back to the REAL ~/.local/share/agent-hub:
// these tests then read the user's actual accounts.json — real API keys.
const isolated = (env) => ({ AGENT_HUB_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-isolated-')), ...env })

// Injected fakes keep these tests off disk; the shapes match accounts.mjs
// (listAccounts returns MASKED accounts, getAccountSecret the raw key).
const accountsFn = (...list) => () => list
const secretsFn = (map) => (id) => map[id] ?? null

test('keyForJob uses the key of the account that started the job', () => {
  const job = { remote: { accountId: 'acct-1' } }
  const apiKey = keyForJob(job, {
    env: { JULES_API_KEY: 'env-key' },
    getAccountSecretFn: secretsFn({ 'acct-1': 'key-1' }),
  })
  assert.equal(apiKey, 'key-1')
})

test('keyForJob falls back to env.JULES_API_KEY for the implicit "env" account', () => {
  const job = { remote: { accountId: 'env' } }
  const apiKey = keyForJob(job, { env: { JULES_API_KEY: 'env-key' }, getAccountSecretFn: secretsFn({}) })
  assert.equal(apiKey, 'env-key')
})

test('keyForJob falls back to env.JULES_API_KEY when the job account has no stored key', () => {
  const job = { remote: { accountId: 'acct-missing' } }
  const apiKey = keyForJob(job, { env: { JULES_API_KEY: 'env-key' }, getAccountSecretFn: secretsFn({}) })
  assert.equal(apiKey, 'env-key')
})

test('keyForJob returns null when neither the job account nor env has a key', () => {
  assert.equal(keyForJob({ remote: {} }, { env: {}, getAccountSecretFn: secretsFn({}) }), null)
  assert.equal(keyForJob(null, { env: {}, getAccountSecretFn: secretsFn({}) }), null)
})

test('keyForAccount resolves an explicit account to that account\'s stored key', () => {
  const env = { JULES_API_KEY: 'env-key' }
  const result = keyForAccount({
    account: 'acct-1',
    env,
    listAccountsFn: accountsFn(),
    getAccountSecretFn: secretsFn({ 'acct-1': 'key-1' }),
  })
  assert.deepEqual(result, { apiKey: 'key-1', accountId: 'acct-1' })
})

test('keyForAccount returns no key for an explicit account that has none', () => {
  const result = keyForAccount({
    account: 'acct-x',
    env: { JULES_API_KEY: 'env-key' },
    listAccountsFn: accountsFn(),
    getAccountSecretFn: secretsFn({}),
  })
  assert.deepEqual(result, { apiKey: null, accountId: null })
})

test('keyForAccount picks the first enabled account in priority order, skipping disabled and keyless ones', () => {
  const list = [
    { id: 'acct-disabled', enabled: false, priority: 0 },
    { id: 'acct-keyless', enabled: true, priority: 1 },
    { id: 'acct-later', enabled: true, priority: 5 },
    { id: 'acct-sooner', enabled: true, priority: 2 },
  ]
  const result = keyForAccount({
    env: {},
    listAccountsFn: accountsFn(...list),
    getAccountSecretFn: secretsFn({ 'acct-sooner': 'key-soon', 'acct-later': 'key-later' }),
  })
  assert.deepEqual(result, { apiKey: 'key-soon', accountId: 'acct-sooner' })
})

test('keyForAccount falls back to env.JULES_API_KEY with accountId "env" when no account has a key', () => {
  const result = keyForAccount({
    env: { JULES_API_KEY: 'env-key' },
    listAccountsFn: accountsFn({ id: 'acct-keyless', enabled: true, priority: 0 }),
    getAccountSecretFn: secretsFn({}),
  })
  assert.deepEqual(result, { apiKey: 'env-key', accountId: 'env' })
})

test('keyForAccount returns no key when there are no accounts and no env key', () => {
  const result = keyForAccount({ env: {}, listAccountsFn: accountsFn(), getAccountSecretFn: secretsFn({}) })
  assert.deepEqual(result, { apiKey: null, accountId: null })
})

test('keyForAccount defaults read accounts.json from AGENT_HUB_HOME with no caller wiring', () => {
  const env = isolated({})
  const account = createAccount({ label: 'a', apiKey: 'key-aaa' }, env)
  const result = keyForAccount({ env })
  assert.deepEqual(result, { apiKey: 'key-aaa', accountId: account.id })
})

test('NO_KEY_MESSAGE names both ways to configure a key', () => {
  assert.match(NO_KEY_MESSAGE, /account in the dashboard/i)
  assert.match(NO_KEY_MESSAGE, /JULES_API_KEY/)
})

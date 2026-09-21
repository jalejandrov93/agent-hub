import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { filterEnv, resolveSandboxProfile, sandboxTelemetry, SANDBOX_PROFILES } from '../src/sandbox.mjs'

test('filterEnv redacts the 8 secret families and preserves PATH/LANG/TZ', () => {
  const env = {
    PATH: '/usr/bin',
    LANG: 'en_US.UTF-8',
    TZ: 'UTC',
    MY_TOKEN: 'abc',
    AWS_SECRET_ACCESS_KEY: 'x',
    AWS_ACCESS_KEY_ID: 'y',
    GH_TOKEN: 'ghp_test',
    ANTHROPIC_API_KEY: 'sk-ant',
    OPENAI_API_KEY: 'sk-openai',
    JULES_API_KEY: 'jules-secret',
    FOO_SECRET: 'bar',
    MY_API_KEY: 'key123',
    NORMAL_VAR: 'keep-me',
  }

  for (const profile of ['compatibility', 'isolated-home']) {
    const filtered = filterEnv(env, profile)

    assert.equal(filtered.PATH, '/usr/bin')
    assert.equal(filtered.LANG, 'en_US.UTF-8')
    assert.equal(filtered.TZ, 'UTC')
    assert.equal(filtered.NORMAL_VAR, 'keep-me')
    assert.equal(Object.prototype.hasOwnProperty.call(filtered, 'MY_TOKEN'), false)
    assert.equal(Object.prototype.hasOwnProperty.call(filtered, 'AWS_SECRET_ACCESS_KEY'), false)
    assert.equal(Object.prototype.hasOwnProperty.call(filtered, 'AWS_ACCESS_KEY_ID'), false)
    assert.equal(Object.prototype.hasOwnProperty.call(filtered, 'GH_TOKEN'), false)
    assert.equal(Object.prototype.hasOwnProperty.call(filtered, 'ANTHROPIC_API_KEY'), false)
    assert.equal(Object.prototype.hasOwnProperty.call(filtered, 'OPENAI_API_KEY'), false)
    assert.equal(Object.prototype.hasOwnProperty.call(filtered, 'JULES_API_KEY'), false)
    assert.equal(Object.prototype.hasOwnProperty.call(filtered, 'FOO_SECRET'), false)
    assert.equal(Object.prototype.hasOwnProperty.call(filtered, 'MY_API_KEY'), false)
  }
})

test('compatibility profile inherits HOME', () => {
  const env = { HOME: '/home/user', PATH: '/usr/bin' }
  const filtered = filterEnv(env, 'compatibility')
  assert.equal(filtered.HOME, '/home/user')
})

test('isolated-home profile sets HOME to a fresh temp directory', () => {
  const env = { HOME: '/home/user', PATH: '/usr/bin' }
  const filtered = filterEnv(env, 'isolated-home')
  assert.notEqual(filtered.HOME, '/home/user')
  assert.ok(fs.existsSync(filtered.HOME), 'HOME must point to an existing temp dir')
  assert.deepEqual(fs.readdirSync(filtered.HOME), [], 'temp HOME must be empty')
})

test('isolated profile also isolates HOME', () => {
  const env = { HOME: '/home/user', PATH: '/usr/bin' }
  const filtered = filterEnv(env, 'isolated')
  assert.notEqual(filtered.HOME, '/home/user')
  assert.ok(fs.existsSync(filtered.HOME))
})

test('resolveSandboxProfile returns the profile for valid names', () => {
  assert.equal(resolveSandboxProfile('compatibility'), 'compatibility')
  assert.equal(resolveSandboxProfile('isolated-home'), 'isolated-home')
  assert.equal(resolveSandboxProfile('isolated'), 'isolated')
})

test('resolveSandboxProfile falls back to compatibility for bogus names', () => {
  assert.equal(resolveSandboxProfile('bogus'), 'compatibility')
  assert.equal(resolveSandboxProfile(''), 'compatibility')
  assert.equal(resolveSandboxProfile(undefined), 'compatibility')
})

test('sandboxTelemetry counts redactions and reports homeIsolation', () => {
  const original = { MY_TOKEN: 'abc', PATH: '/usr/bin', AWS_SECRET: 'x' }
  const filtered = { PATH: '/usr/bin' }

  const telemetry = sandboxTelemetry(filtered, original, 'compatibility')
  assert.equal(telemetry.profile, 'compatibility')
  assert.equal(telemetry.envRedactions, 2)
  assert.equal(telemetry.homeIsolation, false)
})

test('sandboxTelemetry reports homeIsolation true for isolated-home', () => {
  const original = { HOME: '/home/user' }
  const filtered = { HOME: '/tmp/agent-hub-sandbox-home-xxx' }

  const telemetry = sandboxTelemetry(filtered, original, 'isolated-home')
  assert.equal(telemetry.profile, 'isolated-home')
  assert.equal(telemetry.homeIsolation, true)
})

test('SANDBOX_PROFILES matches SANDBOX config from config.mjs', async () => {
  const { SANDBOX } = await import('../src/config.mjs')
  assert.equal(SANDBOX.defaultProfile, 'compatibility')
  assert.deepEqual(Object.keys(SANDBOX.profiles).sort(), ['compatibility', 'isolated', 'isolated-home'])
  assert.equal(SANDBOX.profiles.compatibility.inheritHome, true)
  assert.equal(SANDBOX.profiles['isolated-home'].inheritHome, false)
})

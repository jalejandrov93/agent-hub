import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
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
  assert.equal(filtered.AGENT_HUB_SANDBOX_DIR, undefined)
})

test('isolated-home profile sets HOME to a fresh temp directory', () => {
  const env = { HOME: '/home/user', PATH: '/usr/bin' }
  const filtered = filterEnv(env, 'isolated-home')
  assert.notEqual(filtered.HOME, '/home/user')
  assert.ok(fs.existsSync(filtered.HOME), 'HOME must point to an existing temp dir')
  assert.deepEqual(fs.readdirSync(filtered.HOME), [], 'temp HOME must be empty')
  assert.equal(filtered.AGENT_HUB_SANDBOX_DIR, undefined)
})

test('isolated profile sets HOME, TMPDIR, XDG_* inside fresh sandbox dir and sets AGENT_HUB_SANDBOX_DIR', () => {
  const env = { HOME: '/home/user', PATH: '/usr/bin' }
  const filtered = filterEnv(env, 'isolated')

  assert.notEqual(filtered.HOME, '/home/user')
  assert.ok(filtered.AGENT_HUB_SANDBOX_DIR, 'AGENT_HUB_SANDBOX_DIR must be set')
  assert.ok(fs.existsSync(filtered.AGENT_HUB_SANDBOX_DIR), 'AGENT_HUB_SANDBOX_DIR must exist')
  assert.equal(filtered.HOME, filtered.AGENT_HUB_SANDBOX_DIR)
  assert.ok(fs.existsSync(filtered.HOME))

  assert.ok(filtered.TMPDIR, 'TMPDIR must be set')
  assert.ok(filtered.TMPDIR.startsWith(filtered.AGENT_HUB_SANDBOX_DIR), 'TMPDIR must be inside sandbox dir')
  assert.ok(fs.existsSync(filtered.TMPDIR), 'TMPDIR must exist')

  assert.ok(filtered.XDG_CACHE_HOME, 'XDG_CACHE_HOME must be set')
  assert.ok(filtered.XDG_CACHE_HOME.startsWith(filtered.AGENT_HUB_SANDBOX_DIR), 'XDG_CACHE_HOME must be inside sandbox dir')
  assert.ok(fs.existsSync(filtered.XDG_CACHE_HOME), 'XDG_CACHE_HOME must exist')

  assert.ok(filtered.XDG_CONFIG_HOME, 'XDG_CONFIG_HOME must be set')
  assert.ok(filtered.XDG_CONFIG_HOME.startsWith(filtered.AGENT_HUB_SANDBOX_DIR), 'XDG_CONFIG_HOME must be inside sandbox dir')
  assert.ok(fs.existsSync(filtered.XDG_CONFIG_HOME), 'XDG_CONFIG_HOME must exist')

  assert.ok(filtered.XDG_DATA_HOME, 'XDG_DATA_HOME must be set')
  assert.ok(filtered.XDG_DATA_HOME.startsWith(filtered.AGENT_HUB_SANDBOX_DIR), 'XDG_DATA_HOME must be inside sandbox dir')
  assert.ok(fs.existsSync(filtered.XDG_DATA_HOME), 'XDG_DATA_HOME must exist')
})

test('isolated with AGENT_HUB_SANDBOX_INCLUDE pointing at a temp file copies it into sandbox; unset copies nothing', () => {
  const envWithout = { HOME: '/home/user', PATH: '/usr/bin' }
  const filteredWithout = filterEnv(envWithout, 'isolated')
  const sandboxDirWithout = filteredWithout.AGENT_HUB_SANDBOX_DIR
  const entriesWithout = fs.readdirSync(sandboxDirWithout).sort()
  assert.deepEqual(entriesWithout, ['.cache', '.config', '.local', 'tmp'].sort())

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-test-include-'))
  const testFile = path.join(tmpDir, 'test-cred.txt')
  fs.writeFileSync(testFile, 'secret-content')

  const envWith = {
    HOME: '/home/user',
    PATH: '/usr/bin',
    AGENT_HUB_SANDBOX_INCLUDE: `${testFile}, /non/existent/path/file.txt`,
  }
  const filteredWith = filterEnv(envWith, 'isolated')
  const sandboxDirWith = filteredWith.AGENT_HUB_SANDBOX_DIR

  const copiedDest = path.join(sandboxDirWith, 'test-cred.txt')
  assert.ok(fs.existsSync(copiedDest), 'included temp file must be copied to sandbox')
  assert.equal(fs.readFileSync(copiedDest, 'utf8'), 'secret-content')
  assert.ok(!fs.existsSync(path.join(sandboxDirWith, 'file.txt')), 'missing entry must be skipped')

  fs.rmSync(tmpDir, { recursive: true, force: true })
})

test('isolated with AGENT_HUB_SANDBOX_INCLUDE relative path preserves relative path under sandbox', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-test-rel-'))
  const origCwd = process.cwd()
  try {
    process.chdir(tmpDir)
    fs.mkdirSync('rel/sub', { recursive: true })
    fs.writeFileSync('rel/sub/config.json', '{"auth":true}')

    const env = {
      HOME: '/home/user',
      AGENT_HUB_SANDBOX_INCLUDE: 'rel/sub/config.json',
    }
    const filtered = filterEnv(env, 'isolated')
    const dest = path.join(filtered.AGENT_HUB_SANDBOX_DIR, 'rel/sub/config.json')
    assert.ok(fs.existsSync(dest), 'relative path must be preserved under sandbox')
    assert.equal(fs.readFileSync(dest, 'utf8'), '{"auth":true}')
  } finally {
    process.chdir(origCwd)
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('secrets are still omitted from the child env in isolated', () => {
  const env = {
    HOME: '/home/user',
    PATH: '/usr/bin',
    MY_TOKEN: 'token-val',
    AWS_SECRET_ACCESS_KEY: 'aws-val',
    GH_TOKEN: 'gh-val',
    ANTHROPIC_API_KEY: 'ant-val',
    OPENAI_API_KEY: 'oai-val',
    JULES_API_KEY: 'jules-val',
    NORMAL_VAR: 'keep',
  }
  const filtered = filterEnv(env, 'isolated')
  assert.equal(filtered.PATH, '/usr/bin')
  assert.equal(filtered.NORMAL_VAR, 'keep')
  assert.equal(Object.prototype.hasOwnProperty.call(filtered, 'MY_TOKEN'), false)
  assert.equal(Object.prototype.hasOwnProperty.call(filtered, 'AWS_SECRET_ACCESS_KEY'), false)
  assert.equal(Object.prototype.hasOwnProperty.call(filtered, 'GH_TOKEN'), false)
  assert.equal(Object.prototype.hasOwnProperty.call(filtered, 'ANTHROPIC_API_KEY'), false)
  assert.equal(Object.prototype.hasOwnProperty.call(filtered, 'OPENAI_API_KEY'), false)
  assert.equal(Object.prototype.hasOwnProperty.call(filtered, 'JULES_API_KEY'), false)
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

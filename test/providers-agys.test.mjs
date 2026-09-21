import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  PROFILE_STATES,
  normalizeProfile,
  normalizeProfiles,
  profileStateFor,
  selectProfile,
} from '../src/providers/profiles.mjs'
import {
  parseAgysList,
  parseAgysQuota,
  agysRunArgv,
  agysAutoArgv,
  isAgysAvailable,
  listAgysProfiles,
  readAgysQuota,
  runAgyWithProfile,
  resolveAgyCommand,
  resolveAgyProfile,
  resolveAgyProfileSync,
  resetSyncProfileCache,
  getAgysMode,
  setAgysMode,
  agysProfilesSnapshot,
} from '../src/providers/agys.mjs'

const FIXTURE_AGYS_LIST = `Active Profiles:
PROFILE          PRIO  EMAIL                CONFIG  PATH
work (default)   2     work@company.com     (-)     ~/.agys/profiles/work
personal         1     user@gmail.com       (-)     ~/.agys/profiles/personal
backup           0     (-)                  (-)     ~/.agys/profiles/backup
`

const FIXTURE_AGYS_QUOTA = [
  {
    profileName: 'work',
    email: 'work@company.com',
    active: true,
    quota: {
      groups: [
        {
          displayName: 'Gemini 3.8',
          description: 'Flash and Pro models',
          buckets: [
            {
              bucketId: 'flash-primary',
              displayName: 'Primary Window',
              window: '10m',
              resetTime: '2026-09-20T21:30:00Z',
              usedPercent: 45,
            },
            {
              bucketId: 'flash-secondary',
              displayName: 'Secondary Window',
              window: '1d',
              resetTime: '2026-09-21T00:00:00Z',
              usedPercent: 20,
            },
          ],
        },
      ],
    },
  },
  {
    profileName: 'personal',
    email: 'user@gmail.com',
    active: false,
    quota: {
      groups: [
        {
          displayName: 'Gemini 3.8',
          buckets: [
            {
              bucketId: 'flash-primary',
              displayName: 'Primary Window',
              usedPercent: 100,
            },
          ],
        },
      ],
    },
  },
]

test('PROFILE_STATES is frozen and contains the exact lifecycle states', () => {
  assert.ok(Object.isFrozen(PROFILE_STATES))
  assert.deepEqual(Array.from(PROFILE_STATES), ['selected', 'fallback', 'exhausted', 'unavailable'])
})

test('normalizeProfile applies safe defaults to incomplete or placeholder records', () => {
  assert.deepEqual(normalizeProfile(null), {
    name: '',
    email: null,
    active: false,
    priority: 0,
    path: null,
  })

  assert.deepEqual(normalizeProfile({}), {
    name: '',
    email: null,
    active: false,
    priority: 0,
    path: null,
  })

  assert.deepEqual(
    normalizeProfile({
      name: 'work',
      email: '(-)',
      active: true,
      priority: '1',
      path: '(-)',
    }),
    {
      name: 'work',
      email: null,
      active: true,
      priority: 1,
      path: null,
    }
  )
})

test('normalizeProfiles maps raw lists with safe fallback', () => {
  assert.deepEqual(normalizeProfiles(null), [])
  assert.deepEqual(normalizeProfiles('junk'), [])
  assert.equal(normalizeProfiles([{ name: 'a' }, { name: 'b' }]).length, 2)
})

test('profileStateFor enforces precedence table', () => {
  const activeProfile = { name: 'work', active: true }
  const fallbackProfile = { name: 'backup', active: false }

  // 1. errorClass 'quota' -> 'exhausted'
  assert.equal(
    profileStateFor({ profile: activeProfile, errorClass: 'quota' }),
    'exhausted',
    'quota errorClass takes top priority'
  )

  // 2. errorClass 'auth' or 'billing' -> 'unavailable'
  assert.equal(
    profileStateFor({ profile: activeProfile, errorClass: 'auth' }),
    'unavailable'
  )
  assert.equal(
    profileStateFor({ profile: activeProfile, errorClass: 'billing' }),
    'unavailable'
  )

  // 3. quota entry with explicit exhausted flag or 100% used buckets -> 'exhausted'
  assert.equal(
    profileStateFor({
      profile: activeProfile,
      quotaEntry: { exhausted: true },
    }),
    'exhausted'
  )
  assert.equal(
    profileStateFor({
      profile: activeProfile,
      quotaEntry: {
        quota: {
          groups: [
            {
              buckets: [
                { bucketId: 'b1', usedPercent: 100 },
                { bucketId: 'b2', usedPercent: 105 },
              ],
            },
          ],
        },
      },
    }),
    'exhausted',
    'all buckets >= 100% marks profile as exhausted'
  )

  // Non-exhausted quota: active -> 'selected', other -> 'fallback'
  assert.equal(
    profileStateFor({
      profile: activeProfile,
      quotaEntry: {
        quota: {
          groups: [
            {
              buckets: [
                { bucketId: 'b1', usedPercent: 99 },
                { bucketId: 'b2', usedPercent: 20 },
              ],
            },
          ],
        },
      },
    }),
    'selected'
  )

  assert.equal(
    profileStateFor({
      profile: fallbackProfile,
      quotaEntry: {
        quota: {
          groups: [
            {
              buckets: [{ bucketId: 'b1', usedPercent: 10 }],
            },
          ],
        },
      },
    }),
    'fallback'
  )

  // 4. No quota entry, no error: active -> 'selected', inactive -> 'fallback'
  assert.equal(profileStateFor({ profile: activeProfile }), 'selected')
  assert.equal(profileStateFor({ profile: fallbackProfile }), 'fallback')
})

test('selectProfile supports priority, least_used, and round_robin policies', () => {
  const p1 = { name: 'p1', priority: 1, active: false }
  const p2 = { name: 'p2', priority: 0, active: false }
  const p3 = { name: 'p3', priority: 2, active: false }

  // priority: highest priority number wins (agys documents 'higher number = higher priority')
  assert.equal(
    selectProfile({ profiles: [p1, p2, p3], policy: 'priority' })?.name,
    'p3'
  )

  // priority 5 vs 10: 10 wins
  const pLow = { name: 'low', priority: 5, active: false }
  const pHigh = { name: 'high', priority: 10, active: false }
  assert.equal(
    selectProfile({ profiles: [pLow, pHigh], policy: 'priority' })?.name,
    'high'
  )

  // least_used: lowest usage wins
  const usageByProfile = {
    p1: { last24h: 10 },
    p2: { last24h: 30 },
    p3: { last24h: 2 },
  }
  assert.equal(
    selectProfile({
      profiles: [p1, p2, p3],
      policy: 'least_used',
      usageByProfile,
    })?.name,
    'p3'
  )

  // round_robin: never-used first, then oldest lastUsedAt
  const rrUsage = {
    p1: { lastUsedAt: '2026-09-20T10:00:00Z' },
    p2: { lastUsedAt: '2026-09-19T10:00:00Z' },
    p3: { lastUsedAt: null },
  }
  assert.equal(
    selectProfile({
      profiles: [p1, p2],
      policy: 'round_robin',
      usageByProfile: rrUsage,
    })?.name,
    'p2',
    'older lastUsedAt wins when all have been used'
  )
  assert.equal(
    selectProfile({
      profiles: [p1, p2, p3],
      policy: 'round_robin',
      usageByProfile: rrUsage,
    })?.name,
    'p3',
    'never-used profile wins in round_robin'
  )
})

test('selectProfile never selects exhausted or unavailable profiles when viable exists', () => {
  const profiles = [
    { name: 'p-exhausted', priority: 0, state: 'exhausted' },
    { name: 'p-unavailable', priority: 0, state: 'unavailable' },
    { name: 'p-fallback', priority: 5, state: 'fallback' },
  ]

  const chosen = selectProfile({ profiles, policy: 'priority' })
  assert.equal(chosen?.name, 'p-fallback')

  // When all are exhausted or unavailable, returns null
  const allDead = [
    { name: 'p1', state: 'exhausted' },
    { name: 'p2', state: 'unavailable' },
  ]
  assert.equal(selectProfile({ profiles: allDead, policy: 'priority' }), null)
})

test('parseAgysList parses fixture and handles spacing, (default), and (-)', () => {
  const parsed = parseAgysList(FIXTURE_AGYS_LIST)
  assert.equal(parsed.length, 3)

  assert.deepEqual(parsed[0], {
    name: 'work',
    email: 'work@company.com',
    active: true,
    priority: 2,
    path: '~/.agys/profiles/work',
  })

  assert.deepEqual(parsed[1], {
    name: 'personal',
    email: 'user@gmail.com',
    active: false,
    priority: 1,
    path: '~/.agys/profiles/personal',
  })

  assert.deepEqual(parsed[2], {
    name: 'backup',
    email: null,
    active: false,
    priority: 0,
    path: '~/.agys/profiles/backup',
  })

  assert.deepEqual(parseAgysList(''), [])
  assert.deepEqual(parseAgysList('Active Profiles:\n'), [])
})

test('parseAgysQuota tolerantly parses valid json and junk input', () => {
  const parsed = parseAgysQuota(JSON.stringify(FIXTURE_AGYS_QUOTA))
  assert.ok(parsed.work)
  assert.ok(parsed.personal)
  assert.equal(parsed.work.email, 'work@company.com')

  // Array input directly
  const parsedArray = parseAgysQuota(FIXTURE_AGYS_QUOTA)
  assert.ok(parsedArray.work)

  // Junk input never throws and returns {}
  assert.deepEqual(parseAgysQuota('garbage not json'), {})
  assert.deepEqual(parseAgysQuota('{ broken json'), {})
  assert.deepEqual(parseAgysQuota(null), {})
  assert.deepEqual(parseAgysQuota(undefined), {})
  assert.deepEqual(parseAgysQuota(42), {})
  assert.deepEqual(parseAgysQuota('[]'), {})
})

test('agysRunArgv/agysAutoArgv split an effort-suffixed model into --model + --effort', () => {
  // agys injects its own `--effort high` when the caller does not pass one, and
  // agy rejects that against a suffixed model id. The wrapper must split it.
  assert.deepEqual(agysRunArgv({ profile: 'work', agyArgv: ['--model', 'gemini-3.8-flash-low', '-p', 'hi'] }), [
    'run',
    'work',
    '--',
    '--model',
    'gemini-3.8-flash',
    '-p',
    'hi',
    '--effort',
    'low',
  ])
  assert.deepEqual(agysRunArgv({ profile: 'work', agyArgv: ['--model', 'gemini-3.1-pro-high'] }), [
    'run',
    'work',
    '--',
    '--model',
    'gemini-3.1-pro',
    '--effort',
    'high',
  ])
  // An explicit --effort wins and the model id is left alone.
  assert.deepEqual(agysRunArgv({ profile: 'work', agyArgv: ['--model', 'gemini-3.8-flash-low', '--effort', 'low'] }), [
    'run',
    'work',
    '--',
    '--model',
    'gemini-3.8-flash-low',
    '--effort',
    'low',
  ])
  // No model, or a model without a known effort suffix: unchanged.
  assert.deepEqual(agysRunArgv({ profile: 'work', agyArgv: ['-p', 'hi'] }), ['run', 'work', '--', '-p', 'hi'])
  assert.deepEqual(agysRunArgv({ profile: 'work', agyArgv: ['--model', 'gemini-3.8-flash'] }), [
    'run',
    'work',
    '--',
    '--model',
    'gemini-3.8-flash',
  ])
})

test('agysRunArgv and agysAutoArgv build correct argv arrays', () => {
  const agyArgv = ['--model', 'gemini-3.8-flash', '-p', 'hello']
  assert.deepEqual(agysRunArgv({ profile: 'work', agyArgv }), [
    'run',
    'work',
    '--',
    '--model',
    'gemini-3.8-flash',
    '-p',
    'hello',
  ])

  assert.deepEqual(agysAutoArgv({ agyArgv }), [
    'auto',
    '--',
    '--model',
    'gemini-3.8-flash',
    '-p',
    'hello',
  ])
})

test('isAgysAvailable returns true on code 0 and false on error/failure', async () => {
  const successRunner = async (cmd, args) => {
    assert.equal(cmd, 'agys')
    assert.deepEqual(args, ['--version'])
    return { code: 0, stdout: 'agys version v0.2.33 (darwin/arm64)\n', stderr: '' }
  }
  assert.equal(await isAgysAvailable({ runCommandFn: successRunner }), true)

  const failRunner = async () => ({ code: 1, stdout: '', stderr: 'error' })
  assert.equal(await isAgysAvailable({ runCommandFn: failRunner }), false)

  const throwingRunner = async () => {
    throw new Error('spawn ENOENT')
  }
  assert.equal(await isAgysAvailable({ runCommandFn: throwingRunner }), false)
})

test('listAgysProfiles returns parsed profiles or empty array on error', async () => {
  const successRunner = async (cmd, args) => {
    assert.equal(cmd, 'agys')
    assert.deepEqual(args, ['list'])
    return { code: 0, stdout: FIXTURE_AGYS_LIST, stderr: '' }
  }
  const profiles = await listAgysProfiles({ runCommandFn: successRunner })
  assert.equal(profiles.length, 3)
  assert.equal(profiles[0].name, 'work')

  const failRunner = async () => ({ code: 127, stdout: '', stderr: 'not found' })
  assert.deepEqual(await listAgysProfiles({ runCommandFn: failRunner }), [])

  const throwingRunner = async () => {
    throw new Error('timeout')
  }
  assert.deepEqual(await listAgysProfiles({ runCommandFn: throwingRunner }), [])
})

test('readAgysQuota returns parsed map or empty object on error', async () => {
  const successRunner = async (cmd, args) => {
    assert.equal(cmd, 'agys')
    assert.deepEqual(args, ['quota', '--json'])
    return { code: 0, stdout: JSON.stringify(FIXTURE_AGYS_QUOTA), stderr: '' }
  }
  const map = await readAgysQuota({ runCommandFn: successRunner })
  assert.ok(map.work)
  assert.ok(map.personal)

  const failRunner = async () => ({ code: 1, stdout: '', stderr: 'network error' })
  assert.deepEqual(await readAgysQuota({ runCommandFn: failRunner }), {})

  const throwingRunner = async () => {
    throw new Error('killed')
  }
  assert.deepEqual(await readAgysQuota({ runCommandFn: throwingRunner }), {})
})

test('runAgyWithProfile invokes agys run when profile given, or falls back to agy', async () => {
  let calls = []
  const fakeRunner = async (cmd, args, opts) => {
    calls.push({ cmd, args, opts })
    return { code: 0, stdout: 'ok', stderr: '' }
  }

  const agyArgv = ['-p', 'test prompt', '--model', 'gemini-3.8-flash-high']

  // 1. With profile
  calls = []
  const res1 = await runAgyWithProfile({
    profile: 'work',
    agyArgv,
    runCommandFn: fakeRunner,
  })
  assert.equal(res1.code, 0)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].cmd, 'agys')
  // The effort suffix moves out of the model id so agys cannot inject its own
  // --effort high (which agy rejects against a suffixed model).
  assert.deepEqual(calls[0].args, ['run', 'work', '--', '-p', 'test prompt', '--model', 'gemini-3.8-flash', '--effort', 'high'])

  // 2. Fallback when profile is falsy
  calls = []
  const res2 = await runAgyWithProfile({
    profile: null,
    agyArgv,
    runCommandFn: fakeRunner,
  })
  assert.equal(res2.code, 0)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].cmd, 'agy')
  assert.deepEqual(calls[0].args, agyArgv)

  // 3. Exception in runner is caught and never throws
  const throwingRunner = async () => {
    throw new Error('runner failed')
  }
  const res3 = await runAgyWithProfile({
    profile: 'work',
    agyArgv,
    runCommandFn: throwingRunner,
  })
  assert.equal(res3.code, 1)
  assert.ok(res3.error)
})

test('resolveAgyCommand with and without a profile produces exact argv shape', () => {
  const agyArgv = ['--model', 'gemini-3.8-flash', '-p', 'hello']

  // With profile: ['run', profile, '--', ...argv]
  const withProfile = resolveAgyCommand({ profile: 'work', agyCmd: 'agy', agyArgv })
  assert.deepEqual(withProfile, {
    cmd: 'agys',
    args: ['run', 'work', '--', '--model', 'gemini-3.8-flash', '-p', 'hello']
  })

  // Without profile: plain agyCmd and copy of argv
  const withoutProfile = resolveAgyCommand({ profile: null, agyCmd: 'agy', agyArgv })
  assert.deepEqual(withoutProfile, {
    cmd: 'agy',
    args: ['--model', 'gemini-3.8-flash', '-p', 'hello']
  })

  // Defaults with no arguments
  const defaults = resolveAgyCommand()
  assert.deepEqual(defaults, {
    cmd: 'agy',
    args: []
  })
})

test('resolveAgyProfile returns explicit profile without calling agys CLI', async () => {
  let commandCalled = false
  const runCommandFn = async () => {
    commandCalled = true
    return { code: 0, stdout: '', stderr: '' }
  }

  const res = await resolveAgyProfile({
    env: { AGENT_HUB_AGYS_PROFILE: 'personal' },
    runCommandFn
  })

  assert.deepEqual(res, { profile: 'personal', status: 'selected' })
  assert.equal(commandCalled, false, 'explicit profile must not call agys CLI')
})

test('resolveAgyProfile in auto mode selects active or fallback profile using injected functions', async () => {
  const fakeRunner = async (cmd, args) => {
    if (args[0] === '--version') return { code: 0, stdout: 'agys v0.2.33', stderr: '' }
    return { code: 0, stdout: '', stderr: '' }
  }

  const fakeList = async () => [
    { name: 'work', active: true, priority: 2 },
    { name: 'backup', active: false, priority: 1 }
  ]

  const fakeQuota = async () => ({
    work: { profileName: 'work' },
    backup: { profileName: 'backup' }
  })

  // Active profile picked
  const res1 = await resolveAgyProfile({
    env: { AGENT_HUB_AGYS: 'auto' },
    runCommandFn: fakeRunner,
    listFn: fakeList,
    quotaFn: fakeQuota
  })
  assert.deepEqual(res1, { profile: 'work', status: 'selected' })

  // When active is exhausted, fallback is picked
  const exhaustedActiveQuota = async () => ({
    work: { profileName: 'work', exhausted: true },
    backup: { profileName: 'backup' }
  })
  const res2 = await resolveAgyProfile({
    env: { AGENT_HUB_AGYS: 'auto' },
    runCommandFn: fakeRunner,
    listFn: fakeList,
    quotaFn: exhaustedActiveQuota
  })
  assert.deepEqual(res2, { profile: 'backup', status: 'fallback' })
})

test('resolveAgyProfile returns status unavailable when agys CLI is unavailable', async () => {
  const failRunner = async () => ({ code: 1, stdout: '', stderr: 'command not found' })

  const res = await resolveAgyProfile({
    env: { AGENT_HUB_AGYS: 'auto' },
    runCommandFn: failRunner
  })

  assert.deepEqual(res, { profile: null, status: 'unavailable' })
})

test('resolveAgyProfile returns null profile and status when mode is off', async () => {
  const res = await resolveAgyProfile({ env: { AGENT_HUB_AGYS: 'off' } })
  assert.deepEqual(res, { profile: null, status: null })
})

test('resolveAgyProfile with the default mode and no reachable agys is unavailable, never a throw', async () => {
  // The default mode is 'auto', so an env with no agys settings still probes
  // agys. Inject an unreachable runner so the result does not depend on the
  // machine (the real agys may or may not be installed).
  const unreachable = async () => {
    throw new Error('agys not available')
  }
  assert.deepEqual(await resolveAgyProfile({ env: {}, runCommandFn: unreachable }), { profile: null, status: 'unavailable' })
  assert.deepEqual(await resolveAgyProfile({ env: null, runCommandFn: unreachable }), { profile: null, status: 'unavailable' })
})

test('resolveAgyProfile never throws on junk or errors', async () => {
  const throwingRunner = async () => {
    throw new Error('catastrophic failure')
  }

  // Explicit 'off' short-circuits without probing anything.
  assert.deepEqual(await resolveAgyProfile({ env: { AGENT_HUB_AGYS: 'off' } }), { profile: null, status: null })
  assert.deepEqual(await resolveAgyProfile({ env: null, runCommandFn: throwingRunner }), { profile: null, status: 'unavailable' })
  assert.deepEqual(await resolveAgyProfile({
    env: { AGENT_HUB_AGYS: 'auto' },
    runCommandFn: async () => ({ code: 0, stdout: 'agys v0.2.33', stderr: '' }),
    listFn: throwingRunner
  }), { profile: null, status: null })
  assert.deepEqual(await resolveAgyProfile({
    env: { AGENT_HUB_AGYS: 'auto' },
    runCommandFn: async () => ({ code: 0, stdout: 'agys v0.2.33', stderr: '' }),
    selectFn: () => { throw new Error('select failed') }
  }), { profile: null, status: null })
})


test('profileFromEnv resolves only the explicit env profile, synchronously', async () => {
  const mod = await import('../src/providers/agys.mjs')
  assert.deepEqual(mod.profileFromEnv({}), { profile: null, status: null })
  assert.deepEqual(mod.profileFromEnv({ AGENT_HUB_AGYS_PROFILE: '  work  ' }), { profile: 'work', status: 'selected' })
  assert.deepEqual(mod.profileFromEnv({ AGENT_HUB_AGYS_PROFILE: '' }), { profile: null, status: null })
  assert.deepEqual(mod.profileFromEnv({ AGENT_HUB_AGYS: 'auto' }), { profile: null, status: null })
  assert.deepEqual(mod.profileFromEnv(null), { profile: null, status: null })
})

test('resolveAgyProfileSync resolves explicit AGENT_HUB_AGYS_PROFILE without calling execFn', () => {
  let execCalled = false
  const execFn = () => {
    execCalled = true
    return ''
  }
  const res = resolveAgyProfileSync({
    env: { AGENT_HUB_AGYS_PROFILE: 'custom-prof' },
    execFn,
  })
  assert.equal(execCalled, false)
  assert.equal(res.profile, 'custom-prof')
  assert.equal(res.status, 'selected')
})

test('resolveAgyProfileSync in auto mode runs agys list and quota via execFn and picks with selectProfile', () => {
  const calls = []
  const execFn = (cmd, args) => {
    calls.push({ cmd, args })
    if (args[0] === 'list') return FIXTURE_AGYS_LIST
    if (args[0] === 'quota') return JSON.stringify(FIXTURE_AGYS_QUOTA)
    return ''
  }
  resetSyncProfileCache()
  const res = resolveAgyProfileSync({
    env: { AGENT_HUB_AGYS: 'auto' },
    execFn,
  })
  assert.equal(res.profile, 'work')
  assert.equal(res.status, 'selected')
  assert.ok(Array.isArray(res.profiles))
  assert.equal(res.profiles.length, 3)
  assert.equal(res.profiles[0].name, 'work')
  assert.equal(res.profiles[0].status, 'selected')
  assert.equal(res.profiles[1].name, 'personal')
  assert.equal(res.profiles[1].status, 'exhausted')
  assert.equal(calls.length, 2)
  assert.equal(calls[0].cmd, 'agys')
  assert.deepEqual(calls[0].args, ['list'])
  assert.equal(calls[1].cmd, 'agys')
  assert.deepEqual(calls[1].args, ['quota', '--json'])
})

test('resolveAgyProfileSync handles execFn errors gracefully (unavailable on ENOENT, null on generic error)', () => {
  resetSyncProfileCache()
  const enoentErr = new Error('not found')
  enoentErr.code = 'ENOENT'
  const unavailRes = resolveAgyProfileSync({
    env: { AGENT_HUB_AGYS: 'auto' },
    execFn: () => {
      throw enoentErr
    },
  })
  assert.deepEqual(unavailRes, { profile: null, status: 'unavailable', profiles: [] })

  resetSyncProfileCache()
  const genericErr = new Error('generic failure')
  const genericRes = resolveAgyProfileSync({
    env: { AGENT_HUB_AGYS: 'auto' },
    execFn: () => {
      throw genericErr
    },
  })
  assert.deepEqual(genericRes, { profile: null, status: null, profiles: [] })
})

test('resolveAgyProfileSync memoizes results so a counting execFn is called at most once within TTL', () => {
  resetSyncProfileCache()
  let callCount = 0
  const execFn = (cmd, args) => {
    callCount++
    if (args[0] === 'list') return FIXTURE_AGYS_LIST
    if (args[0] === 'quota') return JSON.stringify(FIXTURE_AGYS_QUOTA)
    return ''
  }
  const env = { AGENT_HUB_AGYS: 'auto' }
  const res1 = resolveAgyProfileSync({ env, execFn })
  const res2 = resolveAgyProfileSync({ env, execFn })
  assert.deepEqual(res1, res2)
  assert.equal(callCount, 2) // 1 for list, 1 for quota

  // Calling resetSyncProfileCache forces a re-execution
  resetSyncProfileCache()
  const res3 = resolveAgyProfileSync({ env, execFn })
  assert.deepEqual(res3, res1)
  assert.equal(callCount, 4) // 2 more calls
})

test('getAgysMode respects precedence: env profile -> env auto -> env off -> setting -> default auto', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-agys-mode-test-'))
  const envHome = { AGENT_HUB_HOME: tmpDir }

  // 1. Env profile non-empty
  assert.deepEqual(getAgysMode({ ...envHome, AGENT_HUB_AGYS_PROFILE: '  work  ', AGENT_HUB_AGYS: 'off' }), {
    mode: 'profile',
    profile: 'work',
    source: 'env',
  })

  // 2. Env auto
  assert.deepEqual(getAgysMode({ ...envHome, AGENT_HUB_AGYS: 'auto' }), {
    mode: 'auto',
    profile: null,
    source: 'env',
  })

  // 3. Env off
  assert.deepEqual(getAgysMode({ ...envHome, AGENT_HUB_AGYS: 'off' }), {
    mode: 'off',
    profile: null,
    source: 'env',
  })

  // 4. Persisted setting file
  const settingPath = path.join(tmpDir, 'agys-mode.json')
  fs.writeFileSync(settingPath, JSON.stringify({ mode: 'off' }))
  assert.deepEqual(getAgysMode(envHome), {
    mode: 'off',
    profile: null,
    source: 'setting',
  })

  fs.writeFileSync(settingPath, JSON.stringify({ mode: 'profile', profile: 'custom-pinned' }))
  assert.deepEqual(getAgysMode(envHome), {
    mode: 'profile',
    profile: 'custom-pinned',
    source: 'setting',
  })

  // 5. Missing / corrupt file -> default auto
  fs.writeFileSync(settingPath, 'corrupted not json {{{')
  assert.deepEqual(getAgysMode(envHome), {
    mode: 'auto',
    profile: null,
    source: 'default',
  })

  fs.unlinkSync(settingPath)
  assert.deepEqual(getAgysMode(envHome), {
    mode: 'auto',
    profile: null,
    source: 'default',
  })
})

test('getAgysMode default is auto: no env and no settings -> auto; env off -> off; setting off -> off', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-agys-default-test-'))
  const envHome = { AGENT_HUB_HOME: tmpDir }

  // no env and no settings file -> mode 'auto', source 'default'
  assert.deepEqual(getAgysMode(envHome), {
    mode: 'auto',
    profile: null,
    source: 'default',
  })

  // env AGENT_HUB_AGYS=off -> off
  assert.deepEqual(getAgysMode({ ...envHome, AGENT_HUB_AGYS: 'off' }), {
    mode: 'off',
    profile: null,
    source: 'env',
  })

  // a settings file with mode off -> off
  const settingPath = path.join(tmpDir, 'agys-mode.json')
  fs.writeFileSync(settingPath, JSON.stringify({ mode: 'off' }))
  assert.deepEqual(getAgysMode(envHome), {
    mode: 'off',
    profile: null,
    source: 'setting',
  })
})

test('setAgysMode validates input, writes atomically, and invalidates sync profile cache', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-agys-mode-set-'))
  const env = { AGENT_HUB_HOME: tmpDir }

  // Validation
  assert.throws(() => setAgysMode({ mode: 'invalid' }, env), /invalid mode/i)
  assert.throws(() => setAgysMode({ mode: 'profile', profile: '' }, env), /profile/i)
  assert.throws(() => setAgysMode({ mode: 'profile', profile: null }, env), /profile/i)

  // Valid set
  const saved = setAgysMode({ mode: 'profile', profile: 'pinned-test' }, env)
  assert.deepEqual(saved, { mode: 'profile', profile: 'pinned-test', source: 'setting' })
  assert.deepEqual(getAgysMode(env), { mode: 'profile', profile: 'pinned-test', source: 'setting' })

  // Cache invalidation: populate sync cache, change mode, verify cache is cleared
  let callCount = 0
  const execFn = (cmd, args) => {
    callCount++
    if (args[0] === 'list') return FIXTURE_AGYS_LIST
    if (args[0] === 'quota') return JSON.stringify(FIXTURE_AGYS_QUOTA)
    return ''
  }
  setAgysMode({ mode: 'auto' }, env)
  const r1 = resolveAgyProfileSync({ env, execFn })
  assert.equal(r1.profile, 'work')
  assert.equal(callCount, 2)

  // Second call within TTL uses memo
  resolveAgyProfileSync({ env, execFn })
  assert.equal(callCount, 2)

  // setAgysMode invalidates memo immediately
  setAgysMode({ mode: 'profile', profile: 'backup' }, env)
  const r2 = resolveAgyProfileSync({ env, execFn })
  assert.equal(r2.profile, 'backup')
  assert.equal(callCount, 4) // called again because memo was invalidated
})

test('safe degradation: with mode auto or pinned profile and agys unavailable, resolves to plain agy without error', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-safe-degradation-'))
  const env = { AGENT_HUB_HOME: tmpDir }
  const failingExecFn = () => {
    const err = new Error('spawn ENOENT')
    err.code = 'ENOENT'
    throw err
  }

  // 1. Mode auto with unavailable agys
  setAgysMode({ mode: 'auto' }, env)
  const autoRes = resolveAgyProfileSync({ env, execFn: failingExecFn })
  assert.deepEqual(autoRes, { profile: null, status: 'unavailable', profiles: [] })
  const autoCmd = resolveAgyCommand({ profile: autoRes.profile, agyCmd: 'agy', agyArgv: ['-p', 'task'] })
  assert.deepEqual(autoCmd, { cmd: 'agy', args: ['-p', 'task'] })

  // 2. Pinned profile in setting with unavailable agys
  setAgysMode({ mode: 'profile', profile: 'pinned-profile' }, env)
  const pinnedRes = resolveAgyProfileSync({ env, execFn: failingExecFn })
  assert.deepEqual(pinnedRes, { profile: null, status: 'unavailable', profiles: [] })
  const pinnedCmd = resolveAgyCommand({ profile: pinnedRes.profile, agyCmd: 'agy', agyArgv: ['-p', 'task'] })
  assert.deepEqual(pinnedCmd, { cmd: 'agy', args: ['-p', 'task'] })
})

test('agysProfilesSnapshot reports mode, source and pinnedProfile from getAgysMode', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-snapshot-mode-'))
  const env = { AGENT_HUB_HOME: tmpDir }
  const fakeRunner = async (cmd, args) => {
    if (args[0] === '--version') return { code: 0, stdout: 'agys v0.2.33', stderr: '' }
    if (args[0] === 'list') return { code: 0, stdout: FIXTURE_AGYS_LIST, stderr: '' }
    if (args[0] === 'quota') return { code: 0, stdout: JSON.stringify(FIXTURE_AGYS_QUOTA), stderr: '' }
    return { code: 0, stdout: '', stderr: '' }
  }

  // Default mode auto
  const snap1 = await agysProfilesSnapshot({ env, runCommandFn: fakeRunner })
  assert.equal(snap1.mode, 'auto')
  assert.equal(snap1.source, 'default')
  assert.equal(snap1.pinnedProfile, null)

  // Persisted setting profile
  setAgysMode({ mode: 'profile', profile: 'personal' }, env)
  const snap2 = await agysProfilesSnapshot({ env, runCommandFn: fakeRunner })
  assert.equal(snap2.mode, 'profile')
  assert.equal(snap2.source, 'setting')
  assert.equal(snap2.pinnedProfile, 'personal')
  assert.equal(snap2.selected?.name, 'personal')

  // Env override wins over setting
  const snap3 = await agysProfilesSnapshot({
    env: { ...env, AGENT_HUB_AGYS_PROFILE: 'work' },
    runCommandFn: fakeRunner,
  })
  assert.equal(snap3.mode, 'profile')
  assert.equal(snap3.source, 'env')
  assert.equal(snap3.pinnedProfile, 'work')
})


import { test } from 'node:test'
import assert from 'node:assert/strict'
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
} from '../src/providers/agys.mjs'

const FIXTURE_AGYS_LIST = `Active Profiles:
PROFILE          PRIO  EMAIL                CONFIG  PATH
work (default)   0     work@company.com     (-)     ~/.agys/profiles/work
personal         1     user@gmail.com       (-)     ~/.agys/profiles/personal
backup           2     (-)                  (-)     ~/.agys/profiles/backup
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

  // priority: lowest priority number wins
  assert.equal(
    selectProfile({ profiles: [p1, p2, p3], policy: 'priority' })?.name,
    'p2'
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
    priority: 0,
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
    priority: 2,
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

test('agysRunArgv and agysAutoArgv build correct argv arrays', () => {
  const agyArgv = ['--model', 'gemini-3.8-flash-high', '-p', 'hello']
  assert.deepEqual(agysRunArgv({ profile: 'work', agyArgv }), [
    'run',
    'work',
    '--',
    '--model',
    'gemini-3.8-flash-high',
    '-p',
    'hello',
  ])

  assert.deepEqual(agysAutoArgv({ agyArgv }), [
    'auto',
    '--',
    '--model',
    'gemini-3.8-flash-high',
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
  assert.deepEqual(calls[0].args, ['run', 'work', '--', ...agyArgv])

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
    { name: 'work', active: true, priority: 0 },
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

test('resolveAgyProfile returns null profile and status when env is absent or empty', async () => {
  const res = await resolveAgyProfile({ env: {} })
  assert.deepEqual(res, { profile: null, status: null })
})

test('resolveAgyProfile never throws on junk or errors', async () => {
  const throwingRunner = async () => {
    throw new Error('catastrophic failure')
  }

  assert.deepEqual(await resolveAgyProfile({ env: null }), { profile: null, status: null })
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


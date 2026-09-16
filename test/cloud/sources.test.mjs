import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { refreshSources, readSourcesCache, accountsForSource, normalizedSources, sourceNamesFromEntry } from '../../src/cloud/sources.mjs'

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-sources-'))
}

const envFor = (home) => ({ AGENT_HUB_HOME: home })

function pageOf(names) {
  return { sources: names.map((name) => ({ name })) }
}

/** What refreshSources caches for a bare {name} source (no githubRepo), parsed from the name. */
function cachedOf(name) {
  const match = name.match(/^sources\/github\/([^/]+)\/(.+)$/)
  return { name, owner: match ? match[1] : null, repo: match ? match[2] : null, defaultBranch: null, branches: [] }
}

test('readSourcesCache returns {} when the cache file does not exist yet', () => {
  assert.deepEqual(readSourcesCache(envFor(tmpHome())), {})
})

test('refreshSources stores status "ok" and the source names on a successful read', async () => {
  const env = envFor(tmpHome())
  const client = { listSources: async () => pageOf(['sources/github/acme/widgets', 'sources/github/acme/gadgets']) }

  const entry = await refreshSources({ accountId: 'acct-a', env, client, apiKey: 'key-aaa' })

  assert.equal(entry.status, 'ok')
  assert.deepEqual(entry.sources, [
    cachedOf('sources/github/acme/widgets'),
    cachedOf('sources/github/acme/gadgets'),
  ])
  assert.ok(entry.fetchedAt)
  assert.deepEqual(readSourcesCache(env)['acct-a'], entry)
})

test('refreshSources caches owner/repo/defaultBranch/branches from githubRepo when present', async () => {
  const env = envFor(tmpHome())
  const client = {
    listSources: async () => ({
      sources: [
        {
          name: 'sources/github/acme/widgets',
          githubRepo: {
            owner: 'acme',
            repo: 'widgets',
            defaultBranch: { displayName: 'main' },
            branches: [{ displayName: 'main' }, { displayName: 'dev' }],
          },
        },
      ],
    }),
  }

  const entry = await refreshSources({ accountId: 'acct-a', env, client, apiKey: 'key-aaa' })

  assert.deepEqual(entry.sources, [
    { name: 'sources/github/acme/widgets', owner: 'acme', repo: 'widgets', defaultBranch: 'main', branches: ['main', 'dev'] },
  ])
})

test('normalizedSources upgrades a legacy plain-string cache entry to the richer shape', () => {
  const legacyEntry = { status: 'ok', sources: ['sources/github/acme/widgets'] }
  assert.deepEqual(normalizedSources(legacyEntry), [
    { name: 'sources/github/acme/widgets', owner: null, repo: null, defaultBranch: null, branches: [] },
  ])
  assert.deepEqual(sourceNamesFromEntry(legacyEntry), ['sources/github/acme/widgets'])
})

test('a 401 from /sources is stored as no_source_access and does NOT throw — the account stays healthy', async () => {
  const env = envFor(tmpHome())
  const apiError = Object.assign(new Error('Jules API responded 401 on /sources'), { status: 401 })
  const client = {
    listSources: async () => {
      throw apiError
    },
  }

  const entry = await refreshSources({ accountId: 'acct-b', env, client, apiKey: 'key-bbb' })

  assert.equal(entry.status, 'no_source_access')
  assert.deepEqual(entry.sources, [])
  assert.equal(readSourcesCache(env)['acct-b'].status, 'no_source_access')
})

test('a 403 is also stored as no_source_access', async () => {
  const env = envFor(tmpHome())
  const apiError = Object.assign(new Error('forbidden'), { status: 403 })
  const client = {
    listSources: async () => {
      throw apiError
    },
  }
  const entry = await refreshSources({ accountId: 'acct-c', env, client, apiKey: 'key-ccc' })
  assert.equal(entry.status, 'no_source_access')
})

test('any other /sources failure is stored as status "error" (never a key rejection)', async () => {
  const env = envFor(tmpHome())
  const apiError = Object.assign(new Error('Jules API responded 500'), { status: 500 })
  const client = {
    listSources: async () => {
      throw apiError
    },
  }
  const entry = await refreshSources({ accountId: 'acct-d', env, client, apiKey: 'key-ddd' })
  assert.equal(entry.status, 'error')
  assert.deepEqual(entry.sources, [])
})

test('refreshing one account preserves the other accounts in the cache', async () => {
  const env = envFor(tmpHome())
  const okClient = { listSources: async () => pageOf(['sources/github/acme/widgets']) }
  const noAccessClient = {
    listSources: async () => {
      throw Object.assign(new Error('401'), { status: 401 })
    },
  }

  await refreshSources({ accountId: 'acct-a', env, client: okClient, apiKey: 'key-aaa' })
  await refreshSources({ accountId: 'acct-b', env, client: noAccessClient, apiKey: 'key-bbb' })

  const cache = readSourcesCache(env)
  assert.equal(cache['acct-a'].status, 'ok')
  assert.equal(cache['acct-b'].status, 'no_source_access')
  assert.deepEqual(Object.keys(cache).sort(), ['acct-a', 'acct-b'])
})

test('accountsForSource splits accounts into those known to have the source and unknown-sources accounts', async () => {
  const env = envFor(tmpHome())
  const okClient = { listSources: async () => pageOf(['sources/github/acme/widgets']) }
  const otherClient = { listSources: async () => pageOf(['sources/github/acme/gadgets']) }
  const noAccessClient = {
    listSources: async () => {
      throw Object.assign(new Error('401'), { status: 401 })
    },
  }

  await refreshSources({ accountId: 'has-it', env, client: okClient, apiKey: 'key-aaa' })
  await refreshSources({ accountId: 'lacks-it', env, client: otherClient, apiKey: 'key-bbb' })
  await refreshSources({ accountId: 'no-access', env, client: noAccessClient, apiKey: 'key-ccc' })

  const result = accountsForSource('sources/github/acme/widgets', env)
  assert.deepEqual(result.accounts, ['has-it'])
  assert.deepEqual(result.unknown.sort(), ['no-access'])
  assert.ok(!result.unknown.includes('lacks-it'), 'an account known to lack the source is neither account nor unknown')
})

test('accountsForSource reports every non-ok cache entry as unknown, and ignores accounts with no cache entry', async () => {
  const env = envFor(tmpHome())
  const errorClient = {
    listSources: async () => {
      throw Object.assign(new Error('500'), { status: 500 })
    },
  }
  await refreshSources({ accountId: 'errored', env, client: errorClient, apiKey: 'key-aaa' })

  const result = accountsForSource('sources/github/acme/widgets', env)
  assert.deepEqual(result.accounts, [])
  assert.deepEqual(result.unknown, ['errored'])
})

test('refreshSources rethrows a non-API error instead of caching it as an account failure', async () => {
  const env = envFor(tmpHome())
  // A client that is not a client at all: this is a defect in the caller, and
  // caching it as status:'error' would hide a working account's real sources.
  await assert.rejects(
    () => refreshSources({ accountId: 'acct-1', env, client: {}, apiKey: 'key-aaa' }),
    /listSources is not a function|not a function/
  )
  assert.deepEqual(readSourcesCache(env), {})
})

import crypto from 'node:crypto'
import fs from 'node:fs'
import { paths } from './config.mjs'
import { readJsonSafe, updateJsonLocked } from './fsutil.mjs'
import { listJobs as defaultListJobs } from './jobstore.mjs'

/**
 * Jules API accounts. Quotas are per account (Jules Pro: 100 tasks per rolling
 * 24h, 15 concurrent), so several accounts are kept here and one is chosen per
 * delegation by the policy in settings.policy (see cloud/selectAccount.mjs).
 *
 * accounts.json holds RAW API KEYS, so it is written 0600 and every public
 * reader returns a MASKED account (keyLast4/keyPresent) — never the key. The
 * one exception is getAccountSecret(), which exists only for the code that
 * actually calls the Jules API.
 *
 * Schema: { settings: { policy }, accounts: [ { id, label, apiKey, enabled,
 * priority, dailyLimit, concurrentLimit, lastUsedAt, createdAt, updatedAt } ] }
 */
export const POLICIES = ['round_robin', 'least_used', 'priority']

export const DEFAULT_DAILY_LIMIT = 100
export const DEFAULT_CONCURRENT_LIMIT = 15

const DEFAULT_ACCOUNTS_FILE = { settings: { policy: 'round_robin' }, accounts: [] }

function newAccountId() {
  return `acct-${crypto.randomBytes(4).toString('hex')}`
}

/** The one place the raw key leaves accounts.mjs. Internal callers only. */
function rawAccount(id, env) {
  const data = readAccounts(env)
  return data.accounts.find((account) => account.id === id) ?? null
}

function readAccounts(env) {
  return readJsonSafe(paths(env).accountsFile, DEFAULT_ACCOUNTS_FILE)
}

/**
 * Every write goes through updateJsonLocked because the MCP process and the
 * dashboard process both edit accounts.json. The file is chmod'ed 0600 after
 * each write: writeJsonAtomic creates its temp file with the default mode, and
 * rename() replaces the target wholesale, so a one-time chmod at creation would
 * be silently undone by the next update.
 */
function writeAccounts(env, updater) {
  const file = paths(env).accountsFile
  const next = updateJsonLocked(file, updater, { defaultValue: DEFAULT_ACCOUNTS_FILE })
  try {
    fs.chmodSync(file, 0o600)
  } catch {
    // Best-effort: the contents are still correct even if the mode cannot be set.
  }
  return next
}

function mask(account) {
  const { apiKey, ...rest } = account
  return {
    ...rest,
    keyPresent: typeof apiKey === 'string' && apiKey.length > 0,
    keyLast4: typeof apiKey === 'string' && apiKey.length > 0 ? apiKey.slice(-4) : null,
  }
}

function requireAccount(data, id) {
  const account = data.accounts.find((candidate) => candidate.id === id)
  if (!account) throw new Error(`account not found: ${id}`)
  return account
}

/** Masked accounts, in stored (append) order. Never returns a raw apiKey. */
export function listAccounts(env = process.env) {
  return readAccounts(env).accounts.map(mask)
}

/** Internal only: the raw key for `id`, or null when there is no such account. */
export function getAccountSecret(id, env = process.env) {
  return rawAccount(id, env)?.apiKey ?? null
}

export function createAccount({ label, apiKey, dailyLimit, concurrentLimit }, env = process.env) {
  if (typeof apiKey !== 'string' || apiKey.trim().length === 0) throw new Error('invalid apiKey')
  const now = new Date().toISOString()
  let created

  writeAccounts(env, (data) => {
    const account = {
      id: newAccountId(),
      label: label ?? null,
      apiKey,
      enabled: true,
      // Append order by default; updateAccount can reprioritise later.
      priority: data.accounts.length,
      dailyLimit: dailyLimit ?? DEFAULT_DAILY_LIMIT,
      concurrentLimit: concurrentLimit ?? DEFAULT_CONCURRENT_LIMIT,
      lastUsedAt: null,
      createdAt: now,
      updatedAt: now,
    }
    data.accounts.push(account)
    created = mask(account)
  })

  return created
}

/**
 * Merge `patch` into one account. Omitting apiKey keeps the stored key; an
 * explicitly blank key is rejected (a blank string would silently break every
 * later API call). `id` is immutable.
 */
export function updateAccount(id, patch = {}, env = process.env) {
  const now = new Date().toISOString()
  let updated

  writeAccounts(env, (data) => {
    const account = requireAccount(data, id)
    if (Object.prototype.hasOwnProperty.call(patch, 'apiKey')) {
      if (typeof patch.apiKey !== 'string' || patch.apiKey.trim().length === 0) throw new Error('invalid apiKey')
      account.apiKey = patch.apiKey
    }
    for (const field of ['label', 'enabled', 'priority', 'dailyLimit', 'concurrentLimit']) {
      if (patch[field] !== undefined) account[field] = patch[field]
    }
    account.updatedAt = now
    updated = mask(account)
  })

  return updated
}

export function deleteAccount(id, env = process.env) {
  let deleted
  writeAccounts(env, (data) => {
    const account = requireAccount(data, id)
    data.accounts = data.accounts.filter((candidate) => candidate.id !== id)
    deleted = { id: account.id, deleted: true }
  })
  return deleted
}

export function readPolicy(env = process.env) {
  return readAccounts(env).settings?.policy ?? 'round_robin'
}

export function setPolicy(policy, env = process.env) {
  if (!POLICIES.includes(policy)) throw new Error(`invalid policy: ${policy}`)
  writeAccounts(env, (data) => {
    data.settings = { ...(data.settings ?? {}), policy }
  })
  return policy
}

/** Stamp lastUsedAt so round_robin can prefer the least recently used account. */
export function markAccountUsed(id, env = process.env) {
  const now = new Date().toISOString()
  let updated
  writeAccounts(env, (data) => {
    const account = requireAccount(data, id)
    account.lastUsedAt = now
    account.updatedAt = now
    updated = mask(account)
  })
  return updated
}

/**
 * Quota usage for one account from local job history: `running` is jobs of this
 * account still in status 'running', and `last24h` is jobs created in the last
 * 24 hours — a rolling window, matching how the per-account quota actually
 * resets. Jobs of other accounts (and local, non-Jules jobs, which have no
 * remote.accountId) are ignored.
 */
export function usageFor(id, env = process.env, { listJobsFn = defaultListJobs, nowFn = Date.now } = {}) {
  let jobs
  try {
    jobs = listJobsFn(env)
  } catch {
    return { running: 0, last24h: 0 }
  }

  const cutoff = nowFn() - 24 * 60 * 60 * 1000
  let running = 0
  let last24h = 0
  for (const job of jobs) {
    if (job?.remote?.accountId !== id) continue
    if (job.status === 'running') running++
    const createdMs = Date.parse(job.createdAt)
    if (Number.isFinite(createdMs) && createdMs >= cutoff) last24h++
  }
  return { running, last24h }
}

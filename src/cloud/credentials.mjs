import {
  listAccounts as defaultListAccounts,
  getAccountSecret as defaultGetAccountSecret,
} from '../accounts.mjs'

/**
 * The ONE place Jules key resolution lives. It used to be written out four
 * times (runner.keyForJob, an inline copy in check.mjs, account-aware code in
 * julesSourcesTool, and two env-only paths in tools/jobs.mjs and
 * tools/jules.mjs). They drifted: once keys moved into accounts.json and
 * JULES_API_KEY disappeared from the environment, job_reply and jules_sessions
 * still read env only and started sending unkeyed requests (observed as a real
 * 401 on /sessions/<id>:sendMessage). Every caller now goes through here.
 *
 * A session belongs to exactly one account, so a job must keep using the key
 * of the account that STARTED it — switching keys mid-session would talk to a
 * session the new account cannot see.
 */
export function keyForJob(job, { env = process.env, getAccountSecretFn = defaultGetAccountSecret } = {}) {
  const accountId = job?.remote?.accountId
  // 'env' is the implicit account used when no accounts.json exists; it has no
  // stored record, so it falls through to the env key like a job with none.
  if (accountId && accountId !== 'env') {
    const secret = getAccountSecretFn(accountId, env)
    if (secret) return secret
  }
  return env.JULES_API_KEY ?? null
}

/**
 * Resolve one account+key for a call that is NOT tied to a job's own account
 * (listing sources, listing sessions). An explicit account always wins; with
 * none, the highest-priority ENABLED account that actually has a key; with no
 * usable account, env.JULES_API_KEY as accountId 'env' so a single-key setup
 * keeps working untouched.
 */
export function keyForAccount({
  account,
  env = process.env,
  listAccountsFn = defaultListAccounts,
  getAccountSecretFn = defaultGetAccountSecret,
} = {}) {
  if (account) {
    const apiKey = getAccountSecretFn(account, env)
    return apiKey ? { apiKey, accountId: account } : { apiKey: null, accountId: null }
  }

  const enabled = listAccountsFn(env)
    .filter((candidate) => candidate.enabled !== false)
    .sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0))
  for (const candidate of enabled) {
    const apiKey = getAccountSecretFn(candidate.id, env)
    if (apiKey) return { apiKey, accountId: candidate.id }
  }

  const apiKey = env.JULES_API_KEY
  return apiKey ? { apiKey, accountId: 'env' } : { apiKey: null, accountId: null }
}

export const NO_KEY_MESSAGE = 'No Jules key available: add an account in the dashboard or set JULES_API_KEY.'

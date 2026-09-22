import { runCommand } from './process.mjs'
import { artifactRef, existsArtifact, readArtifact } from './artifacts.mjs'
import { resolveHandoffSchema, validateHandoff } from './handoff.mjs'

export const VERIFY_CHECK_KINDS = Object.freeze(['argv', 'artifact', 'diff', 'schema'])

export function normalizeVerifyCheck(check) {
  if (!check || typeof check !== 'object' || typeof check.name !== 'string' || check.name.trim() === '') {
    throw new Error('invalid verify check: missing name')
  }

  const name = check.name

  if (typeof check.schema === 'string') {
    if (!resolveHandoffSchema(check.schema)) {
      throw new Error(`unknown handoff schema: ${check.schema}`)
    }
    const artifact = typeof check.artifact === 'string' ? check.artifact : 'handoff.json'
    const from = typeof check.from === 'string' ? check.from : null
    return {
      name,
      kind: 'schema',
      schema: check.schema,
      artifact,
      from
    }
  }

  if (Array.isArray(check.argv)) {
    if (check.argv.length === 0 || !check.argv.every(s => typeof s === 'string' && s.length > 0)) {
      throw new Error('argv must be a non-empty array of non-empty strings')
    }
    const expectExitCode = Number.isInteger(check.expectExitCode) ? check.expectExitCode : 0
    const cwd = check.cwd ?? null
    const timeoutS = check.timeoutS ?? null
    return {
      name,
      kind: 'argv',
      argv: check.argv,
      expectExitCode,
      cwd,
      timeoutS
    }
  }

  if (typeof check.artifact === 'string') {
    const artifact = check.artifact
    const from = typeof check.from === 'string' ? check.from : null
    return {
      name,
      kind: 'artifact',
      artifact,
      from
    }
  }

  if (Array.isArray(check.forbid)) {
    if (check.forbid.length === 0 || !check.forbid.every(s => typeof s === 'string' && s.length > 0)) {
      throw new Error('forbid must be a non-empty array of non-empty strings')
    }
    const forbid = check.forbid
    const base = typeof check.base === 'string' ? check.base : 'HEAD'
    return {
      name,
      kind: 'diff',
      forbid,
      base
    }
  }

  throw new Error('unknown verify check kind for "' + name + '"')
}

/** Keeps the END of `text`, bounded to `max` chars — a failure's reason is
 *  usually the last thing printed, not the first. */
function tailOf(text, max = 4000) {
  const s = String(text ?? '')
  return s.length > max ? s.slice(-max) : s
}

/**
 * Runs one normalized argv check exactly once via `runCommandFn` (the same
 * process.mjs-backed primitive every caller of this module uses — never a
 * shell, always bounded by timeoutMs). Shared by runVerification's argv
 * branch and runJobVerification below so there is exactly one place that
 * spawns a verification command.
 */
async function execArgvCheck(check, { cwd, env, runCommandFn, timeoutS }) {
  const startedAt = Date.now()
  const res = await runCommandFn(check.argv[0], check.argv.slice(1), {
    cwd: check.cwd ?? cwd,
    env,
    timeoutMs: (check.timeoutS ?? timeoutS) * 1000
  })
  return {
    res,
    durationMs: Date.now() - startedAt,
    passed: !res.timedOut && res.code === check.expectExitCode
  }
}

export function normalizeVerifyConfig(node) {
  const raw = node?.verify
  if (raw === undefined || raw === null) {
    return null
  }

  let checks
  let required

  if (Array.isArray(raw)) {
    checks = raw.map(normalizeVerifyCheck)
    required = false
  } else if (typeof raw === 'object') {
    if (!Array.isArray(raw.checks)) {
      throw new Error('verify.checks must be an array')
    }
    checks = raw.checks.map(normalizeVerifyCheck)
    required = raw.required === true
  } else {
    throw new Error('invalid verify config')
  }

  if (checks.length === 0) {
    return null
  }

  return { checks, required }
}

export async function runVerification({
  node,
  workflowId,
  stepId,
  cwd = null,
  env = process.env,
  runCommandFn = runCommand,
  timeoutS = 600
} = {}) {
  const config = normalizeVerifyConfig(node)
  if (!config) {
    return null
  }

  const runner = runCommandFn || runCommand
  const startedAt = new Date().toISOString()
  const results = []

  for (const check of config.checks) {
    if (check.kind === 'argv') {
      const { res, passed } = await execArgvCheck(check, { cwd, env, runCommandFn: runner, timeoutS })
      const detail = {
        exitCode: res.code,
        timedOut: !!res.timedOut,
        expectExitCode: check.expectExitCode
      }
      results.push({ name: check.name, kind: check.kind, passed, ...detail })
    } else if (check.kind === 'artifact') {
      const ref = artifactRef(workflowId, check.from ?? stepId, check.artifact)
      const passed = existsArtifact(ref, env)
      const detail = { ref }
      results.push({ name: check.name, kind: check.kind, passed, ...detail })
    } else if (check.kind === 'diff') {
      const res = await runner('git', ['diff', '--name-only', check.base], {
        cwd,
        env,
        timeoutMs: timeoutS * 1000
      })
      const changed = String(res.stdout ?? '').split('\n').map(s => s.trim()).filter(Boolean)
      const forbidden = changed.filter(p => check.forbid.some(f => p === f || p.startsWith(f.endsWith('/') ? f : f + '/')))
      const passed = !res.timedOut && res.code === 0 && forbidden.length === 0
      const detail = { base: check.base, changed, forbidden }
      results.push({ name: check.name, kind: check.kind, passed, ...detail })
    } else if (check.kind === 'schema') {
      const ref = artifactRef(workflowId, check.from ?? stepId, check.artifact)
      let passed = false
      let errors = []
      try {
        const { content } = readArtifact(ref, env)
        try {
          const value = JSON.parse(content)
          const validation = validateHandoff(value, { schema: check.schema })
          passed = validation.ok
          errors = validation.errors ?? []
        } catch (err) {
          passed = false
          errors = [{ path: 'json', message: err.message }]
        }
      } catch (err) {
        passed = false
        errors = [{ path: 'artifact', message: err.message }]
      }
      const detail = { ref, schema: check.schema, errors }
      results.push({ name: check.name, kind: check.kind, passed, ...detail })
    }
  }

  const verified = results.every(c => c.passed)
  const finishedAt = new Date().toISOString()

  return {
    verified,
    required: config.required,
    checks: results,
    startedAt,
    finishedAt
  }
}

/**
 * D2 (agy-hub-verification): job-level verification for delegate/dispatch.
 * Unlike runVerification (a workflow node's `verify`, keyed to a
 * workflowId/stepId artifact context), this is the entry point a hub job
 * (any agent, not just agy) uses once it reaches `succeeded` — see
 * src/jobrunner.mjs's finishJob. Checks run in `cwd` (the job's own cwd) by
 * default; a check's own `cwd` still wins. Reuses normalizeVerifyCheck for
 * validation (invalid input throws before any check runs — "fails fast
 * before dispatch") and execArgvCheck for the exact same argv execution
 * runVerification's argv branch uses, so there is still only one verifier.
 *
 * Returns null when there is nothing to verify, otherwise
 * `{ ok, checks: [{ name, ok, exitCode, durationMs, outputTail }] }` — the
 * shape persisted on the job record and surfaced via job_result/job_status/
 * job.finished (docs/verification.md).
 */
export async function runJobVerification({
  checks,
  cwd = null,
  workflowId = null,
  stepId = null,
  env = process.env,
  runCommandFn = runCommand,
  timeoutS = 600
} = {}) {
  if (!Array.isArray(checks) || checks.length === 0) {
    return null
  }

  // Validate every check up front: one bad check must abort the whole batch
  // before the first (possibly side-effecting) check ever runs.
  const normalized = checks.map(normalizeVerifyCheck)
  const runner = runCommandFn || runCommand
  const results = []

  for (const check of normalized) {
    if (check.kind === 'argv') {
      const { res, durationMs, passed } = await execArgvCheck(check, { cwd, env, runCommandFn: runner, timeoutS })
      results.push({
        name: check.name,
        ok: passed,
        exitCode: typeof res.code === 'number' ? res.code : null,
        durationMs,
        outputTail: tailOf(`${res.stdout ?? ''}${res.stderr ?? ''}`)
      })
    } else {
      // artifact/diff/schema: no live process output/duration in the argv
      // sense — reuse runVerification for this single check rather than
      // reimplementing artifact/schema/diff handling a second time.
      const verdict = await runVerification({ node: { verify: [check] }, workflowId, stepId, cwd, env, runCommandFn: runner, timeoutS })
      const c = verdict.checks[0]
      results.push({ name: c.name, ok: c.passed, exitCode: null, durationMs: null, outputTail: null })
    }
  }

  return {
    ok: results.every((c) => c.ok),
    checks: results
  }
}

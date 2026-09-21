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
      const res = await runner(check.argv[0], check.argv.slice(1), {
        cwd: check.cwd ?? cwd,
        env,
        timeoutMs: (check.timeoutS ?? timeoutS) * 1000
      })
      const passed = !res.timedOut && res.code === check.expectExitCode
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

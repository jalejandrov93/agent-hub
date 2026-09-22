import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {
  VERIFY_CHECK_KINDS,
  normalizeVerifyCheck,
  normalizeVerifyConfig,
  runVerification,
  runJobVerification
} from '../src/verify.mjs'
import { writeArtifact } from '../src/artifacts.mjs'

function makeTempEnv() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-verify-test-'))
  return { ...process.env, AGENT_HUB_HOME: dir }
}

test('VERIFY_CHECK_KINDS is frozen array of expected check kinds', () => {
  assert.deepEqual(VERIFY_CHECK_KINDS, ['argv', 'artifact', 'diff', 'schema'])
  assert.ok(Object.isFrozen(VERIFY_CHECK_KINDS))
})

test('normalizeVerifyConfig handles null, undefined, empty checks, and shorthand array', () => {
  assert.equal(normalizeVerifyConfig(null), null)
  assert.equal(normalizeVerifyConfig(undefined), null)
  assert.equal(normalizeVerifyConfig({}), null)
  assert.equal(normalizeVerifyConfig({ verify: null }), null)
  assert.equal(normalizeVerifyConfig({ verify: undefined }), null)
  assert.equal(normalizeVerifyConfig({ verify: [] }), null)
  assert.equal(normalizeVerifyConfig({ verify: { checks: [] } }), null)

  const arrayShorthand = normalizeVerifyConfig({
    verify: [
      { name: 'unit-tests', argv: ['npm', 'test'] }
    ]
  })
  assert.deepEqual(arrayShorthand, {
    required: false,
    checks: [
      {
        name: 'unit-tests',
        kind: 'argv',
        argv: ['npm', 'test'],
        expectExitCode: 0,
        cwd: null,
        timeoutS: null
      }
    ]
  })

  const fullConfig = normalizeVerifyConfig({
    verify: {
      required: true,
      checks: [
        { name: 'lint', argv: ['npm', 'run', 'lint'], expectExitCode: 0, cwd: '/tmp', timeoutS: 30 }
      ]
    }
  })
  assert.deepEqual(fullConfig, {
    required: true,
    checks: [
      {
        name: 'lint',
        kind: 'argv',
        argv: ['npm', 'run', 'lint'],
        expectExitCode: 0,
        cwd: '/tmp',
        timeoutS: 30
      }
    ]
  })
})

test('normalizeVerifyConfig and normalizeVerifyCheck error handling', () => {
  assert.throws(() => normalizeVerifyConfig({ verify: 'invalid' }), /invalid verify config/)
  assert.throws(() => normalizeVerifyConfig({ verify: 123 }), /invalid verify config/)
  assert.throws(() => normalizeVerifyConfig({ verify: { checks: 'not-an-array' } }), /verify\.checks must be an array/)
  assert.throws(() => normalizeVerifyConfig({ verify: {} }), /verify\.checks must be an array/)

  assert.throws(() => normalizeVerifyCheck(null), /invalid verify check: missing name/)
  assert.throws(() => normalizeVerifyCheck({}), /invalid verify check: missing name/)
  assert.throws(() => normalizeVerifyCheck({ name: '' }), /invalid verify check: missing name/)
  assert.throws(() => normalizeVerifyCheck({ name: '   ' }), /invalid verify check: missing name/)
  assert.throws(() => normalizeVerifyCheck({ name: 123 }), /invalid verify check: missing name/)

  assert.throws(() => normalizeVerifyCheck({ name: 'no-kind' }), /unknown verify check kind for "no-kind"/)
  assert.throws(() => normalizeVerifyCheck({ name: 'unknown', other: 123 }), /unknown verify check kind for "unknown"/)

  assert.throws(() => normalizeVerifyCheck({ name: 'bad-argv-1', argv: [] }), /argv must be a non-empty array of non-empty strings/)
  assert.throws(() => normalizeVerifyCheck({ name: 'bad-argv-2', argv: [''] }), /argv must be a non-empty array of non-empty strings/)
  assert.throws(() => normalizeVerifyCheck({ name: 'bad-argv-3', argv: [123] }), /argv must be a non-empty array of non-empty strings/)

  assert.throws(() => normalizeVerifyCheck({ name: 'bad-diff-1', forbid: [] }), /forbid must be a non-empty array of non-empty strings/)
  assert.throws(() => normalizeVerifyCheck({ name: 'bad-diff-2', forbid: [''] }), /forbid must be a non-empty array of non-empty strings/)
})

test('normalizeVerifyCheck handles artifact and diff kinds with defaults', () => {
  const artCheck = normalizeVerifyCheck({
    name: 'evidence',
    artifact: 'summary.json'
  })
  assert.deepEqual(artCheck, {
    name: 'evidence',
    kind: 'artifact',
    artifact: 'summary.json',
    from: null
  })

  const artCheckFrom = normalizeVerifyCheck({
    name: 'evidence-from',
    artifact: 'summary.json',
    from: 'build-step'
  })
  assert.deepEqual(artCheckFrom, {
    name: 'evidence-from',
    kind: 'artifact',
    artifact: 'summary.json',
    from: 'build-step'
  })

  const diffCheck = normalizeVerifyCheck({
    name: 'scope',
    forbid: ['src/gen']
  })
  assert.deepEqual(diffCheck, {
    name: 'scope',
    kind: 'diff',
    forbid: ['src/gen'],
    base: 'HEAD'
  })

  const diffCheckCustom = normalizeVerifyCheck({
    name: 'scope-custom',
    forbid: ['docs/'],
    base: 'origin/main'
  })
  assert.deepEqual(diffCheckCustom, {
    name: 'scope-custom',
    kind: 'diff',
    forbid: ['docs/'],
    base: 'origin/main'
  })
})

test('runVerification: returns null when node has no verify config', async () => {
  const result = await runVerification({ node: {} })
  assert.equal(result, null)
})

test('runVerification: argv check passing, failing, timing out, and runner receives raw argv (never shell string)', async () => {
  const calls = []
  const fakeRunCommand = async (cmd, args, options) => {
    calls.push({ cmd, args, options })
    if (cmd === 'node' && args[0] === '--test') {
      return { stdout: 'ok', stderr: '', code: 0, timedOut: false }
    }
    if (cmd === 'custom-code') {
      return { stdout: '', stderr: 'expected exit 2', code: 2, timedOut: false }
    }
    if (cmd === 'fail-cmd') {
      return { stdout: '', stderr: 'error', code: 1, timedOut: false }
    }
    if (cmd === 'timeout-cmd') {
      return { stdout: '', stderr: '', code: null, timedOut: true }
    }
    return { stdout: '', stderr: '', code: 0, timedOut: false }
  }

  const node = {
    verify: [
      { name: 'test-pass', argv: ['node', '--test'], cwd: '/custom/dir', timeoutS: 45 },
      { name: 'test-custom-code', argv: ['custom-code'], expectExitCode: 2 },
      { name: 'test-fail', argv: ['fail-cmd'] },
      { name: 'test-timeout', argv: ['timeout-cmd'] }
    ]
  }

  const env = { TEST_ENV: '1' }
  const verdict = await runVerification({
    node,
    workflowId: 'wf-1',
    stepId: 'step-1',
    cwd: '/default/dir',
    env,
    runCommandFn: fakeRunCommand,
    timeoutS: 120
  })

  assert.equal(verdict.verified, false)
  assert.equal(verdict.required, false)
  assert.equal(verdict.checks.length, 4)

  assert.deepEqual(verdict.checks[0], {
    name: 'test-pass',
    kind: 'argv',
    passed: true,
    exitCode: 0,
    timedOut: false,
    expectExitCode: 0
  })

  assert.deepEqual(verdict.checks[1], {
    name: 'test-custom-code',
    kind: 'argv',
    passed: true,
    exitCode: 2,
    timedOut: false,
    expectExitCode: 2
  })

  assert.deepEqual(verdict.checks[2], {
    name: 'test-fail',
    kind: 'argv',
    passed: false,
    exitCode: 1,
    timedOut: false,
    expectExitCode: 0
  })

  assert.deepEqual(verdict.checks[3], {
    name: 'test-timeout',
    kind: 'argv',
    passed: false,
    exitCode: null,
    timedOut: true,
    expectExitCode: 0
  })

  assert.equal(calls.length, 4)
  assert.equal(calls[0].cmd, 'node')
  assert.deepEqual(calls[0].args, ['--test'])
  assert.equal(calls[0].options.cwd, '/custom/dir')
  assert.equal(calls[0].options.timeoutMs, 45000)
  assert.equal(calls[0].options.env, env)

  assert.equal(calls[1].cmd, 'custom-code')
  assert.deepEqual(calls[1].args, [])
  assert.equal(calls[1].options.cwd, '/default/dir')
  assert.equal(calls[1].options.timeoutMs, 120000)
})

test('runVerification: artifact check passes when artifact exists and fails when missing, from selects another step', async () => {
  const env = makeTempEnv()
  writeArtifact({
    workflowId: 'wf-art',
    stepId: 'step-1',
    name: 'output.json',
    content: '{"status":"ok"}'
  }, env)

  writeArtifact({
    workflowId: 'wf-art',
    stepId: 'step-pre',
    name: 'build-info.json',
    content: '{"built":true}'
  }, env)

  const node = {
    verify: {
      required: true,
      checks: [
        { name: 'current-step-artifact', artifact: 'output.json' },
        { name: 'from-step-artifact', artifact: 'build-info.json', from: 'step-pre' },
        { name: 'missing-artifact', artifact: 'missing.json' }
      ]
    }
  }

  const verdict = await runVerification({
    node,
    workflowId: 'wf-art',
    stepId: 'step-1',
    env
  })

  assert.equal(verdict.verified, false)
  assert.equal(verdict.required, true)
  assert.equal(verdict.checks.length, 3)

  assert.deepEqual(verdict.checks[0], {
    name: 'current-step-artifact',
    kind: 'artifact',
    passed: true,
    ref: 'artifact://wf-art/step-1/output.json'
  })

  assert.deepEqual(verdict.checks[1], {
    name: 'from-step-artifact',
    kind: 'artifact',
    passed: true,
    ref: 'artifact://wf-art/step-pre/build-info.json'
  })

  assert.deepEqual(verdict.checks[2], {
    name: 'missing-artifact',
    kind: 'artifact',
    passed: false,
    ref: 'artifact://wf-art/step-1/missing.json'
  })
})

test('runVerification: diff check passed on clean list, failed on forbid match, and avoids substring false positives', async () => {
  const diffOutputs = {
    clean: 'src/index.mjs\nREADME.md\ntest/verify.test.mjs\n',
    prefixMatch: 'src/gen/models.mjs\nsrc/index.mjs\n',
    exactMatch: 'package.json\nsrc/index.mjs\n',
    substringNoMatch: 'src/generated/models.mjs\npackage.json.bak\n',
    diffFailure: 'fatal: ambiguous argument'
  }

  let currentMode = 'clean'
  const recordedCalls = []
  const fakeRunCommand = async (cmd, args, options) => {
    recordedCalls.push({ cmd, args, options })
    if (currentMode === 'diffFailure') {
      return { stdout: '', stderr: diffOutputs.diffFailure, code: 128, timedOut: false }
    }
    return { stdout: diffOutputs[currentMode], stderr: '', code: 0, timedOut: false }
  }

  const node = {
    verify: [
      { name: 'check-diff', forbid: ['src/gen', 'package.json'], base: 'HEAD~1' }
    ]
  }

  currentMode = 'clean'
  const vClean = await runVerification({
    node,
    workflowId: 'wf-diff',
    stepId: 's1',
    cwd: '/repo',
    runCommandFn: fakeRunCommand
  })
  assert.equal(vClean.verified, true)
  assert.deepEqual(vClean.checks[0], {
    name: 'check-diff',
    kind: 'diff',
    passed: true,
    base: 'HEAD~1',
    changed: ['src/index.mjs', 'README.md', 'test/verify.test.mjs'],
    forbidden: []
  })
  assert.equal(recordedCalls[0].cmd, 'git')
  assert.deepEqual(recordedCalls[0].args, ['diff', '--name-only', 'HEAD~1'])

  currentMode = 'prefixMatch'
  const vPrefix = await runVerification({
    node,
    workflowId: 'wf-diff',
    stepId: 's1',
    cwd: '/repo',
    runCommandFn: fakeRunCommand
  })
  assert.equal(vPrefix.verified, false)
  assert.deepEqual(vPrefix.checks[0].forbidden, ['src/gen/models.mjs'])
  assert.equal(vPrefix.checks[0].passed, false)

  currentMode = 'exactMatch'
  const vExact = await runVerification({
    node,
    workflowId: 'wf-diff',
    stepId: 's1',
    cwd: '/repo',
    runCommandFn: fakeRunCommand
  })
  assert.equal(vExact.verified, false)
  assert.deepEqual(vExact.checks[0].forbidden, ['package.json'])
  assert.equal(vExact.checks[0].passed, false)

  currentMode = 'substringNoMatch'
  const vSub = await runVerification({
    node,
    workflowId: 'wf-diff',
    stepId: 's1',
    cwd: '/repo',
    runCommandFn: fakeRunCommand
  })
  assert.equal(vSub.verified, true)
  assert.deepEqual(vSub.checks[0].forbidden, [])
  assert.equal(vSub.checks[0].passed, true)

  currentMode = 'diffFailure'
  const vFail = await runVerification({
    node,
    workflowId: 'wf-diff',
    stepId: 's1',
    cwd: '/repo',
    runCommandFn: fakeRunCommand
  })
  assert.equal(vFail.verified, false)
  assert.equal(vFail.checks[0].passed, false)
})

test('runVerification: aggregation requires every check to pass and captures ISO timestamps', async () => {
  const env = makeTempEnv()
  writeArtifact({
    workflowId: 'wf-all',
    stepId: 's1',
    name: 'evidence.txt',
    content: 'valid'
  }, env)

  const fakeRunCommand = async (cmd) => {
    if (cmd === 'git') {
      return { stdout: 'clean.txt\n', stderr: '', code: 0, timedOut: false }
    }
    return { stdout: '', stderr: '', code: 0, timedOut: false }
  }

  const allPassNode = {
    verify: {
      required: true,
      checks: [
        { name: 'cmd', argv: ['test-runner'] },
        { name: 'art', artifact: 'evidence.txt' },
        { name: 'diff', forbid: ['restricted/'] }
      ]
    }
  }

  const vAllPass = await runVerification({
    node: allPassNode,
    workflowId: 'wf-all',
    stepId: 's1',
    env,
    runCommandFn: fakeRunCommand
  })

  assert.equal(vAllPass.verified, true)
  assert.equal(vAllPass.required, true)
  assert.equal(vAllPass.checks.length, 3)
  assert.ok(Date.parse(vAllPass.startedAt) <= Date.parse(vAllPass.finishedAt))

  const oneFailsNode = {
    verify: [
      { name: 'cmd-pass', argv: ['test-runner'] },
      { name: 'art-missing', artifact: 'missing.txt' }
    ]
  }

  const vOneFails = await runVerification({
    node: oneFailsNode,
    workflowId: 'wf-all',
    stepId: 's1',
    env,
    runCommandFn: fakeRunCommand
  })

  assert.equal(vOneFails.verified, false)
  assert.equal(vOneFails.required, false)
  assert.equal(vOneFails.checks[0].passed, true)
  assert.equal(vOneFails.checks[1].passed, false)
})

test('normalizeVerifyCheck handles schema kind with defaults, precedence, and error handling', () => {
  const checkDefault = normalizeVerifyCheck({
    name: 'schema-default',
    schema: 'BaseHandoff'
  })
  assert.deepEqual(checkDefault, {
    name: 'schema-default',
    kind: 'schema',
    schema: 'BaseHandoff',
    artifact: 'handoff.json',
    from: null
  })

  const checkCustom = normalizeVerifyCheck({
    name: 'schema-custom',
    schema: 'ReviewHandoff',
    artifact: 'custom-review.json',
    from: 'prev-step'
  })
  assert.deepEqual(checkCustom, {
    name: 'schema-custom',
    kind: 'schema',
    schema: 'ReviewHandoff',
    artifact: 'custom-review.json',
    from: 'prev-step'
  })

  // Precedence: schema evaluated before argv/artifact/forbid
  const checkPrecedence = normalizeVerifyCheck({
    name: 'schema-precedence',
    schema: 'BaseHandoff',
    artifact: 'artifact.json',
    argv: ['echo', 'hi'],
    forbid: ['docs/']
  })
  assert.equal(checkPrecedence.kind, 'schema')
  assert.equal(checkPrecedence.artifact, 'artifact.json')

  // (f) an unknown schema name throws when normalizing
  assert.throws(
    () => normalizeVerifyCheck({ name: 'schema-unknown', schema: 'NonExistentSchema' }),
    /NonExistentSchema/
  )
})

test('runVerification: schema check cases (a) valid passes, (b) invalid fails with path, (c) unparseable JSON, (d) missing file, (e) from step', async () => {
  const env = makeTempEnv()
  const workflowId = 'wf-schema'
  const stepId = 'step-curr'

  // (a) valid handoff passes
  writeArtifact({
    workflowId,
    stepId,
    name: 'handoff.json',
    content: JSON.stringify({ summary: 'Implemented schema validation' })
  }, env)

  // (b) invalid handoff (missing summary) fails and detail.errors names the path
  writeArtifact({
    workflowId,
    stepId,
    name: 'invalid-handoff.json',
    content: JSON.stringify({ summary: '' })
  }, env)

  // (c) unparseable JSON fails with a json error entry
  writeArtifact({
    workflowId,
    stepId,
    name: 'corrupt.json',
    content: '{ not json '
  }, env)

  // (e) 'from' selects another step's artifact
  writeArtifact({
    workflowId,
    stepId: 'step-producer',
    name: 'from-handoff.json',
    content: JSON.stringify({ summary: 'Producer step summary' })
  }, env)

  // (d) missing file is not written: 'missing.json'

  const node = {
    verify: [
      { name: 'check-valid', schema: 'BaseHandoff' },
      { name: 'check-invalid', schema: 'BaseHandoff', artifact: 'invalid-handoff.json' },
      { name: 'check-bad-json', schema: 'BaseHandoff', artifact: 'corrupt.json' },
      { name: 'check-missing', schema: 'BaseHandoff', artifact: 'missing.json' },
      { name: 'check-from', schema: 'BaseHandoff', artifact: 'from-handoff.json', from: 'step-producer' }
    ]
  }

  const verdict = await runVerification({
    node,
    workflowId,
    stepId,
    env
  })

  assert.equal(verdict.verified, false)
  assert.equal(verdict.checks.length, 5)

  // (a) valid handoff passes
  assert.deepEqual(verdict.checks[0], {
    name: 'check-valid',
    kind: 'schema',
    passed: true,
    ref: 'artifact://wf-schema/step-curr/handoff.json',
    schema: 'BaseHandoff',
    errors: []
  })

  // (b) invalid handoff fails and detail.errors names the path
  assert.equal(verdict.checks[1].name, 'check-invalid')
  assert.equal(verdict.checks[1].kind, 'schema')
  assert.equal(verdict.checks[1].passed, false)
  assert.equal(verdict.checks[1].ref, 'artifact://wf-schema/step-curr/invalid-handoff.json')
  assert.equal(verdict.checks[1].schema, 'BaseHandoff')
  assert.ok(Array.isArray(verdict.checks[1].errors))
  assert.ok(verdict.checks[1].errors.some(e => e.path === 'summary'))

  // (c) unparseable JSON fails with a json error entry
  assert.deepEqual(verdict.checks[2], {
    name: 'check-bad-json',
    kind: 'schema',
    passed: false,
    ref: 'artifact://wf-schema/step-curr/corrupt.json',
    schema: 'BaseHandoff',
    errors: verdict.checks[2].errors
  })
  assert.equal(verdict.checks[2].errors.length, 1)
  assert.equal(verdict.checks[2].errors[0].path, 'json')
  assert.ok(typeof verdict.checks[2].errors[0].message === 'string')

  // (d) missing file fails with an artifact error entry
  assert.deepEqual(verdict.checks[3], {
    name: 'check-missing',
    kind: 'schema',
    passed: false,
    ref: 'artifact://wf-schema/step-curr/missing.json',
    schema: 'BaseHandoff',
    errors: verdict.checks[3].errors
  })
  assert.equal(verdict.checks[3].errors.length, 1)
  assert.equal(verdict.checks[3].errors[0].path, 'artifact')
  assert.ok(typeof verdict.checks[3].errors[0].message === 'string')

  // (e) 'from' selects another step's artifact
  assert.deepEqual(verdict.checks[4], {
    name: 'check-from',
    kind: 'schema',
    passed: true,
    ref: 'artifact://wf-schema/step-producer/from-handoff.json',
    schema: 'BaseHandoff',
    errors: []
  })
})

// D2 (agy-hub-verification): delegate/dispatch's job-level verification.
// runJobVerification is the ONLY caller-facing entry point for that use
// case; it reuses normalizeVerifyCheck for validation and the same argv
// execution primitive runVerification's argv branch uses (never a second
// verifier), but shapes each result as {name, ok, exitCode, durationMs,
// outputTail} — the job-record shape delegate/dispatch/job_result expose.

test('runJobVerification: returns null for no checks (undefined, null, or empty array)', async () => {
  assert.equal(await runJobVerification({ checks: undefined }), null)
  assert.equal(await runJobVerification({ checks: null }), null)
  assert.equal(await runJobVerification({ checks: [] }), null)
})

test('runJobVerification: validates checks via normalizeVerifyCheck and throws fast on an invalid one, before running anything', async () => {
  let ran = false
  const fakeRunCommand = async () => {
    ran = true
    return { stdout: '', stderr: '', code: 0, timedOut: false }
  }
  await assert.rejects(
    () =>
      runJobVerification({
        checks: [
          { name: 'ok', argv: ['npm', 'test'] },
          { name: 'bad', argv: [] }
        ],
        cwd: '/repo',
        runCommandFn: fakeRunCommand
      }),
    /argv must be a non-empty array of non-empty strings/
  )
  assert.equal(ran, false, 'no check may run once any check in the batch is invalid')
})

test('runJobVerification: runs argv checks in the job cwd by default, records ok/exitCode/durationMs/outputTail, and ok is the AND of every check', async () => {
  const calls = []
  const fakeRunCommand = async (cmd, args, options) => {
    calls.push({ cmd, args, options })
    if (cmd === 'npm') return { stdout: 'all tests passed\n', stderr: '', code: 0, timedOut: false }
    return { stdout: '', stderr: 'lint failed on 2 files\n', code: 1, timedOut: false }
  }

  const result = await runJobVerification({
    checks: [
      { name: 'tests', argv: ['npm', 'test'] },
      { name: 'lint', argv: ['eslint', '.'] }
    ],
    cwd: '/job/cwd',
    runCommandFn: fakeRunCommand
  })

  assert.equal(result.ok, false)
  assert.equal(result.checks.length, 2)

  assert.equal(result.checks[0].name, 'tests')
  assert.equal(result.checks[0].ok, true)
  assert.equal(result.checks[0].exitCode, 0)
  assert.equal(typeof result.checks[0].durationMs, 'number')
  assert.ok(result.checks[0].durationMs >= 0)
  assert.match(result.checks[0].outputTail, /all tests passed/)

  assert.equal(result.checks[1].name, 'lint')
  assert.equal(result.checks[1].ok, false)
  assert.equal(result.checks[1].exitCode, 1)
  assert.match(result.checks[1].outputTail, /lint failed/)

  // job cwd is the default when a check has no explicit cwd of its own.
  assert.equal(calls[0].options.cwd, '/job/cwd')
  assert.equal(calls[1].options.cwd, '/job/cwd')
})

test('runJobVerification: a per-check cwd overrides the job cwd default', async () => {
  const calls = []
  const fakeRunCommand = async (cmd, args, options) => {
    calls.push(options)
    return { stdout: '', stderr: '', code: 0, timedOut: false }
  }
  await runJobVerification({
    checks: [{ name: 'tests', argv: ['npm', 'test'], cwd: '/other/dir' }],
    cwd: '/job/cwd',
    runCommandFn: fakeRunCommand
  })
  assert.equal(calls[0].cwd, '/other/dir')
})

test('runJobVerification: a timed-out check is not ok and never a shell (argv passed through untouched)', async () => {
  const calls = []
  const fakeRunCommand = async (cmd, args, options) => {
    calls.push({ cmd, args, options })
    return { stdout: '', stderr: '', code: null, timedOut: true }
  }
  const result = await runJobVerification({
    checks: [{ name: 'slow', argv: ['sleep', '999'] }],
    cwd: '/job/cwd',
    runCommandFn: fakeRunCommand
  })
  assert.equal(result.ok, false)
  assert.equal(result.checks[0].ok, false)
  assert.equal(result.checks[0].exitCode, null)
  assert.equal(calls[0].cmd, 'sleep')
  assert.deepEqual(calls[0].args, ['999'])
})

test('runJobVerification: outputTail is bounded and keeps the END of long output (failures usually surface at the tail)', async () => {
  const longOutput = 'x'.repeat(10_000) + 'THE_REAL_FAILURE_REASON'
  const fakeRunCommand = async () => ({ stdout: longOutput, stderr: '', code: 1, timedOut: false })
  const result = await runJobVerification({
    checks: [{ name: 'tests', argv: ['npm', 'test'] }],
    cwd: '/job/cwd',
    runCommandFn: fakeRunCommand
  })
  assert.ok(result.checks[0].outputTail.length < longOutput.length)
  assert.match(result.checks[0].outputTail, /THE_REAL_FAILURE_REASON$/)
})

test('runJobVerification: a non-argv check (artifact) still runs via the shared runVerification path and shapes into {ok, exitCode:null, durationMs:null, outputTail:null}', async () => {
  const env = makeTempEnv()
  writeArtifact({ workflowId: 'wf-job', stepId: 'step-1', name: 'output.json', content: '{}' }, env)

  const result = await runJobVerification({
    checks: [{ name: 'evidence', artifact: 'output.json' }],
    cwd: '/job/cwd',
    workflowId: 'wf-job',
    stepId: 'step-1',
    env
  })
  assert.equal(result.ok, true)
  assert.deepEqual(result.checks[0], { name: 'evidence', ok: true, exitCode: null, durationMs: null, outputTail: null })
})


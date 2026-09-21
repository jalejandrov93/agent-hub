import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import {
  ARTIFACT_SEGMENT_PATTERN,
  artifactsDir,
  artifactPath,
  artifactRef,
  parseArtifactRef,
  writeArtifact,
  readArtifact,
  existsArtifact,
  listArtifacts,
  collectManifest,
  resolveArtifactRefs,
  manifestPath,
  writeManifest
} from '../src/artifacts.mjs'

function makeEnv() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-artifacts-test-'))
  return { ...process.env, AGENT_HUB_HOME: dir }
}

test('artifactRef and parseArtifactRef round-trip valid segments', () => {
  const ref = artifactRef('wf-1', 'step_A', 'output.json')
  assert.equal(ref, 'artifact://wf-1/step_A/output.json')

  const parsed = parseArtifactRef(ref)
  assert.deepEqual(parsed, {
    workflowId: 'wf-1',
    stepId: 'step_A',
    name: 'output.json'
  })
})

test('parseArtifactRef returns null for malformed refs', () => {
  assert.equal(parseArtifactRef('http://wf/step/name'), null)
  assert.equal(parseArtifactRef('artifact://wf/step'), null)
  assert.equal(parseArtifactRef('artifact://wf/step/name/extra'), null)
  assert.equal(parseArtifactRef('artifact://wf/step/../name'), null)
  assert.equal(parseArtifactRef('artifact://wf//name'), null)
  assert.equal(parseArtifactRef('artifact://.wf/step/name'), null)
  assert.equal(parseArtifactRef('artifact://wf/step/name with space'), null)
  assert.equal(parseArtifactRef(''), null)
  assert.equal(parseArtifactRef(null), null)
  assert.equal(parseArtifactRef(undefined), null)
  assert.equal(parseArtifactRef(123), null)
})

test('ARTIFACT_SEGMENT_PATTERN and path validation reject path traversal', () => {
  const env = makeEnv()

  assert.ok(ARTIFACT_SEGMENT_PATTERN.test('valid-name_1.txt'))
  assert.equal(ARTIFACT_SEGMENT_PATTERN.test('..'), false)
  assert.equal(ARTIFACT_SEGMENT_PATTERN.test('../x'), false)
  assert.equal(ARTIFACT_SEGMENT_PATTERN.test('a/b'), false)
  assert.equal(ARTIFACT_SEGMENT_PATTERN.test(''), false)
  assert.equal(ARTIFACT_SEGMENT_PATTERN.test('.hidden'), false)

  assert.throws(() => artifactPath({ workflowId: 'wf', stepId: 's', name: '../x' }, env))
  assert.throws(() => artifactPath({ workflowId: 'wf', stepId: '..', name: 'out.txt' }, env))
  assert.throws(() => artifactPath({ workflowId: 'wf', stepId: 's', name: 'a/b' }, env))
  assert.throws(() => artifactPath({ workflowId: 'wf', stepId: 's', name: '' }, env))
  assert.throws(() => artifactPath({ workflowId: 'wf', stepId: 's', name: null }, env))
  assert.throws(() => artifactsDir({ workflowId: '..', stepId: 's' }, env))
  assert.throws(() => artifactsDir({ workflowId: 'wf', stepId: '..' }, env))
  assert.throws(() => artifactRef('wf', '..', 'name'))
})

test('writeArtifact and readArtifact preserve content equality and sha256', () => {
  const env = makeEnv()
  const content = 'Hello world, evidence string'
  const expectedSha256 = crypto.createHash('sha256').update(content).digest('hex')

  const written = writeArtifact({
    workflowId: 'wf-42',
    stepId: 'step-1',
    name: 'evidence.txt',
    content
  }, env)

  assert.equal(written.ref, 'artifact://wf-42/step-1/evidence.txt')
  assert.equal(written.bytes, Buffer.byteLength(content))
  assert.equal(written.sha256, expectedSha256)
  assert.ok(fs.existsSync(written.path))

  const readByRef = readArtifact(written.ref, env)
  assert.equal(readByRef.content, content)
  assert.equal(readByRef.bytes, written.bytes)
  assert.equal(readByRef.sha256, expectedSha256)
  assert.equal(readByRef.path, written.path)

  const readBySpec = readArtifact({
    workflowId: 'wf-42',
    stepId: 'step-1',
    name: 'evidence.txt'
  }, env)
  assert.equal(readBySpec.content, content)

  assert.equal(existsArtifact(written.ref, env), true)
  assert.equal(existsArtifact({ workflowId: 'wf-42', stepId: 'step-1', name: 'evidence.txt' }, env), true)

  const bufContent = Buffer.from('buffer-payload')
  const writtenBuf = writeArtifact({
    workflowId: 'wf-42',
    stepId: 'step-1',
    name: 'binary.bin',
    content: bufContent
  }, env)
  assert.equal(writtenBuf.bytes, bufContent.byteLength)
})

test('missing read throws with the ref in the message and existsArtifact returns false', () => {
  const env = makeEnv()
  const ref = 'artifact://wf-1/step-1/nonexistent.txt'

  assert.equal(existsArtifact(ref, env), false)
  assert.equal(existsArtifact({ workflowId: 'wf-1', stepId: 'step-1', name: 'nonexistent.txt' }, env), false)

  assert.throws(
    () => readArtifact(ref, env),
    (err) => err instanceof Error && err.message === 'artifact not found: ' + ref
  )
  assert.throws(
    () => readArtifact({ workflowId: 'wf-1', stepId: 'step-1', name: 'nonexistent.txt' }, env),
    (err) => err instanceof Error && err.message === 'artifact not found: ' + ref
  )
})

test('listArtifacts returns empty array on absent dir and sorted artifacts when present', () => {
  const env = makeEnv()
  assert.deepEqual(listArtifacts({ workflowId: 'wf-empty', stepId: 'step-none' }, env), [])

  writeArtifact({ workflowId: 'wf-1', stepId: 'step-1', name: 'z-last.txt', content: 'z' }, env)
  writeArtifact({ workflowId: 'wf-1', stepId: 'step-1', name: 'a-first.txt', content: 'a' }, env)
  writeArtifact({ workflowId: 'wf-1', stepId: 'step-1', name: 'm-mid.txt', content: 'm' }, env)

  const list = listArtifacts({ workflowId: 'wf-1', stepId: 'step-1' }, env)
  assert.equal(list.length, 3)
  assert.deepEqual(list.map((a) => a.name), ['a-first.txt', 'm-mid.txt', 'z-last.txt'])
  assert.equal(list[0].ref, 'artifact://wf-1/step-1/a-first.txt')
  assert.equal(list[0].bytes, 1)
})

test('collectManifest separates present and missing artifacts without throwing', () => {
  const env = makeEnv()
  writeArtifact({ workflowId: 'wf-1', stepId: 'step-1', name: 'report.md', content: '# Done' }, env)

  const manifest = collectManifest({
    workflowId: 'wf-1',
    stepId: 'step-1',
    declared: ['report.md', 'diff.patch']
  }, env)

  assert.deepEqual(manifest.declared, ['report.md', 'diff.patch'])
  assert.deepEqual(manifest.present, ['report.md'])
  assert.deepEqual(manifest.missing, ['diff.patch'])
  assert.equal(manifest.artifacts['report.md'].exists, true)
  assert.equal(manifest.artifacts['report.md'].bytes, 6)
  assert.ok(manifest.artifacts['report.md'].sha256)
  assert.equal(manifest.artifacts['diff.patch'].exists, false)
  assert.equal(manifest.artifacts['diff.patch'].bytes, 0)
  assert.equal(manifest.artifacts['diff.patch'].sha256, null)
})

test('resolveArtifactRefs inlines content, truncates over maxBytesPerRef, and reports missing', () => {
  const env = makeEnv()
  writeArtifact({ workflowId: 'wf-1', stepId: 's1', name: 'doc.txt', content: 'Inlined text' }, env)
  writeArtifact({ workflowId: 'wf-1', stepId: 's1', name: 'big.txt', content: '0123456789ABCDEF' }, env)

  const template = 'Review artifact://wf-1/s1/doc.txt and compare with artifact://wf-1/s1/missing.txt'
  const resolved = resolveArtifactRefs(template, { env })

  assert.equal(resolved.text, 'Review Inlined text and compare with artifact://wf-1/s1/missing.txt')
  assert.deepEqual(resolved.refs, [{ ref: 'artifact://wf-1/s1/doc.txt', bytes: 12, truncated: false }])
  assert.deepEqual(resolved.missing, ['artifact://wf-1/s1/missing.txt'])

  const truncTemplate = 'Data: artifact://wf-1/s1/big.txt'
  const truncResolved = resolveArtifactRefs(truncTemplate, { env, maxBytesPerRef: 10 })

  assert.equal(truncResolved.text, 'Data: 0123456789\n...[artifact truncated]')
  assert.deepEqual(truncResolved.refs, [{ ref: 'artifact://wf-1/s1/big.txt', bytes: 16, truncated: true }])
  assert.deepEqual(truncResolved.missing, [])
})

test('manifestPath returns expected path and rejects invalid segments or traversal', () => {
  const env = makeEnv()
  const p = manifestPath({ workflowId: 'wf-1', stepId: 'step-1' }, env)
  assert.equal(p, path.join(env.AGENT_HUB_HOME, 'runs', 'wf-1', 'step-1', 'artifacts.manifest.json'))

  assert.throws(() => manifestPath({ workflowId: '..', stepId: 'step-1' }, env))
  assert.throws(() => manifestPath({ workflowId: 'wf-1', stepId: '..' }, env))
  assert.throws(() => manifestPath({ workflowId: 'wf/1', stepId: 'step-1' }, env))
  assert.throws(() => manifestPath({ workflowId: '', stepId: 'step-1' }, env))
  assert.throws(() => manifestPath({ workflowId: 'wf-1', stepId: '' }, env))
  assert.throws(() => manifestPath({ workflowId: null, stepId: 'step-1' }, env))
  assert.throws(() => manifestPath({ workflowId: 'wf-1', stepId: null }, env))
})

test('writeManifest writes manifest atomically and round-trips correctly', () => {
  const env = makeEnv()
  const manifest = {
    declared: ['report.md', 'diff.patch'],
    present: ['report.md'],
    missing: ['diff.patch'],
    artifacts: {
      'report.md': { ref: 'artifact://wf-1/s1/report.md', exists: true, bytes: 10, sha256: 'abc' },
      'diff.patch': { ref: 'artifact://wf-1/s1/diff.patch', exists: false, bytes: 0, sha256: null }
    }
  }

  const written = writeManifest({ workflowId: 'wf-1', stepId: 's1' }, manifest, env)
  const expectedPath = manifestPath({ workflowId: 'wf-1', stepId: 's1' }, env)

  assert.equal(written.ref, 'artifact://wf-1/s1/manifest.json')
  assert.equal(written.path, expectedPath)
  assert.ok(written.updatedAt)
  assert.deepEqual(written.present, ['report.md'])
  assert.deepEqual(written.missing, ['diff.patch'])

  assert.ok(fs.existsSync(expectedPath))
  const parsed = JSON.parse(fs.readFileSync(expectedPath, 'utf8'))
  assert.equal(parsed.ref, 'artifact://wf-1/s1/manifest.json')
  assert.equal(parsed.path, expectedPath)
  assert.equal(parsed.updatedAt, written.updatedAt)
  assert.deepEqual(parsed.present, ['report.md'])
  assert.deepEqual(parsed.missing, ['diff.patch'])

  assert.throws(() => writeManifest({ workflowId: '..', stepId: 's1' }, manifest, env))
  assert.throws(() => writeManifest({ workflowId: 'wf-1', stepId: '..' }, manifest, env))
})


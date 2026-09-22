import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkInstallSource } from '../scripts/install-guard.mjs'

test('install guard: clean main is allowed', () => {
  assert.deepEqual(checkInstallSource({ branch: 'main', dirty: false }), { ok: true, reason: null })
})

test('install guard: a feature branch is refused with a clear reason', () => {
  const result = checkInstallSource({ branch: 'feat/x', dirty: false })
  assert.equal(result.ok, false)
  assert.match(result.reason, /feat\/x/)
  assert.match(result.reason, /--allow-branch/)
})

test('install guard: a dirty tracked tree on main is refused', () => {
  const result = checkInstallSource({ branch: 'main', dirty: true })
  assert.equal(result.ok, false)
  assert.match(result.reason, /uncommitted/)
})

test('install guard: a detached HEAD is refused like any non-main branch', () => {
  assert.equal(checkInstallSource({ branch: null, dirty: false }).ok, false)
})

test('install guard: --allow-branch overrides both checks', () => {
  assert.deepEqual(checkInstallSource({ branch: 'feat/x', dirty: true, allowBranch: true }), { ok: true, reason: null })
})

test('install guard: unknown git state (no repo) is allowed, matching tarball installs', () => {
  assert.deepEqual(checkInstallSource({ branch: undefined, dirty: undefined }), { ok: true, reason: null })
})

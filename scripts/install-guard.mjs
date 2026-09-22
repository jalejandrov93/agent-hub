import { execFileSync } from 'node:child_process'

/**
 * Decide whether the checkout may be installed as the runtime copy. The
 * runtime must come from a clean `main` so an in-progress branch never ends up
 * serving every client. `branch`/`dirty` are undefined when there is no git
 * repository (tarball install), which is allowed. `branch` is null on a
 * detached HEAD.
 */
export function checkInstallSource({ branch, dirty, allowBranch = false } = {}) {
  if (allowBranch || (branch === undefined && dirty === undefined)) return { ok: true, reason: null }
  if (branch !== 'main') {
    return {
      ok: false,
      reason: `checkout is on ${branch ?? 'a detached HEAD'}, not main; switch to main or pass --allow-branch to install it deliberately`,
    }
  }
  if (dirty) {
    return { ok: false, reason: 'checkout has uncommitted changes to tracked files; commit or stash them, or pass --allow-branch' }
  }
  return { ok: true, reason: null }
}

/** Read the checkout's branch and tracked-dirty state; both undefined outside git. */
export function readGitState(cwd) {
  try {
    const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, encoding: 'utf8' }).trim()
    const status = execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd, encoding: 'utf8' }).trim()
    return { branch: branch === 'HEAD' ? null : branch, dirty: status.length > 0 }
  } catch {
    return { branch: undefined, dirty: undefined }
  }
}

import { runCommand as runCommandDefault } from '../process.mjs'

/**
 * Parse the GitHub remote forms git emits: scp-like `git@github.com:o/r.git`,
 * `https://github.com/o/r(.git)` and `ssh://git@github.com/o/r.git`. Any
 * non-GitHub host (or anything unrecognised) yields null so callers can fail
 * with a precise message instead of guessing.
 */
export function parseGitHubRemote(url) {
  if (typeof url !== 'string') return null
  const trimmed = url.trim().replace(/\/+$/, '')
  if (trimmed.length === 0) return null

  const scp = trimmed.match(/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/)
  if (scp) return { owner: scp[1], repo: scp[2] }

  const scheme = trimmed.match(/^(?:https?|ssh):\/\/(?:[^@/]+@)?github\.com\/([^/]+)\/(.+?)(?:\.git)?$/)
  if (scheme) return { owner: scheme[1], repo: scheme[2] }

  return null
}

export function sourceNameFor({ owner, repo }) {
  return `sources/github/${owner}/${repo}`
}

export async function inferSourceFromCwd(cwd, { runCommand = runCommandDefault } = {}) {
  const remote = await runCommand('git', ['remote', 'get-url', 'origin'], { cwd })
  const remoteUrl = (remote?.stdout ?? '').trim()
  if (remote?.code !== 0 || remoteUrl.length === 0) {
    throw new Error(`no git remote 'origin' in ${cwd}`)
  }

  const parsed = parseGitHubRemote(remoteUrl)
  if (!parsed) throw new Error(`not a GitHub remote: ${remoteUrl}`)

  const branchResult = await runCommand('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd })
  if (branchResult?.code !== 0) throw new Error(`cannot resolve current branch in ${cwd}`)
  const branch = (branchResult?.stdout ?? '').trim()

  return {
    source: sourceNameFor(parsed),
    owner: parsed.owner,
    repo: parsed.repo,
    // `git rev-parse --abbrev-ref HEAD` prints "HEAD" when detached; there is
    // no branch to name, which is not an error for this flow.
    branch: branch.length === 0 || branch === 'HEAD' ? null : branch,
    remoteUrl,
  }
}

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseGitHubRemote, sourceNameFor, inferSourceFromCwd } from '../../src/cloud/gitContext.mjs'

/**
 * Stands in for src/process.mjs runCommand. Keys are `git <args joined>`;
 * anything unregistered resolves to a failing command so a missing stub is
 * loud instead of silently passing.
 */
function fakeRunCommand(handlers) {
  const calls = []
  const run = async (cmd, args, opts = {}) => {
    calls.push({ cmd, args, cwd: opts.cwd })
    const result = handlers[`${cmd} ${args.join(' ')}`]
    if (!result) return { stdout: '', stderr: 'unexpected command', code: 1, signal: null, timedOut: false, error: null }
    return { signal: null, timedOut: false, error: null, code: 0, stderr: '', ...result }
  }
  return { run, calls }
}

const REMOTE = 'git remote get-url origin'
const BRANCH = 'git rev-parse --abbrev-ref HEAD'

test('parseGitHubRemote parses the scp-like git@github.com form, with or without .git', () => {
  assert.deepEqual(parseGitHubRemote('git@github.com:acme/widgets.git'), { owner: 'acme', repo: 'widgets' })
  assert.deepEqual(parseGitHubRemote('git@github.com:acme/widgets'), { owner: 'acme', repo: 'widgets' })
})

test('parseGitHubRemote parses https github urls, with or without .git', () => {
  assert.deepEqual(parseGitHubRemote('https://github.com/acme/widgets.git'), { owner: 'acme', repo: 'widgets' })
  assert.deepEqual(parseGitHubRemote('https://github.com/acme/widgets'), { owner: 'acme', repo: 'widgets' })
})

test('parseGitHubRemote parses the ssh:// form', () => {
  assert.deepEqual(parseGitHubRemote('ssh://git@github.com/acme/widgets.git'), { owner: 'acme', repo: 'widgets' })
})

test('parseGitHubRemote tolerates a trailing slash, with or without .git', () => {
  assert.deepEqual(parseGitHubRemote('https://github.com/acme/widgets/'), { owner: 'acme', repo: 'widgets' })
  assert.deepEqual(parseGitHubRemote('https://github.com/acme/widgets.git/'), { owner: 'acme', repo: 'widgets' })
})

test('parseGitHubRemote returns null for non-GitHub and malformed remotes', () => {
  assert.equal(parseGitHubRemote('git@gitlab.com:acme/widgets.git'), null)
  assert.equal(parseGitHubRemote('https://example.com/acme/widgets'), null)
  assert.equal(parseGitHubRemote('not a url'), null)
  assert.equal(parseGitHubRemote(''), null)
  assert.equal(parseGitHubRemote(null), null)
})

test('sourceNameFor builds the resource name Jules expects', () => {
  assert.equal(sourceNameFor({ owner: 'acme', repo: 'widgets' }), 'sources/github/acme/widgets')
})

test('inferSourceFromCwd resolves source, owner, repo, branch and remoteUrl from git', async () => {
  const { run, calls } = fakeRunCommand({
    [REMOTE]: { stdout: 'git@github.com:acme/widgets.git\n', code: 0 },
    [BRANCH]: { stdout: 'main\n', code: 0 },
  })
  const result = await inferSourceFromCwd('/repo', { runCommand: run })

  assert.deepEqual(result, {
    source: 'sources/github/acme/widgets',
    owner: 'acme',
    repo: 'widgets',
    branch: 'main',
    remoteUrl: 'git@github.com:acme/widgets.git',
  })
  assert.deepEqual(calls, [
    { cmd: 'git', args: ['remote', 'get-url', 'origin'], cwd: '/repo' },
    { cmd: 'git', args: ['rev-parse', '--abbrev-ref', 'HEAD'], cwd: '/repo' },
  ])
})

test('inferSourceFromCwd returns branch null for a detached HEAD', async () => {
  const { run } = fakeRunCommand({
    [REMOTE]: { stdout: 'https://github.com/acme/widgets.git\n', code: 0 },
    [BRANCH]: { stdout: 'HEAD\n', code: 0 },
  })
  const result = await inferSourceFromCwd('/repo', { runCommand: run })
  assert.equal(result.branch, null)
})

test('inferSourceFromCwd throws the pinned message when there is no origin remote', async () => {
  const { run } = fakeRunCommand({ [REMOTE]: { stdout: '', stderr: "error: No such remote 'origin'", code: 2 } })
  await assert.rejects(() => inferSourceFromCwd('/repo', { runCommand: run }), {
    message: "no git remote 'origin' in /repo",
  })
})

test('inferSourceFromCwd throws the pinned message for a non-GitHub remote', async () => {
  const { run } = fakeRunCommand({ [REMOTE]: { stdout: 'git@gitlab.com:acme/widgets.git\n', code: 0 } })
  await assert.rejects(() => inferSourceFromCwd('/repo', { runCommand: run }), {
    message: 'not a GitHub remote: git@gitlab.com:acme/widgets.git',
  })
})

test('inferSourceFromCwd throws the pinned message when the branch command fails', async () => {
  const { run } = fakeRunCommand({
    [REMOTE]: { stdout: 'git@github.com:acme/widgets.git\n', code: 0 },
    [BRANCH]: { stdout: '', stderr: 'fatal: not a git repository', code: 128 },
  })
  await assert.rejects(() => inferSourceFromCwd('/repo', { runCommand: run }), {
    message: 'cannot resolve current branch in /repo',
  })
})

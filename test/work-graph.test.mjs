import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readRepos, buildWorkGraph, getWorkGraph } from '../src/workGraph.mjs'

// --- fake execGit helpers -------------------------------------------------
//
// Simulates a tiny two-repo world:
//   repoA: main -> wt/a -> wt/b   (linear ancestry chain)
//   repoB: main, wt/x, wt/y both branched off main at the SAME commit (tie)
//
// COMMITS maps "branch" -> an integer "height" used to derive ancestor/count
// answers deterministically without a real git checkout.
const REPO_A_ROOT = '/repos/a'
const REPO_B_ROOT = '/repos/b'

const REPO_A_HEIGHT = { main: 0, 'wt/a': 1, 'wt/b': 2 }
const REPO_B_HEIGHT = { main: 0, 'wt/x': 1, 'wt/y': 1 } // x and y tie at the same commit

function porcelainFor(entries) {
  return entries
    .map(({ path, head, branch, detached }) => {
      const lines = [`worktree ${path}`, `HEAD ${head}`]
      if (detached) lines.push('detached')
      else lines.push(`branch refs/heads/${branch}`)
      return lines.join('\n')
    })
    .join('\n\n')
    .concat('\n')
}

const REPO_A_PORCELAIN = porcelainFor([
  { path: REPO_A_ROOT, head: 'sha-main', branch: 'main' },
  { path: '/repos/a-wt-a', head: 'sha-a', branch: 'wt/a' },
  { path: '/repos/a-wt-b', head: 'sha-b', branch: 'wt/b' },
])

const REPO_B_PORCELAIN = porcelainFor([
  { path: REPO_B_ROOT, head: 'sha-main-b', branch: 'main' },
  { path: '/repos/b-wt-x', head: 'sha-tie', branch: 'wt/x' },
  { path: '/repos/b-wt-y', head: 'sha-tie', branch: 'wt/y' },
])

function heightFor(root, branch) {
  const table = root === REPO_A_ROOT ? REPO_A_HEIGHT : REPO_B_HEIGHT
  return table[branch]
}

/** A fake execGit that answers rev-parse/worktree-list/merge-base/rev-list for the two fixture repos above. */
function makeFakeExecGit({ knownCwds = new Set([REPO_A_ROOT, REPO_B_ROOT]) } = {}) {
  return function execGit(args, { cwd } = {}) {
    const [cmd] = args
    if (cmd === 'rev-parse') {
      if (!knownCwds.has(cwd)) {
        const err = new Error('not a git repository')
        err.status = 128
        throw err
      }
      return `${cwd}/.git\n`
    }
    if (cmd === 'worktree') {
      if (cwd === REPO_A_ROOT) return REPO_A_PORCELAIN
      if (cwd === REPO_B_ROOT) return REPO_B_PORCELAIN
      throw new Error(`unexpected worktree list cwd: ${cwd}`)
    }
    if (cmd === 'merge-base') {
      const [, , candidate, branch] = args
      const h1 = heightFor(cwd, candidate)
      const h2 = heightFor(cwd, branch)
      if (h1 === undefined || h2 === undefined || h1 > h2) {
        const err = new Error('not an ancestor')
        err.status = 1
        throw err
      }
      return ''
    }
    if (cmd === 'rev-list') {
      const [, , range] = args
      const [candidate, branch] = range.split('..')
      const ahead = heightFor(cwd, branch) - heightFor(cwd, candidate)
      return `${ahead}\n`
    }
    throw new Error(`unexpected git invocation: ${args.join(' ')}`)
  }
}

// --- readRepos -------------------------------------------------------------

test('readRepos resolves distinct repos, dedupes cwds, and parses worktree porcelain', () => {
  const execGit = makeFakeExecGit()
  const repos = readRepos([REPO_A_ROOT, '/repos/a-wt-a', REPO_A_ROOT, REPO_B_ROOT], { execGit })

  assert.equal(repos.length, 2)
  const [a, b] = repos
  assert.equal(a.root, REPO_A_ROOT)
  assert.equal(a.mainBranch, 'main')
  assert.equal(a.worktrees.length, 3)
  assert.deepEqual(
    a.worktrees.map((w) => w.path),
    [REPO_A_ROOT, '/repos/a-wt-a', '/repos/a-wt-b']
  )
  assert.equal(a.worktrees[0].isMain, true)
  assert.equal(a.worktrees[1].isMain, false)
  assert.equal(a.worktrees[1].branch, 'wt/a')
  assert.equal(a.worktrees[1].head, 'sha-a')
  assert.equal(b.root, REPO_B_ROOT)
})

test('readRepos tolerates a cwd outside any git repo (skipped, never throws)', () => {
  const execGit = makeFakeExecGit()
  const repos = readRepos(['/not/a/repo', REPO_A_ROOT], { execGit })
  assert.equal(repos.length, 1)
  assert.equal(repos[0].root, REPO_A_ROOT)
})

test('readRepos infers nested ancestry main -> wt/a -> wt/b via merge-base + rev-list', () => {
  const execGit = makeFakeExecGit()
  const [repo] = readRepos([REPO_A_ROOT], { execGit })
  const byBranch = Object.fromEntries(repo.worktrees.map((w) => [w.branch, w]))
  assert.equal(byBranch['wt/a'].parentBranch, 'main')
  assert.equal(byBranch['wt/b'].parentBranch, 'wt/a')
  assert.equal(byBranch['main'].parentBranch, null)
})

test('readRepos breaks an equal-commit tie deterministically (main first, then alphabetical) without a cycle', () => {
  const execGit = makeFakeExecGit()
  const [repo] = readRepos([REPO_B_ROOT], { execGit })
  const byBranch = Object.fromEntries(repo.worktrees.map((w) => [w.branch, w]))
  // wt/x and wt/y sit at the same commit as each other. Alphabetically, 'wt/x' < 'wt/y',
  // so wt/y may point at wt/x, but wt/x must never point back at wt/y (no cycle).
  assert.equal(byBranch['wt/y'].parentBranch, 'wt/x')
  assert.notEqual(byBranch['wt/x'].parentBranch, 'wt/y')
})

// --- buildWorkGraph (pure) ---------------------------------------------------

const NOW = new Date('2026-09-16T12:00:00.000Z')

const REPOS_FIXTURE = [
  {
    root: REPO_A_ROOT,
    mainBranch: 'main',
    worktrees: [
      { path: REPO_A_ROOT, branch: 'main', head: 'sha-main', isMain: true, parentBranch: null },
      { path: '/repos/a-wt-a', branch: 'wt/a', head: 'sha-a', isMain: false, parentBranch: 'main' },
      { path: '/repos/a-wt-b', branch: 'wt/b', head: 'sha-b', isMain: false, parentBranch: 'wt/a' },
    ],
  },
]

function job(overrides) {
  return {
    jobId: 'job-default',
    agent: 'agy',
    model: 'gemini',
    title: 't',
    cwd: '/repos/a-wt-a',
    mode: 'read',
    status: 'succeeded',
    createdAt: '2026-09-16T10:00:00.000Z',
    updatedAt: '2026-09-16T10:05:00.000Z',
    ...overrides,
  }
}

test('buildWorkGraph creates repo + worktree nodes and branchesFrom edges from precomputed parentBranch', () => {
  const graph = buildWorkGraph({ jobs: [], repos: REPOS_FIXTURE, now: NOW })

  const repoNode = graph.nodes.find((n) => n.kind === 'repo')
  assert.equal(repoNode.id, `repo:${REPO_A_ROOT}`)

  const wtA = graph.nodes.find((n) => n.kind === 'worktree' && n.branch === 'wt/a')
  const wtB = graph.nodes.find((n) => n.kind === 'worktree' && n.branch === 'wt/b')
  const wtMain = graph.nodes.find((n) => n.kind === 'worktree' && n.branch === 'main')
  assert.ok(wtA && wtB && wtMain)

  const edgeAtoMain = graph.edges.find((e) => e.kind === 'branchesFrom' && e.from === wtA.id)
  assert.equal(edgeAtoMain.to, wtMain.id)

  const edgeBtoA = graph.edges.find((e) => e.kind === 'branchesFrom' && e.from === wtB.id)
  assert.equal(edgeBtoA.to, wtA.id)

  // The trunk (main) worktree itself has no branchesFrom edge.
  assert.equal(
    graph.edges.some((e) => e.kind === 'branchesFrom' && e.from === wtMain.id),
    false
  )
})

test('buildWorkGraph runsIn: job.cwd resolves to the longest-prefix matching worktree, path-segment aware', () => {
  const jobs = [
    job({ jobId: 'j1', cwd: '/repos/a-wt-a' }),
    // '/repos/a-wt-a-extra' shares the string prefix '/repos/a-wt-a' but is NOT
    // inside that worktree (no path separator boundary) -> must not match it.
    job({ jobId: 'j2', cwd: '/repos/a-wt-a-extra' }),
    job({ jobId: 'j3', cwd: '/repos/a-wt-a/nested/dir' }),
  ]
  const graph = buildWorkGraph({ jobs, repos: REPOS_FIXTURE, now: NOW })
  const wtA = graph.nodes.find((n) => n.kind === 'worktree' && n.branch === 'wt/a')

  const edgeJ1 = graph.edges.find((e) => e.kind === 'runsIn' && e.from === 'job:j1')
  assert.equal(edgeJ1.to, wtA.id)

  const edgeJ3 = graph.edges.find((e) => e.kind === 'runsIn' && e.from === 'job:j3')
  assert.equal(edgeJ3.to, wtA.id, 'nested subdirectory still resolves to the containing worktree')

  const edgeJ2 = graph.edges.find((e) => e.kind === 'runsIn' && e.from === 'job:j2')
  assert.equal(edgeJ2.to, 'outside', 'a string-prefix-only match must land in the outside group, not wt/a')
})

test('buildWorkGraph groups a job with an unmatched cwd (or no cwd) into a single "outside" node', () => {
  const jobs = [job({ jobId: 'j1', cwd: '/nowhere/near/a/repo' }), job({ jobId: 'j2', cwd: null })]
  const graph = buildWorkGraph({ jobs, repos: REPOS_FIXTURE, now: NOW })

  const outsideNodes = graph.nodes.filter((n) => n.kind === 'outside')
  assert.equal(outsideNodes.length, 1, 'exactly one outside group node, even with multiple unmatched jobs')

  const runsInEdges = graph.edges.filter((e) => e.kind === 'runsIn')
  assert.equal(runsInEdges.length, 2)
  assert.ok(runsInEdges.every((e) => e.to === 'outside'))
})

test('buildWorkGraph continues: job -> parentJobId only when the parent job is also in the graph', () => {
  const jobs = [
    job({ jobId: 'parent', status: 'succeeded' }),
    job({ jobId: 'child', parentJobId: 'parent' }),
    job({ jobId: 'orphan-reply', parentJobId: 'not-in-graph' }),
  ]
  const graph = buildWorkGraph({ jobs, repos: REPOS_FIXTURE, now: NOW })

  const continuesEdges = graph.edges.filter((e) => e.kind === 'continues')
  assert.equal(continuesEdges.length, 1)
  assert.deepEqual(continuesEdges[0], { kind: 'continues', from: 'job:child', to: 'job:parent' })
})

test('buildWorkGraph waitsOn: a queued write job waits on a running write job in the same worktree', () => {
  const jobs = [
    job({ jobId: 'running-write', status: 'running', mode: 'write', cwd: '/repos/a-wt-a' }),
    job({ jobId: 'queued-write', status: 'queued', mode: 'write', cwd: '/repos/a-wt-a' }),
    // Different worktree -> must not generate a waitsOn edge.
    job({ jobId: 'queued-write-elsewhere', status: 'queued', mode: 'write', cwd: '/repos/a-wt-b' }),
    // Read mode never waits.
    job({ jobId: 'queued-read', status: 'queued', mode: 'read', cwd: '/repos/a-wt-a' }),
  ]
  const graph = buildWorkGraph({ jobs, repos: REPOS_FIXTURE, now: NOW })

  const waitsOnEdges = graph.edges.filter((e) => e.kind === 'waitsOn')
  assert.equal(waitsOnEdges.length, 1)
  assert.deepEqual(waitsOnEdges[0], { kind: 'waitsOn', from: 'job:queued-write', to: 'job:running-write' })
})

test('buildWorkGraph remote: a Jules job with remote.branch gets a remoteBranch node + remote edge', () => {
  const jobs = [
    job({
      jobId: 'jules-1',
      agent: 'jules',
      cwd: null,
      remote: { provider: 'jules', sessionId: 's1', source: 'owner/repo', startingBranch: 'main', branch: 'jules/feature-x', prUrl: 'https://example/pr/1' },
    }),
  ]
  const graph = buildWorkGraph({ jobs, repos: [], now: NOW })

  const remoteNode = graph.nodes.find((n) => n.kind === 'remoteBranch')
  assert.ok(remoteNode)
  assert.equal(remoteNode.id, 'remote:owner/repo#jules/feature-x')
  assert.equal(remoteNode.source, 'owner/repo')
  assert.equal(remoteNode.branch, 'jules/feature-x')
  assert.equal(remoteNode.startingBranch, 'main')
  assert.equal(remoteNode.prUrl, 'https://example/pr/1')

  const remoteEdge = graph.edges.find((e) => e.kind === 'remote')
  assert.deepEqual(remoteEdge, { kind: 'remote', from: 'job:jules-1', to: remoteNode.id })

  // A job with no cwd and no matching worktree still lands in 'outside' via runsIn.
  const runsInEdge = graph.edges.find((e) => e.kind === 'runsIn' && e.from === 'job:jules-1')
  assert.equal(runsInEdge.to, 'outside')
})

test('buildWorkGraph scoping: all active jobs, finished jobs within the window (capped), nothing older', () => {
  const jobs = [
    job({ jobId: 'active-running', status: 'running' }),
    job({ jobId: 'active-queued', status: 'queued' }),
    job({ jobId: 'finished-recent', status: 'succeeded', updatedAt: '2026-09-16T11:00:00.000Z' }),
    job({ jobId: 'finished-old', status: 'succeeded', updatedAt: '2026-09-14T00:00:00.000Z' }),
  ]
  const graph = buildWorkGraph({ jobs, repos: REPOS_FIXTURE, now: NOW })
  const jobIds = graph.nodes.filter((n) => n.kind === 'job').map((n) => n.jobId)

  assert.ok(jobIds.includes('active-running'))
  assert.ok(jobIds.includes('active-queued'))
  assert.ok(jobIds.includes('finished-recent'))
  assert.equal(jobIds.includes('finished-old'), false, 'finished job outside the 24h window is excluded')
})

test('buildWorkGraph scoping: finished jobs are capped to the most recent N', () => {
  const jobs = []
  for (let i = 0; i < 5; i++) {
    jobs.push(
      job({
        jobId: `finished-${i}`,
        status: 'succeeded',
        updatedAt: new Date(NOW.getTime() - i * 60_000).toISOString(),
      })
    )
  }
  const graph = buildWorkGraph({ jobs, repos: REPOS_FIXTURE, now: NOW, limits: { finishedCap: 2 } })
  const jobIds = graph.nodes.filter((n) => n.kind === 'job').map((n) => n.jobId)
  assert.equal(jobIds.length, 2)
  // Most recent two (i=0 newest, i=1 next) survive the cap.
  assert.deepEqual(new Set(jobIds), new Set(['finished-0', 'finished-1']))
})

test('buildWorkGraph node/edge ordering is deterministic across repeated calls', () => {
  const jobs = [
    job({ jobId: 'a', cwd: '/repos/a-wt-a' }),
    job({ jobId: 'b', cwd: '/repos/a-wt-b', parentJobId: 'a' }),
  ]
  const g1 = buildWorkGraph({ jobs, repos: REPOS_FIXTURE, now: NOW })
  const g2 = buildWorkGraph({ jobs, repos: REPOS_FIXTURE, now: NOW })
  assert.deepEqual(
    g1.nodes.map((n) => n.id),
    g2.nodes.map((n) => n.id)
  )
  assert.deepEqual(g1.edges, g2.edges)
})

// --- getWorkGraph (convenience wiring) --------------------------------------

test('getWorkGraph combines listJobsFn + execGit into one response with generatedAt', () => {
  const execGit = makeFakeExecGit()
  const jobs = [job({ jobId: 'j1', cwd: REPO_A_ROOT, status: 'running' })]
  const result = getWorkGraph({ listJobsFn: () => jobs, execGit, now: NOW })

  assert.equal(result.generatedAt, NOW.toISOString())
  assert.ok(result.nodes.some((n) => n.kind === 'repo' && n.root === REPO_A_ROOT))
  assert.ok(result.nodes.some((n) => n.kind === 'job' && n.jobId === 'j1'))
})

test('getWorkGraph tolerates a job cwd that is not a git repo at all (readRepos skips it)', () => {
  const execGit = makeFakeExecGit()
  const jobs = [job({ jobId: 'j1', cwd: '/totally/not/a/repo', status: 'running' })]
  const result = getWorkGraph({ listJobsFn: () => jobs, execGit, now: NOW })

  assert.equal(result.repos.length, 0)
  const runsInEdge = result.edges.find((e) => e.kind === 'runsIn')
  assert.equal(runsInEdge.to, 'outside')
})

// --- T4a: removed worktrees ---------------------------------------------------

test('buildWorkGraph: a job cwd under <repoRoot>-worktrees/ that matches no live worktree becomes a removed worktree node, grouping jobs sharing the same cwd', () => {
  const removedCwd = '/repos/a-worktrees/gone-feature'
  const jobs = [
    job({ jobId: 'j1', cwd: removedCwd, status: 'succeeded' }),
    job({ jobId: 'j2', cwd: removedCwd, status: 'succeeded' }),
  ]
  const graph = buildWorkGraph({ jobs, repos: REPOS_FIXTURE, now: NOW })

  const removedNodes = graph.nodes.filter((n) => n.kind === 'worktree' && n.removed === true)
  assert.equal(removedNodes.length, 1, 'both jobs share the same removed cwd -> exactly one removed-worktree node')
  const removedNode = removedNodes[0]
  assert.equal(removedNode.path, removedCwd)
  assert.equal(removedNode.branch, null)
  assert.equal(removedNode.label, 'gone-feature')
  assert.equal(removedNode.repoRoot, REPO_A_ROOT)

  const branchesFromEdge = graph.edges.find((e) => e.kind === 'branchesFrom' && e.from === removedNode.id)
  assert.ok(branchesFromEdge, 'a removed worktree attaches to its repo trunk via branchesFrom')
  assert.equal(branchesFromEdge.to, `repo:${REPO_A_ROOT}`)

  const runsInEdges = graph.edges.filter((e) => e.kind === 'runsIn' && (e.from === 'job:j1' || e.from === 'job:j2'))
  assert.equal(runsInEdges.length, 2)
  assert.ok(runsInEdges.every((e) => e.to === removedNode.id), 'both jobs runsIn the shared removed-worktree node, not outside')
})

test('buildWorkGraph: a cwd unrelated to any known repo still lands in outside, even when removed-worktree matching is active', () => {
  const jobs = [job({ jobId: 'j1', cwd: '/completely/unrelated/path' })]
  const graph = buildWorkGraph({ jobs, repos: REPOS_FIXTURE, now: NOW })

  assert.equal(graph.nodes.some((n) => n.kind === 'worktree' && n.removed === true), false)
  const runsInEdge = graph.edges.find((e) => e.kind === 'runsIn' && e.from === 'job:j1')
  assert.equal(runsInEdge.to, 'outside')
})

// --- T4a: Jules / cloud lane grouping -----------------------------------------

test('buildWorkGraph: a Jules job with remote.startingBranch but no branch yet gets a pending remoteBranch node (not outside)', () => {
  const jobs = [
    job({
      jobId: 'jules-pending',
      agent: 'jules',
      cwd: null,
      remote: { provider: 'jules', sessionId: 's2', source: 'sources/github/owner/repo', startingBranch: 'main', branch: null },
    }),
  ]
  const graph = buildWorkGraph({ jobs, repos: [], now: NOW })

  const node = graph.nodes.find((n) => n.kind === 'remoteBranch' && n.pending === true)
  assert.ok(node)
  assert.equal(node.branch, null)
  assert.equal(node.startingBranch, 'main')
  assert.equal(node.source, 'sources/github/owner/repo')
  assert.equal(node.label, 'from main')

  const remoteEdge = graph.edges.find((e) => e.kind === 'remote' && e.from === 'job:jules-pending')
  assert.equal(remoteEdge.to, node.id)
})

test('buildWorkGraph: Jules jobs with no remote at all share one "unstarted" node under unknown source', () => {
  const jobs = [
    job({ jobId: 'jules-1', agent: 'jules', cwd: null }),
    job({ jobId: 'jules-2', agent: 'jules', cwd: null }),
  ]
  const graph = buildWorkGraph({ jobs, repos: [], now: NOW })

  const unstartedNodes = graph.nodes.filter((n) => n.kind === 'remoteBranch' && n.unstarted === true)
  assert.equal(unstartedNodes.length, 1, 'both unstarted jobs share the same node')
  assert.equal(unstartedNodes[0].source, null)

  const remoteEdges = graph.edges.filter((e) => e.kind === 'remote' && (e.from === 'job:jules-1' || e.from === 'job:jules-2'))
  assert.equal(remoteEdges.length, 2)
  assert.ok(remoteEdges.every((e) => e.to === unstartedNodes[0].id))
})

test('buildWorkGraph: a Jules job whose remote.source matches a known local repo and startingBranch a live worktree gets a cross-link remote edge to that lane', () => {
  const jobs = [
    job({
      jobId: 'jules-linked',
      agent: 'jules',
      cwd: null,
      remote: { provider: 'jules', sessionId: 's3', source: 'sources/github/someone/a', startingBranch: 'wt/a', branch: null },
    }),
  ]
  const graph = buildWorkGraph({ jobs, repos: REPOS_FIXTURE, now: NOW })

  const cloudNode = graph.nodes.find((n) => n.kind === 'remoteBranch' && n.pending === true)
  assert.ok(cloudNode)
  const wtA = graph.nodes.find((n) => n.kind === 'worktree' && n.branch === 'wt/a')
  assert.ok(wtA)

  const crossLink = graph.edges.find((e) => e.kind === 'remote' && e.from === cloudNode.id && e.to === wtA.id)
  assert.ok(crossLink, 'cross-link edge from the cloud node to the matching local branch lane')
})

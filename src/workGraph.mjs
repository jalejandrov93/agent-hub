import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { listJobs } from './jobstore.mjs'

/**
 * The work graph is built entirely from git state (this module) plus
 * existing job records (jobstore.mjs) — see odd/tasks/agent-work-graph.md.
 * Zero new delegation parameters or job fields are introduced; every node
 * and edge here is derived, never authored.
 */

const GIT_TIMEOUT_MS = 5000
const DEFAULT_FINISHED_WINDOW_MS = 24 * 60 * 60 * 1000
const DEFAULT_FINISHED_CAP = 50
const OUTSIDE_NODE_ID = 'outside'

/** Same execFileSync style as src/worktree.mjs's gitDirs(), plus a bounded timeout so one hung repo can never stall the whole route. */
function defaultExecGit(args, { cwd } = {}) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', timeout: GIT_TIMEOUT_MS })
}

/** Runs execGit, trimming stdout; returns null instead of throwing (a repo/branch this can't answer for is skipped, not fatal). */
function tryGit(execGit, args, cwd) {
  try {
    return execGit(args, { cwd }).trim()
  } catch {
    return null
  }
}

/** True when `candidate`'s tip is an ancestor of `branch`'s tip (git merge-base --is-ancestor, exit 0). */
function isAncestor(candidate, branch, cwd, execGit) {
  try {
    execGit(['merge-base', '--is-ancestor', candidate, branch], { cwd })
    return true
  } catch {
    return false
  }
}

/** Commits `branch` is ahead of `candidate`; Infinity when git can't answer (excludes the candidate from being "closest"). */
function commitsAhead(candidate, branch, cwd, execGit) {
  const out = tryGit(execGit, ['rev-list', '--count', `${candidate}..${branch}`], cwd)
  const n = out === null ? NaN : Number(out)
  return Number.isFinite(n) ? n : Infinity
}

/** main first, then alphabetical — the single deterministic order used both for tie-breaking and for cycle avoidance below. */
function precedesCanonical(a, b, mainBranch) {
  if (a === b) return false
  if (a === mainBranch) return true
  if (b === mainBranch) return false
  return a < b
}

/**
 * Parent-branch inference for one non-main branch, scoped to branches that
 * already have a worktree in this repo (bounded git calls — never every
 * branch). Two branches sitting on the exact same commit would each see the
 * other as "0 commits ahead" and naturally pick each other as parent,
 * creating a cycle; precedesCanonical only allows the canonically earlier
 * one (main first, then alphabetical) to be picked as a parent, which
 * breaks the cycle deterministically instead of by chance of iteration order.
 */
function inferParentBranch({ branch, otherBranches, mainBranch, cwd, execGit }) {
  const candidates = new Set(otherBranches)
  if (mainBranch) candidates.add(mainBranch)
  candidates.delete(branch)

  const ordered = [...candidates].sort((a, b) => {
    if (a === mainBranch) return -1
    if (b === mainBranch) return 1
    return a.localeCompare(b)
  })

  let best = null
  let bestAhead = Infinity
  for (const candidate of ordered) {
    if (!isAncestor(candidate, branch, cwd, execGit)) continue
    const ahead = commitsAhead(candidate, branch, cwd, execGit)
    if (ahead === 0 && !precedesCanonical(candidate, branch, mainBranch)) continue
    if (ahead < bestAhead) {
      bestAhead = ahead
      best = candidate
    }
  }

  return best ?? mainBranch ?? null
}

/** The primary worktree root for `cwd`'s repo, or null when `cwd` isn't inside a git repo (missing dir, not a repo, etc. — all tolerated). */
function repoRootFor(cwd, execGit) {
  const commonDir = tryGit(execGit, ['rev-parse', '--path-format=absolute', '--git-common-dir'], cwd)
  if (!commonDir) return null
  return path.dirname(commonDir)
}

/** Parses `git worktree list --porcelain` output into `{ path, branch, head, isMain }[]`; the first block is always the main worktree. */
function parseWorktreePorcelain(output) {
  const entries = []
  let current = null

  for (const line of (output ?? '').split('\n')) {
    if (line === '') {
      if (current) entries.push(current)
      current = null
      continue
    }
    const spaceIdx = line.indexOf(' ')
    const key = spaceIdx === -1 ? line : line.slice(0, spaceIdx)
    const value = spaceIdx === -1 ? '' : line.slice(spaceIdx + 1)
    if (key === 'worktree') {
      current = { path: value, head: null, branch: null }
    } else if (current) {
      if (key === 'HEAD') current.head = value
      else if (key === 'branch') current.branch = value.replace(/^refs\/heads\//, '')
      // 'detached', 'bare', 'locked', 'prunable' carry no branch identity — current.branch stays null.
    }
  }
  if (current) entries.push(current)

  return entries.map((e, idx) => ({ path: e.path, branch: e.branch, head: e.head, isMain: idx === 0 }))
}

/**
 * Resolves each distinct job cwd to its repo (git rev-parse --git-common-dir),
 * dedupes repos, lists each repo's worktrees once, and attaches the inferred
 * parentBranch to every non-main worktree (null for the main worktree itself,
 * and for a detached HEAD worktree with no branch identity to infer from).
 * A cwd that isn't a git repo, or whose directory is missing, is silently
 * skipped rather than thrown — the graph simply won't include it.
 */
export function readRepos(cwds, { execGit = defaultExecGit } = {}) {
  const distinctCwds = [...new Set((cwds ?? []).filter(Boolean))]
  const rootsSeen = new Set()
  const repos = []

  for (const cwd of distinctCwds) {
    const root = repoRootFor(cwd, execGit)
    if (!root || rootsSeen.has(root)) continue
    rootsSeen.add(root)

    const listing = tryGit(execGit, ['worktree', 'list', '--porcelain'], root)
    if (listing === null) continue
    const rawWorktrees = parseWorktreePorcelain(listing)
    const mainEntry = rawWorktrees.find((w) => w.isMain) ?? null
    const mainBranch = mainEntry?.branch ?? null

    const worktrees = rawWorktrees.map((wt) => {
      if (wt.isMain || !wt.branch) {
        return { ...wt, parentBranch: null }
      }
      const otherBranches = rawWorktrees.filter((w) => w.branch && w.branch !== wt.branch).map((w) => w.branch)
      const parentBranch = inferParentBranch({ branch: wt.branch, otherBranches, mainBranch, cwd: root, execGit })
      return { ...wt, parentBranch }
    })

    repos.push({ root, mainBranch, worktrees })
  }

  repos.sort((a, b) => a.root.localeCompare(b.root))
  return repos
}

const repoNodeId = (root) => `repo:${root}`
const wtNodeId = (wtPath) => `wt:${wtPath}`
const jobNodeId = (jobId) => `job:${jobId}`
const remoteNodeId = (source, branch) => `remote:${source ?? ''}#${branch}`

/** Duration so far (or total, once terminal) in whole seconds; null when either timestamp is unparseable. */
function jobDurationS(job) {
  const start = Date.parse(job.createdAt)
  const end = Date.parse(job.updatedAt)
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null
  return Math.round((end - start) / 1000)
}

function jobPayload(job) {
  return {
    jobId: job.jobId,
    agent: job.agent,
    model: job.model,
    title: job.title ?? null,
    status: job.status,
    mode: job.mode,
    taskType: job.taskType ?? null,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    durationS: jobDurationS(job),
    prUrl: job.remote?.prUrl ?? null,
  }
}

/**
 * All active (queued/running) jobs, plus finished jobs updated within
 * `limits.finishedWindowMs` (default 24h), capped to the `limits.finishedCap`
 * (default 50) most recently updated — so the graph stays readable even with
 * a long job history. Active jobs are never capped or windowed.
 */
function scopeJobs(jobs, nowMs, limits) {
  const windowMs = limits.finishedWindowMs ?? DEFAULT_FINISHED_WINDOW_MS
  const cap = limits.finishedCap ?? DEFAULT_FINISHED_CAP

  const active = []
  const finished = []
  for (const job of jobs) {
    if (job.status === 'queued' || job.status === 'running') {
      active.push(job)
      continue
    }
    const updatedMs = Date.parse(job.updatedAt)
    if (Number.isFinite(updatedMs) && nowMs - updatedMs <= windowMs) finished.push(job)
  }
  finished.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || '') || (a.jobId || '').localeCompare(b.jobId || ''))
  return [...active, ...finished.slice(0, cap)]
}

/** True when `cwd` is exactly `wtPath` or a strict path-segment descendant of it — a plain string prefix (no path.sep boundary) never matches. */
function isWithin(cwd, wtPath) {
  return cwd === wtPath || cwd.startsWith(wtPath + path.sep)
}

/** The worktree with the longest (most specific) matching path for `cwd`, or null when none contains it. */
function findContainingWorktree(cwd, worktreeIndex) {
  if (!cwd) return null
  const resolvedCwd = path.resolve(cwd)
  let best = null
  for (const wt of worktreeIndex) {
    const wtPath = path.resolve(wt.path)
    if (isWithin(resolvedCwd, wtPath) && (!best || wtPath.length > best.path.length)) {
      best = { ...wt, path: wtPath }
    }
  }
  return best
}

/** The sibling "-worktrees" directory a repo's non-main worktrees conventionally live under (e.g. `/x/repo` -> `/x/repo-worktrees`). */
function worktreesAreaFor(repoRoot) {
  return path.join(path.dirname(repoRoot), `${path.basename(repoRoot)}-worktrees`)
}

/**
 * The repo a job's cwd used to belong to, when that cwd no longer matches any
 * LIVE worktree (it was removed after merge) but its path still says which
 * repo it came from: under `<repoRoot>-worktrees/`, or under `repoRoot`
 * itself (a bare-repo edge case `findContainingWorktree` wouldn't already
 * catch). The most specific (longest root) match wins when repos nest.
 */
function findRepoForRemovedCwd(cwd, repos) {
  const resolvedCwd = path.resolve(cwd)
  let best = null
  for (const repo of repos) {
    const root = path.resolve(repo.root)
    const area = path.resolve(worktreesAreaFor(root))
    if ((isWithin(resolvedCwd, area) || isWithin(resolvedCwd, root)) && (!best || root.length > best.root.length)) {
      best = repo
    }
  }
  return best
}

/** True when a job belongs on the Cloud/Jules lane group rather than being resolved against local git state. */
function isJulesJob(j) {
  return j.agent === 'jules' || (j.cwd == null && Boolean(j.remote))
}

/** The repo-name segment of a Jules `remote.source` like "sources/github/owner/repo" -> "repo". */
function repoNameFromSource(source) {
  if (!source) return null
  const parts = source.split('/').filter(Boolean)
  return parts[parts.length - 1] ?? null
}

/**
 * Pure: builds the graph's nodes and edges from already-resolved `repos`
 * (readRepos' output, including precomputed parentBranch) and `jobs` (raw
 * listJobs() records). No git calls and no filesystem access happen here.
 *
 * @param {{ jobs?: object[], repos?: object[], now?: number|Date, limits?: { finishedWindowMs?: number, finishedCap?: number } }} args
 */
export function buildWorkGraph({ jobs = [], repos = [], now = Date.now(), limits = {} } = {}) {
  const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime()
  const generatedAt = new Date(Number.isFinite(nowMs) ? nowMs : Date.now()).toISOString()

  const nodes = []
  const edges = []

  // --- repo + worktree nodes, and branchesFrom edges -----------------------
  const sortedRepos = [...repos].sort((a, b) => a.root.localeCompare(b.root))
  const worktreeIndex = [] // flattened across every repo, used by runsIn below

  for (const repo of sortedRepos) {
    nodes.push({ id: repoNodeId(repo.root), kind: 'repo', root: repo.root, mainBranch: repo.mainBranch ?? null })

    const worktrees = [...repo.worktrees].sort((a, b) => a.path.localeCompare(b.path))
    const branchToNodeId = new Map()
    for (const wt of repo.worktrees) {
      if (wt.branch) branchToNodeId.set(wt.branch, wtNodeId(wt.path))
    }

    for (const wt of worktrees) {
      const id = wtNodeId(wt.path)
      nodes.push({ id, kind: 'worktree', repoRoot: repo.root, path: wt.path, branch: wt.branch ?? null, head: wt.head ?? null, isMain: Boolean(wt.isMain) })
      worktreeIndex.push({ nodeId: id, path: wt.path })

      if (wt.isMain) continue // the trunk itself has no parent

      const targetId = (wt.parentBranch && branchToNodeId.get(wt.parentBranch)) ?? repoNodeId(repo.root)
      edges.push({ kind: 'branchesFrom', from: id, to: targetId })
    }
  }

  // --- job nodes + runsIn edges ---------------------------------------------
  const scopedJobs = scopeJobs(jobs, Number.isFinite(nowMs) ? nowMs : Date.now(), limits)
  const scopedJobIds = new Set(scopedJobs.map((j) => j.jobId))
  const jobRunsInNodeId = new Map() // jobId -> resolved worktree/removed-worktree nodeId (never 'outside') — used by waitsOn
  const removedWorktreeNodeIds = new Map() // cwd -> node id, so jobs sharing a removed cwd share one lane
  let outsideUsed = false

  for (const job of scopedJobs) {
    nodes.push({ id: jobNodeId(job.jobId), kind: 'job', ...jobPayload(job) })
    const wt = findContainingWorktree(job.cwd, worktreeIndex)
    if (wt) {
      edges.push({ kind: 'runsIn', from: jobNodeId(job.jobId), to: wt.nodeId })
      jobRunsInNodeId.set(job.jobId, wt.nodeId)
      continue
    }

    const removedRepo = job.cwd ? findRepoForRemovedCwd(job.cwd, sortedRepos) : null
    if (removedRepo) {
      let removedId = removedWorktreeNodeIds.get(job.cwd)
      if (!removedId) {
        removedId = wtNodeId(job.cwd)
        removedWorktreeNodeIds.set(job.cwd, removedId)
        nodes.push({
          id: removedId,
          kind: 'worktree',
          repoRoot: removedRepo.root,
          path: job.cwd,
          branch: null,
          head: null,
          isMain: false,
          removed: true,
          label: path.basename(job.cwd),
        })
        edges.push({ kind: 'branchesFrom', from: removedId, to: repoNodeId(removedRepo.root) })
      }
      edges.push({ kind: 'runsIn', from: jobNodeId(job.jobId), to: removedId })
      jobRunsInNodeId.set(job.jobId, removedId)
      continue
    }

    outsideUsed = true
    edges.push({ kind: 'runsIn', from: jobNodeId(job.jobId), to: OUTSIDE_NODE_ID })
  }
  if (outsideUsed) nodes.push({ id: OUTSIDE_NODE_ID, kind: 'outside' })

  // --- remote nodes + edges (Jules / Cloud) ----------------------------------
  // Every Jules-condition job gets exactly one 'remote' edge to a cloud node,
  // grouped by remote.source (null -> shared "unknown source" group): a real
  // branch once known, else a 'pending' placeholder on its startingBranch, else
  // (no remote info at all, e.g. a session that failed before it started) a
  // shared 'unstarted' node. This keeps Jules jobs off the 'outside' lane —
  // the view places a job by its 'remote' edge over 'runsIn' when both exist.
  const remoteNodesSeen = new Set()
  const crossLinksSeen = new Set()
  for (const job of scopedJobs) {
    if (!isJulesJob(job)) continue
    const remote = job.remote ?? null
    const source = remote?.source ?? null

    let id
    let nodeShape
    if (remote?.branch) {
      id = remoteNodeId(source, remote.branch)
      nodeShape = {
        id,
        kind: 'remoteBranch',
        source,
        branch: remote.branch,
        startingBranch: remote.startingBranch ?? null,
        prUrl: remote.prUrl ?? null,
        pending: false,
      }
    } else if (remote?.startingBranch) {
      id = `remote:${source ?? ''}#pending:${remote.startingBranch}`
      nodeShape = {
        id,
        kind: 'remoteBranch',
        source,
        branch: null,
        startingBranch: remote.startingBranch,
        prUrl: null,
        pending: true,
        label: `from ${remote.startingBranch}`,
      }
    } else {
      id = `remote:${source ?? ''}#unstarted`
      nodeShape = {
        id,
        kind: 'remoteBranch',
        source,
        branch: null,
        startingBranch: null,
        prUrl: null,
        pending: true,
        unstarted: true,
        label: 'Unstarted',
      }
    }

    if (!remoteNodesSeen.has(id)) {
      remoteNodesSeen.add(id)
      nodes.push(nodeShape)
    }
    edges.push({ kind: 'remote', from: jobNodeId(job.jobId), to: id })

    // Cross-link: when remote.source names a repo we also have a local checkout
    // of, and its startingBranch has a live worktree, draw a second (lane ->
    // lane) 'remote' edge from the cloud node to that local branch lane.
    if (source && remote?.startingBranch) {
      const repoName = repoNameFromSource(source)
      const matchingRepo = repoName ? sortedRepos.find((r) => path.basename(r.root) === repoName) : null
      const matchingWt = matchingRepo?.worktrees.find((w) => w.branch === remote.startingBranch)
      if (matchingWt) {
        const linkTo = wtNodeId(matchingWt.path)
        const linkKey = `${id}->${linkTo}`
        if (!crossLinksSeen.has(linkKey)) {
          crossLinksSeen.add(linkKey)
          edges.push({ kind: 'remote', from: id, to: linkTo })
        }
      }
    }
  }

  // --- continues (reply chain) ----------------------------------------------
  for (const job of scopedJobs) {
    if (job.parentJobId && scopedJobIds.has(job.parentJobId)) {
      edges.push({ kind: 'continues', from: jobNodeId(job.jobId), to: jobNodeId(job.parentJobId) })
    }
  }

  // --- waitsOn (queued write -> running write, same worktree) --------------
  const runningWriteByWorktree = new Map()
  for (const job of scopedJobs) {
    if (job.status !== 'running' || job.mode !== 'write') continue
    const wtId = jobRunsInNodeId.get(job.jobId)
    if (!wtId) continue // 'outside' isn't a real worktree — never pairs jobs there
    if (!runningWriteByWorktree.has(wtId)) runningWriteByWorktree.set(wtId, [])
    runningWriteByWorktree.get(wtId).push(job)
  }
  for (const job of scopedJobs) {
    if (job.status !== 'queued' || job.mode !== 'write') continue
    const wtId = jobRunsInNodeId.get(job.jobId)
    if (!wtId) continue
    for (const runningJob of runningWriteByWorktree.get(wtId) ?? []) {
      edges.push({ kind: 'waitsOn', from: jobNodeId(job.jobId), to: jobNodeId(runningJob.jobId) })
    }
  }

  return { generatedAt, repos: sortedRepos, nodes, edges }
}

/** Convenience wiring for GET /api/work-graph: reads jobs + derives repos from their cwds, then builds the pure graph. */
export function getWorkGraph({ env = process.env, listJobsFn = listJobs, execGit = defaultExecGit, now = Date.now() } = {}) {
  const jobs = listJobsFn(env)
  const cwds = jobs.map((j) => j.cwd).filter(Boolean)
  const repos = readRepos(cwds, { execGit })
  return buildWorkGraph({ jobs, repos, now })
}

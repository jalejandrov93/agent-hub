/**
 * Pure, deterministic "git-graph lanes" layout for the work graph view
 * (GET /api/work-graph -> src/workGraph.mjs). No DOM, no React, no Date.now:
 * every call with the same graph + options returns byte-identical output, so
 * this is exhaustively unit-testable and safe to memoize in the view.
 *
 * Shape: one lane per repo trunk / worktree / Jules remoteBranch / the
 * synthetic 'outside' node, stacked vertically in depth-first order over the
 * `branchesFrom` tree (so a child worktree's lane sits directly under its
 * parent's, indented by depth). Job leaves are cards laid out left-to-right
 * along their lane, ordered by createdAt. A lane with more finished jobs than
 * `visibleFinishedPerLane` collapses to "active + last N finished" plus a
 * counted marker, unless the caller has expanded it.
 */
import type {
  WorkGraphResponseT,
  WorkGraphAnyNode,
  WorkGraphRepoNode,
  WorkGraphJobNode,
  WorkGraphRemoteBranchNode,
  WorkGraphEdgeT,
} from "@/lib/types"

export const ROW_HEIGHT = 64
export const LANE_INDENT = 28
export const LEFT_PADDING = 24
export const TOP_PADDING = 24
export const LANE_LABEL_WIDTH = 168
export const JOB_CARD_WIDTH = 176
export const JOB_CARD_GAP = 16
export const COLLAPSED_MARKER_WIDTH = 72
export const REMOVED_GROUP_MARKER_WIDTH = 140
export const DEFAULT_VISIBLE_FINISHED_PER_LANE = 4
export const MAX_STAGGER_STEP = 24
export const CANVAS_PADDING = 32

const ACTIVE_STATUSES = new Set(["queued", "running"])

export type LayoutOptions = {
  /** Finished jobs kept visible per lane before collapsing into a "+K finished" marker. */
  visibleFinishedPerLane?: number
  /** Lanes the user has manually expanded — show every job, no collapse marker. */
  expandedLaneIds?: ReadonlySet<string>
  /** When true, only queued/running jobs are shown at all (no collapse marker needed). */
  activeOnly?: boolean
}

export type LaneKind = "repo" | "worktree" | "outside" | "remoteBranch"

export type LaidOutLane = {
  id: string
  kind: LaneKind
  label: string
  sublabel: string | null
  depth: number
  x: number
  y: number
  parentLaneId: string | null
  node: WorkGraphAnyNode
  step: number
}

export type LaidOutJob = {
  id: string
  laneId: string
  x: number
  y: number
  index: number
  node: WorkGraphJobNode
  step: number
  isRunning: boolean
}

export type CollapsedGroup = {
  id: string
  laneId: string
  hiddenCount: number
  x: number
  y: number
}

export type LaidOutEdge = {
  id: string
  kind: WorkGraphEdgeT["kind"]
  from: string
  to: string
  path: string
  /** jobIds (raw job.jobId, not the node id) whose trunk->job flow chain includes this edge. */
  feedsRunningJobIds: string[]
}

export type WorkGraphSection = {
  id: string
  label: string
  laneIds: string[]
}

/** A repo's removed (history-only) worktrees, collapsed into one row unless expanded via expandedLaneIds. */
export type RemovedGroup = {
  id: string
  repoLaneId: string
  hiddenCount: number
  x: number
  y: number
}

/** A standalone label row above a group of lanes that isn't itself a lane (currently just "Cloud · Jules"). */
export type GroupHeader = {
  id: string
  label: string
  x: number
  y: number
}

export type WorkGraphLayout = {
  lanes: LaidOutLane[]
  jobs: LaidOutJob[]
  edges: LaidOutEdge[]
  collapsed: CollapsedGroup[]
  removedGroups: RemovedGroup[]
  groupHeaders: GroupHeader[]
  sections: WorkGraphSection[]
  width: number
  height: number
  /** Per running job (keyed by jobId): the ordered chain of edge ids from its lane up to the trunk. */
  flowPathByJobId: Record<string, string[]>
  /** Per job, running or not (keyed by jobId): the same chain, used for hover highlighting. */
  pathToTrunkByJobId: Record<string, string[]>
}

export type WorkGraphSummary = {
  running: number
  queued: number
  failed: number
  succeeded: number
  canceled: number
  total: number
}

const EMPTY_SUMMARY: WorkGraphSummary = {
  running: 0,
  queued: 0,
  failed: 0,
  succeeded: 0,
  canceled: 0,
  total: 0,
}

/** Job status counts across the whole graph (not scoped by activeOnly/collapse) — for a live summary strip. */
export function summarizeJobs(graph: WorkGraphResponseT | null | undefined): WorkGraphSummary {
  const summary: WorkGraphSummary = { ...EMPTY_SUMMARY }
  if (!graph) return summary
  for (const node of graph.nodes as unknown as WorkGraphAnyNode[]) {
    if (node.kind !== "job") continue
    summary.total += 1
    if (node.status === "running") summary.running += 1
    else if (node.status === "queued") summary.queued += 1
    else if (node.status === "failed") summary.failed += 1
    else if (node.status === "succeeded") summary.succeeded += 1
    else if (node.status === "canceled") summary.canceled += 1
  }
  return summary
}

const EMPTY_LAYOUT: WorkGraphLayout = {
  lanes: [],
  jobs: [],
  edges: [],
  collapsed: [],
  removedGroups: [],
  groupHeaders: [],
  sections: [],
  width: CANVAS_PADDING * 2,
  height: CANVAS_PADDING * 2,
  flowPathByJobId: {},
  pathToTrunkByJobId: {},
}

function lastPathSegment(value: string): string {
  const parts = value.split("/").filter(Boolean)
  return parts[parts.length - 1] ?? value
}

function laneLabel(node: WorkGraphAnyNode): string {
  switch (node.kind) {
    case "repo":
      return lastPathSegment(node.root)
    case "worktree":
      if (node.removed) return node.label ?? lastPathSegment(node.path)
      if (node.branch) return node.branch
      return node.head ? `detached @ ${node.head.slice(0, 7)}` : "detached"
    case "remoteBranch":
      if (node.branch) return node.branch
      return node.label ?? (node.startingBranch ? `from ${node.startingBranch}` : "Jules")
    case "outside":
      return "Outside git"
    default:
      return (node as { id: string }).id
  }
}

function laneSublabel(node: WorkGraphAnyNode): string | null {
  switch (node.kind) {
    case "repo":
      return node.mainBranch ? `trunk · ${node.mainBranch}` : "trunk"
    case "worktree":
      if (node.removed) return "removed"
      return lastPathSegment(node.path)
    case "remoteBranch":
      return node.source ? `Jules · ${node.source}` : "Jules · unknown source"
    default:
      return null
  }
}

function laneConnectorPath(parentX: number, parentY: number, childX: number, childY: number): string {
  const midY = (parentY + childY) / 2
  return `M ${parentX} ${parentY} C ${parentX} ${midY}, ${childX} ${midY}, ${childX} ${childY}`
}

function laneToJobPath(laneX: number, laneY: number, jobX: number, jobY: number): string {
  const midX = laneX + (jobX - laneX) / 2
  return `M ${laneX} ${laneY} C ${midX} ${laneY}, ${midX} ${jobY}, ${jobX} ${jobY}`
}

function jobToJobPath(fromX: number, fromY: number, toX: number, toY: number): string {
  const arch = -22
  const midY1 = fromY + arch
  const midY2 = toY + arch
  return `M ${fromX} ${fromY} C ${fromX} ${midY1}, ${toX} ${midY2}, ${toX} ${toY}`
}

/** Narrows one selected repo's trunk/worktree lanes and their jobs, while always keeping 'outside' and remoteBranch (Cloud) nodes and their jobs — those are cross-cutting, not scoped to a single local repo. */
export function selectRepoGraph(graph: WorkGraphResponseT, repoRoot: string | "all"): WorkGraphResponseT {
  if (repoRoot === "all") return graph

  const allNodes = graph.nodes as unknown as WorkGraphAnyNode[]
  const repoNode = allNodes.find((n): n is WorkGraphRepoNode => n.kind === "repo" && n.root === repoRoot)
  if (!repoNode) return graph

  const keptNodeIds = new Set<string>([repoNode.id])
  for (const n of allNodes) {
    if (n.kind === "worktree" && n.repoRoot === repoRoot) keptNodeIds.add(n.id)
    if (n.kind === "outside" || n.kind === "remoteBranch") keptNodeIds.add(n.id)
  }
  for (const e of graph.edges) {
    if (e.kind === "runsIn" && keptNodeIds.has(e.to)) keptNodeIds.add(e.from)
    if (e.kind === "remote") keptNodeIds.add(e.from)
  }

  return {
    ...graph,
    repos: graph.repos.filter((r) => r.root === repoRoot),
    nodes: graph.nodes.filter((n) => keptNodeIds.has(n.id)),
    edges: graph.edges.filter((e) => keptNodeIds.has(e.from) && keptNodeIds.has(e.to)),
  }
}

export function layoutWorkGraph(
  graph: WorkGraphResponseT | null | undefined,
  options: LayoutOptions = {}
): WorkGraphLayout {
  if (!graph || graph.nodes.length === 0) return EMPTY_LAYOUT

  const visibleFinishedPerLane = options.visibleFinishedPerLane ?? DEFAULT_VISIBLE_FINISHED_PER_LANE
  const expandedLaneIds = options.expandedLaneIds ?? new Set<string>()
  const activeOnly = options.activeOnly ?? false

  const allNodes = graph.nodes as unknown as WorkGraphAnyNode[]
  const allEdges = graph.edges as unknown as WorkGraphEdgeT[]
  const nodesById = new Map(allNodes.map((n) => [n.id, n]))

  // A removed worktree (a job cwd that no longer matches any live worktree) is
  // always a direct, history-only child of its repo — grouped/collapsed below,
  // never walked into the normal depth-first branchesFrom tree.
  const removedNodeIds = new Set<string>()
  for (const n of allNodes) {
    if (n.kind === "worktree" && n.removed) removedNodeIds.add(n.id)
  }

  // --- branchesFrom tree: child worktree id -> ordered sibling list per parent lane id ---
  const childrenByParent = new Map<string, string[]>()
  for (const e of allEdges) {
    if (e.kind !== "branchesFrom") continue
    if (removedNodeIds.has(e.from)) continue
    if (!childrenByParent.has(e.to)) childrenByParent.set(e.to, [])
    childrenByParent.get(e.to)!.push(e.from)
  }

  // The main worktree never gets a branchesFrom edge ("the trunk itself has
  // no parent" — see workGraph.mjs), so it would otherwise be unreachable
  // from the repo lane. It IS the trunk every other worktree branches from,
  // so splice it in as an implicit depth-1 child of its repo.
  for (const node of allNodes) {
    if (node.kind !== "worktree" || !node.isMain) continue
    const repoLaneId = `repo:${node.repoRoot}`
    if (!nodesById.has(repoLaneId)) continue
    const kids = childrenByParent.get(repoLaneId) ?? []
    if (!kids.includes(node.id)) childrenByParent.set(repoLaneId, [node.id, ...kids])
  }

  function laneSortKey(id: string): string {
    const node = nodesById.get(id)
    if (node?.kind === "worktree") return node.branch ?? node.path
    return id
  }
  function isMainWorktree(id: string): boolean {
    const node = nodesById.get(id)
    return node?.kind === "worktree" && node.isMain
  }
  for (const kids of childrenByParent.values()) {
    kids.sort((a, b) => {
      if (isMainWorktree(a) && !isMainWorktree(b)) return -1
      if (isMainWorktree(b) && !isMainWorktree(a)) return 1
      return laneSortKey(a).localeCompare(laneSortKey(b)) || a.localeCompare(b)
    })
  }

  // --- lane assignment: depth-first per repo, then 'outside', then Cloud (remoteBranch) group ---
  let laneRow = 0
  let stepCounter = 0
  const nextStep = () => Math.min(stepCounter++, MAX_STAGGER_STEP)

  const lanes: LaidOutLane[] = []
  const laneById = new Map<string, LaidOutLane>()
  const sections: WorkGraphSection[] = []
  const removedGroups: RemovedGroup[] = []
  const groupHeaders: GroupHeader[] = []

  function pushLane(node: WorkGraphAnyNode, depth: number, parentLaneId: string | null): LaidOutLane {
    const lane: LaidOutLane = {
      id: node.id,
      kind: node.kind as LaneKind,
      label: laneLabel(node),
      sublabel: laneSublabel(node),
      depth,
      x: LEFT_PADDING + depth * LANE_INDENT,
      y: TOP_PADDING + laneRow * ROW_HEIGHT,
      parentLaneId,
      node,
      step: nextStep(),
    }
    lanes.push(lane)
    laneById.set(lane.id, lane)
    laneRow += 1
    return lane
  }

  function visit(id: string, depth: number, parentLaneId: string | null) {
    const node = nodesById.get(id)
    if (!node) return
    pushLane(node, depth, parentLaneId)
    for (const childId of childrenByParent.get(id) ?? []) visit(childId, depth + 1, id)
  }

  // Removed worktrees, grouped by repo: those with no active (queued/running)
  // job stay collapsed into one "N removed worktrees" row (they're history);
  // one with an active job still needs to be seen, so it gets its own lane.
  const removedNodesByRepo = new Map<string, WorkGraphAnyNode[]>()
  for (const n of allNodes) {
    if (n.kind !== "worktree" || !n.removed) continue
    const repoLaneId = `repo:${n.repoRoot}`
    if (!removedNodesByRepo.has(repoLaneId)) removedNodesByRepo.set(repoLaneId, [])
    removedNodesByRepo.get(repoLaneId)!.push(n)
  }
  const activeJobIds = new Set(
    allNodes.filter((n): n is WorkGraphJobNode => n.kind === "job" && ACTIVE_STATUSES.has(n.status)).map((n) => n.id)
  )
  const activeRemovedNodeIds = new Set<string>()
  for (const e of allEdges) {
    if (e.kind === "runsIn" && removedNodeIds.has(e.to) && activeJobIds.has(e.from)) activeRemovedNodeIds.add(e.to)
  }

  const repoNodes = allNodes
    .filter((n): n is WorkGraphRepoNode => n.kind === "repo")
    .sort((a, b) => a.root.localeCompare(b.root))
  for (const repo of repoNodes) {
    const start = lanes.length
    visit(repo.id, 0, null)

    const removedNodes = (removedNodesByRepo.get(repo.id) ?? [])
      .slice()
      .sort((a, b) => laneLabel(a).localeCompare(laneLabel(b)) || a.id.localeCompare(b.id))
    const activeRemoved = removedNodes.filter((n) => activeRemovedNodeIds.has(n.id))
    const inactiveRemoved = removedNodes.filter((n) => !activeRemovedNodeIds.has(n.id))

    for (const n of activeRemoved) pushLane(n, 1, repo.id)

    if (inactiveRemoved.length > 0) {
      const groupId = `${repo.id}::removed`
      if (expandedLaneIds.has(groupId)) {
        for (const n of inactiveRemoved) pushLane(n, 1, repo.id)
      } else {
        removedGroups.push({
          id: groupId,
          repoLaneId: repo.id,
          hiddenCount: inactiveRemoved.length,
          x: LEFT_PADDING + LANE_INDENT,
          y: TOP_PADDING + laneRow * ROW_HEIGHT,
        })
        laneRow += 1
      }
    }

    sections.push({ id: repo.id, label: lastPathSegment(repo.root), laneIds: lanes.slice(start).map((l) => l.id) })
  }

  const outsideNode = allNodes.find((n) => n.kind === "outside")
  if (outsideNode) {
    const lane = pushLane(outsideNode, 0, null)
    sections.push({ id: "outside", label: "Outside git", laneIds: [lane.id] })
  }

  const remoteBranchNodes = allNodes
    .filter((n): n is WorkGraphRemoteBranchNode => n.kind === "remoteBranch")
    .sort((a, b) => (a.source ?? "").localeCompare(b.source ?? "") || (a.branch ?? "").localeCompare(b.branch ?? ""))
  if (remoteBranchNodes.length > 0) {
    groupHeaders.push({ id: "cloud", label: "Cloud · Jules", x: LEFT_PADDING, y: TOP_PADDING + laneRow * ROW_HEIGHT })
    laneRow += 1
    const start = lanes.length
    for (const node of remoteBranchNodes) pushLane(node, 0, null)
    sections.push({ id: "cloud", label: "Cloud · Jules", laneIds: lanes.slice(start).map((l) => l.id) })
  }

  // --- job placement: prefer the 'remote' edge target (Cloud lane) over 'runsIn' (which points at 'outside' for a Jules job) ---
  const remoteLaneByJob = new Map<string, string>()
  const runsInLaneByJob = new Map<string, string>()
  for (const e of allEdges) {
    if (e.kind === "remote") remoteLaneByJob.set(e.from, e.to)
    if (e.kind === "runsIn") runsInLaneByJob.set(e.from, e.to)
  }

  const jobsByLane = new Map<string, WorkGraphJobNode[]>()
  for (const node of allNodes) {
    if (node.kind !== "job") continue
    const laneId = remoteLaneByJob.get(node.id) ?? runsInLaneByJob.get(node.id)
    if (!laneId || !laneById.has(laneId)) continue
    if (!jobsByLane.has(laneId)) jobsByLane.set(laneId, [])
    jobsByLane.get(laneId)!.push(node)
  }
  for (const jobs of jobsByLane.values()) {
    jobs.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
  }

  // --- visible jobs + collapse per lane ---
  const jobs: LaidOutJob[] = []
  const jobById = new Map<string, LaidOutJob>()
  const connectingEdgeIdByJobId = new Map<string, string>()
  const collapsed: CollapsedGroup[] = []

  for (const lane of lanes) {
    const laneJobs = jobsByLane.get(lane.id) ?? []
    const active = laneJobs.filter((j) => ACTIVE_STATUSES.has(j.status))
    const finished = laneJobs.filter((j) => !ACTIVE_STATUSES.has(j.status))

    let visibleJobs: WorkGraphJobNode[]
    let hiddenCount = 0

    if (activeOnly) {
      visibleJobs = active
    } else if (finished.length > visibleFinishedPerLane && !expandedLaneIds.has(lane.id)) {
      const keptFinished = new Set(finished.slice(finished.length - visibleFinishedPerLane))
      hiddenCount = finished.length - keptFinished.size
      const activeSet = new Set(active)
      visibleJobs = laneJobs.filter((j) => activeSet.has(j) || keptFinished.has(j))
    } else {
      visibleJobs = laneJobs
    }

    visibleJobs.forEach((node, index) => {
      const laidOut: LaidOutJob = {
        id: node.id,
        laneId: lane.id,
        x: lane.x + LANE_LABEL_WIDTH + index * (JOB_CARD_WIDTH + JOB_CARD_GAP),
        y: lane.y,
        index,
        node,
        step: nextStep(),
        isRunning: node.status === "running",
      }
      jobs.push(laidOut)
      jobById.set(node.id, laidOut)
    })

    if (hiddenCount > 0) {
      collapsed.push({
        id: `${lane.id}::collapsed`,
        laneId: lane.id,
        hiddenCount,
        x: lane.x + LANE_LABEL_WIDTH + visibleJobs.length * (JOB_CARD_WIDTH + JOB_CARD_GAP),
        y: lane.y,
      })
    }
  }

  // --- edges: lane->lane (branchesFrom), lane->job (runsIn / remote), job->job (continues / waitsOn) ---
  const edges: LaidOutEdge[] = []
  const edgesById = new Map<string, LaidOutEdge>()

  for (const e of allEdges) {
    if (e.kind !== "branchesFrom") continue
    const child = laneById.get(e.from)
    const parent = laneById.get(e.to)
    if (!child || !parent) continue
    const edge: LaidOutEdge = {
      id: `branchesFrom:${e.from}->${e.to}`,
      kind: "branchesFrom",
      from: e.from,
      to: e.to,
      path: laneConnectorPath(parent.x, parent.y, child.x, child.y),
      feedsRunningJobIds: [],
    }
    edges.push(edge)
    edgesById.set(edge.id, edge)
  }

  for (const e of allEdges) {
    if (e.kind === "runsIn") {
      if (remoteLaneByJob.has(e.from)) continue // superseded by the 'remote' edge below (job lives on its Cloud lane instead)
      const job = jobById.get(e.from)
      const lane = laneById.get(e.to)
      if (!job || !lane) continue
      const edge: LaidOutEdge = {
        id: `runsIn:${e.from}->${e.to}`,
        kind: "runsIn",
        from: e.from,
        to: e.to,
        path: laneToJobPath(lane.x, lane.y, job.x, job.y),
        feedsRunningJobIds: [],
      }
      edges.push(edge)
      edgesById.set(edge.id, edge)
      connectingEdgeIdByJobId.set(job.id, edge.id)
    } else if (e.kind === "remote") {
      const job = jobById.get(e.from)
      if (job) {
        const lane = laneById.get(e.to)
        if (!lane) continue
        const edge: LaidOutEdge = {
          id: `remote:${e.from}->${e.to}`,
          kind: "remote",
          from: e.from,
          to: e.to,
          path: laneToJobPath(lane.x, lane.y, job.x, job.y),
          feedsRunningJobIds: [],
        }
        edges.push(edge)
        edgesById.set(edge.id, edge)
        connectingEdgeIdByJobId.set(job.id, edge.id)
      } else {
        // Cross-link: a Cloud node's 'remote' edge to the local branch lane it
        // started from (both ends are lanes, not a job) — see workGraph.mjs.
        const fromLane = laneById.get(e.from)
        const toLane = laneById.get(e.to)
        if (!fromLane || !toLane) continue
        const edge: LaidOutEdge = {
          id: `remote:${e.from}->${e.to}`,
          kind: "remote",
          from: e.from,
          to: e.to,
          path: laneConnectorPath(toLane.x, toLane.y, fromLane.x, fromLane.y),
          feedsRunningJobIds: [],
        }
        edges.push(edge)
        edgesById.set(edge.id, edge)
      }
    } else if (e.kind === "continues" || e.kind === "waitsOn") {
      const from = jobById.get(e.from)
      const to = jobById.get(e.to)
      if (!from || !to) continue
      const edge: LaidOutEdge = {
        id: `${e.kind}:${e.from}->${e.to}`,
        kind: e.kind,
        from: e.from,
        to: e.to,
        path: jobToJobPath(from.x, from.y, to.x, to.y),
        feedsRunningJobIds: [],
      }
      edges.push(edge)
      edgesById.set(edge.id, edge)
    }
  }

  // --- trunk->lane->job chain, for every job (hover) and, filtered to running jobs, for the flow animation ---
  function chainToTrunk(job: LaidOutJob): string[] {
    const chain: string[] = []
    const connecting = connectingEdgeIdByJobId.get(job.id)
    if (connecting) chain.push(connecting)
    let lane: LaidOutLane | null = laneById.get(job.laneId) ?? null
    while (lane && lane.parentLaneId) {
      const edgeId = `branchesFrom:${lane.id}->${lane.parentLaneId}`
      if (edgesById.has(edgeId)) chain.push(edgeId)
      lane = laneById.get(lane.parentLaneId) ?? null
    }
    return chain
  }

  const flowPathByJobId: Record<string, string[]> = {}
  const pathToTrunkByJobId: Record<string, string[]> = {}
  for (const job of jobs) {
    const chain = chainToTrunk(job)
    pathToTrunkByJobId[job.node.jobId] = chain
    if (!job.isRunning) continue
    flowPathByJobId[job.node.jobId] = chain
    for (const edgeId of chain) {
      edgesById.get(edgeId)?.feedsRunningJobIds.push(job.node.jobId)
    }
  }

  // --- canvas size ---
  const maxLaneRight = lanes.reduce((m, l) => Math.max(m, l.x + LANE_LABEL_WIDTH), 0)
  const maxJobRight = jobs.reduce((m, j) => Math.max(m, j.x + JOB_CARD_WIDTH), 0)
  const maxCollapsedRight = collapsed.reduce((m, c) => Math.max(m, c.x + COLLAPSED_MARKER_WIDTH), 0)
  const maxRemovedGroupRight = removedGroups.reduce((m, g) => Math.max(m, g.x + REMOVED_GROUP_MARKER_WIDTH), 0)
  const width = Math.max(maxLaneRight, maxJobRight, maxCollapsedRight, maxRemovedGroupRight) + CANVAS_PADDING
  const height = TOP_PADDING + laneRow * ROW_HEIGHT + CANVAS_PADDING

  return {
    lanes,
    jobs,
    edges,
    collapsed,
    removedGroups,
    groupHeaders,
    sections,
    width,
    height,
    flowPathByJobId,
    pathToTrunkByJobId,
  }
}

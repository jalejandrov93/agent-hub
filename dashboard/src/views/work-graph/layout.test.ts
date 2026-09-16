import { describe, expect, it } from "vitest"
import { layoutWorkGraph, selectRepoGraph, summarizeJobs, DEFAULT_VISIBLE_FINISHED_PER_LANE } from "./layout"
import type { WorkGraphResponseT } from "@/lib/types"

const REPO_ROOT = "/home/user/agent-hub"
const WT_A = "/home/user/agent-hub-worktrees/wt-a"
const WT_B = "/home/user/agent-hub-worktrees/wt-b"

function job(overrides: Partial<Record<string, unknown>> & { id: string; jobId: string }) {
  return {
    kind: "job" as const,
    agent: "claude",
    model: "sonnet",
    title: "Some job",
    status: "succeeded",
    mode: "write",
    taskType: null,
    createdAt: "2026-09-16T10:00:00.000Z",
    updatedAt: "2026-09-16T10:05:00.000Z",
    durationS: 300,
    prUrl: null,
    ...overrides,
  }
}

/**
 * repo (main) -> wt-a (branch a, branches from main) -> wt-b (branch b, branches from a)
 * job-1 runs in wt-a, job-2 runs in wt-b, job-3 continues job-2, job-4 is queued and waitsOn job-2.
 */
function baseGraph(): WorkGraphResponseT {
  return {
    generatedAt: "2026-09-16T10:10:00.000Z",
    repos: [
      {
        root: REPO_ROOT,
        mainBranch: "main",
        worktrees: [
          { path: REPO_ROOT, branch: "main", head: "abc", isMain: true, parentBranch: null },
          { path: WT_A, branch: "a", head: "def", isMain: false, parentBranch: "main" },
          { path: WT_B, branch: "b", head: "ghi", isMain: false, parentBranch: "a" },
        ],
      },
    ],
    nodes: [
      { id: `repo:${REPO_ROOT}`, kind: "repo", root: REPO_ROOT, mainBranch: "main" },
      { id: `wt:${REPO_ROOT}`, kind: "worktree", repoRoot: REPO_ROOT, path: REPO_ROOT, branch: "main", head: "abc", isMain: true },
      { id: `wt:${WT_A}`, kind: "worktree", repoRoot: REPO_ROOT, path: WT_A, branch: "a", head: "def", isMain: false },
      { id: `wt:${WT_B}`, kind: "worktree", repoRoot: REPO_ROOT, path: WT_B, branch: "b", head: "ghi", isMain: false },
      job({ id: "job:job-1", jobId: "job-1", status: "running" }),
      job({ id: "job:job-2", jobId: "job-2", status: "running", createdAt: "2026-09-16T09:00:00.000Z" }),
      job({ id: "job:job-3", jobId: "job-3", status: "succeeded", createdAt: "2026-09-16T09:30:00.000Z" }),
      job({ id: "job:job-4", jobId: "job-4", status: "queued", createdAt: "2026-09-16T09:45:00.000Z" }),
    ],
    edges: [
      { kind: "branchesFrom", from: `wt:${WT_A}`, to: `repo:${REPO_ROOT}` },
      { kind: "branchesFrom", from: `wt:${WT_B}`, to: `wt:${WT_A}` },
      { kind: "runsIn", from: "job:job-1", to: `wt:${WT_A}` },
      { kind: "runsIn", from: "job:job-2", to: `wt:${WT_B}` },
      { kind: "runsIn", from: "job:job-3", to: `wt:${WT_B}` },
      { kind: "runsIn", from: "job:job-4", to: `wt:${WT_B}` },
      { kind: "continues", from: "job:job-3", to: "job:job-2" },
      { kind: "waitsOn", from: "job:job-4", to: "job:job-2" },
    ],
  } as unknown as WorkGraphResponseT
}

describe("layoutWorkGraph", () => {
  it("returns an empty layout for a null/empty graph", () => {
    expect(layoutWorkGraph(null)).toEqual(
      expect.objectContaining({ lanes: [], jobs: [], edges: [], collapsed: [] })
    )
    expect(
      layoutWorkGraph({ generatedAt: "x", repos: [], nodes: [], edges: [] } as unknown as WorkGraphResponseT)
    ).toEqual(expect.objectContaining({ lanes: [], jobs: [], edges: [], collapsed: [] }))
  })

  it("nests worktree lanes depth-first by branchesFrom ancestry", () => {
    const layout = layoutWorkGraph(baseGraph())
    const byId = new Map(layout.lanes.map((l) => [l.id, l]))

    const repoLane = byId.get(`repo:${REPO_ROOT}`)!
    const laneA = byId.get(`wt:${WT_A}`)!
    const laneB = byId.get(`wt:${WT_B}`)!
    const laneMain = byId.get(`wt:${REPO_ROOT}`)!

    expect(repoLane.depth).toBe(0)
    expect(laneMain.depth).toBe(1) // the main worktree hangs directly off the repo trunk
    expect(laneA.depth).toBe(1)
    expect(laneB.depth).toBe(2) // nested one level deeper than its parent 'a'
    expect(laneB.parentLaneId).toBe(`wt:${WT_A}`)
    expect(laneA.parentLaneId).toBe(`repo:${REPO_ROOT}`)

    // depth-first: 'a' and its child 'b' appear before an unrelated sibling would
    const order = layout.lanes.map((l) => l.id)
    expect(order.indexOf(`wt:${WT_A}`)).toBeLessThan(order.indexOf(`wt:${WT_B}`))
  })

  it("places job leaves on their runsIn worktree lane, ordered by createdAt", () => {
    const layout = layoutWorkGraph(baseGraph())
    const laneBJobs = layout.jobs.filter((j) => j.laneId === `wt:${WT_B}`).map((j) => j.node.jobId)
    expect(laneBJobs).toEqual(["job-2", "job-3", "job-4"])
  })

  it("is deterministic across repeated calls with the same input", () => {
    const graph = baseGraph()
    const a = layoutWorkGraph(graph)
    const b = layoutWorkGraph(graph)
    expect(a).toEqual(b)
  })

  it("computes canvas size that grows with lane and job counts", () => {
    const layout = layoutWorkGraph(baseGraph())
    expect(layout.width).toBeGreaterThan(0)
    expect(layout.height).toBeGreaterThan(0)
  })

  it("builds a trunk-to-job flow path for running jobs, feeding branchesFrom + connecting edges", () => {
    const layout = layoutWorkGraph(baseGraph())
    const chain = layout.flowPathByJobId["job-1"]
    expect(chain).toBeDefined()
    // job-1 runs in wt-a: connecting edge + branchesFrom(a -> repo)
    expect(chain).toContain(`runsIn:job:job-1->wt:${WT_A}`)
    expect(chain).toContain(`branchesFrom:wt:${WT_A}->repo:${REPO_ROOT}`)

    const branchesFromEdge = layout.edges.find((e) => e.id === `branchesFrom:wt:${WT_A}->repo:${REPO_ROOT}`)
    expect(branchesFromEdge?.feedsRunningJobIds).toContain("job-1")

    // job-2 runs in wt-b: chain includes both branchesFrom hops up to the trunk
    const chain2 = layout.flowPathByJobId["job-2"]
    expect(chain2).toContain(`branchesFrom:wt:${WT_B}->wt:${WT_A}`)
    expect(chain2).toContain(`branchesFrom:wt:${WT_A}->repo:${REPO_ROOT}`)
  })

  it("does not produce a flow path for a non-running (succeeded/queued) job", () => {
    const layout = layoutWorkGraph(baseGraph())
    expect(layout.flowPathByJobId["job-3"]).toBeUndefined()
    expect(layout.flowPathByJobId["job-4"]).toBeUndefined()
  })

  it("builds a hover path-to-trunk for every job, running or not", () => {
    const layout = layoutWorkGraph(baseGraph())
    // job-3 (succeeded) and job-4 (queued) run in wt-b: hover should still be able
    // to highlight their path up to the trunk even though they don't animate.
    const chain3 = layout.pathToTrunkByJobId["job-3"]
    expect(chain3).toBeDefined()
    expect(chain3).toContain(`runsIn:job:job-3->wt:${WT_B}`)
    expect(chain3).toContain(`branchesFrom:wt:${WT_B}->wt:${WT_A}`)
    expect(chain3).toContain(`branchesFrom:wt:${WT_A}->repo:${REPO_ROOT}`)

    const chain4 = layout.pathToTrunkByJobId["job-4"]
    expect(chain4).toContain(`runsIn:job:job-4->wt:${WT_B}`)

    // same chain as the running-job flow path for a running job
    expect(layout.pathToTrunkByJobId["job-1"]).toEqual(layout.flowPathByJobId["job-1"])
  })

  it("renders continues (solid) and waitsOn (dashed-eligible) edges between job cards", () => {
    const layout = layoutWorkGraph(baseGraph())
    const continuesEdge = layout.edges.find((e) => e.kind === "continues")
    const waitsOnEdge = layout.edges.find((e) => e.kind === "waitsOn")
    expect(continuesEdge?.from).toBe("job:job-3")
    expect(continuesEdge?.to).toBe("job:job-2")
    expect(waitsOnEdge?.from).toBe("job:job-4")
    expect(waitsOnEdge?.to).toBe("job:job-2")
  })

  it("collapses a lane with more finished jobs than the visible cap, keeping active jobs plus the last N finished", () => {
    const graph = baseGraph()
    // Add enough extra finished jobs on wt-b to exceed the default cap.
    const extraCount = DEFAULT_VISIBLE_FINISHED_PER_LANE + 3
    for (let i = 0; i < extraCount; i++) {
      const id = `job:extra-${i}`
      graph.nodes.push(
        job({ id, jobId: `extra-${i}`, status: "succeeded", createdAt: `2026-09-16T08:${String(i).padStart(2, "0")}:00.000Z` }) as never
      )
      graph.edges.push({ kind: "runsIn", from: id, to: `wt:${WT_B}` } as never)
    }

    const layout = layoutWorkGraph(graph)
    const collapsedGroup = layout.collapsed.find((c) => c.laneId === `wt:${WT_B}`)
    expect(collapsedGroup).toBeDefined()
    expect(collapsedGroup!.hiddenCount).toBeGreaterThan(0)

    const visibleIds = layout.jobs.filter((j) => j.laneId === `wt:${WT_B}`).map((j) => j.node.jobId)
    // Active jobs (job-2 running, job-4 queued) always stay visible.
    expect(visibleIds).toContain("job-2")
    expect(visibleIds).toContain("job-4")
    // Only the default cap's worth of finished jobs remain visible.
    const finishedVisible = visibleIds.filter((id) => id !== "job-2" && id !== "job-4")
    expect(finishedVisible.length).toBe(DEFAULT_VISIBLE_FINISHED_PER_LANE)
  })

  it("expanding a lane via expandedLaneIds shows every job with no collapse marker", () => {
    const graph = baseGraph()
    const extraCount = DEFAULT_VISIBLE_FINISHED_PER_LANE + 3
    for (let i = 0; i < extraCount; i++) {
      const id = `job:extra-${i}`
      graph.nodes.push(
        job({ id, jobId: `extra-${i}`, status: "succeeded", createdAt: `2026-09-16T08:${String(i).padStart(2, "0")}:00.000Z` }) as never
      )
      graph.edges.push({ kind: "runsIn", from: id, to: `wt:${WT_B}` } as never)
    }

    const layout = layoutWorkGraph(graph, { expandedLaneIds: new Set([`wt:${WT_B}`]) })
    expect(layout.collapsed.find((c) => c.laneId === `wt:${WT_B}`)).toBeUndefined()
    expect(layout.jobs.filter((j) => j.laneId === `wt:${WT_B}`).length).toBe(3 + extraCount)
  })

  it("activeOnly filters out finished jobs entirely, with no collapse marker", () => {
    const layout = layoutWorkGraph(baseGraph(), { activeOnly: true })
    const laneBJobs = layout.jobs.filter((j) => j.laneId === `wt:${WT_B}`).map((j) => j.node.jobId)
    expect(laneBJobs.sort()).toEqual(["job-2", "job-4"])
    expect(layout.collapsed).toEqual([])
  })

  it("groups an outside job and Jules remoteBranch jobs into their own lane sections", () => {
    const graph = baseGraph()
    graph.nodes.push({ id: "outside", kind: "outside" } as never)
    graph.nodes.push(job({ id: "job:job-5", jobId: "job-5", status: "running" }) as never)
    graph.edges.push({ kind: "runsIn", from: "job:job-5", to: "outside" } as never)

    graph.nodes.push({
      id: "remote:owner/repo#jules-branch",
      kind: "remoteBranch",
      source: "owner/repo",
      branch: "jules-branch",
      startingBranch: "main",
      prUrl: null,
    } as never)
    graph.nodes.push(job({ id: "job:job-6", jobId: "job-6", status: "running" }) as never)
    // A Jules job also gets a runsIn->outside edge from the backend; the remote edge should win for placement.
    graph.edges.push({ kind: "runsIn", from: "job:job-6", to: "outside" } as never)
    graph.edges.push({ kind: "remote", from: "job:job-6", to: "remote:owner/repo#jules-branch" } as never)

    const layout = layoutWorkGraph(graph)
    const outsideLane = layout.lanes.find((l) => l.kind === "outside")!
    const cloudLane = layout.lanes.find((l) => l.kind === "remoteBranch")!
    expect(outsideLane).toBeDefined()
    expect(cloudLane).toBeDefined()

    const outsideJobs = layout.jobs.filter((j) => j.laneId === outsideLane.id).map((j) => j.node.jobId)
    expect(outsideJobs).toEqual(["job-5"])

    const cloudJobs = layout.jobs.filter((j) => j.laneId === cloudLane.id).map((j) => j.node.jobId)
    expect(cloudJobs).toEqual(["job-6"]) // job-6 is placed on its remoteBranch lane, not duplicated under 'outside'

    const sectionLabels = layout.sections.map((s) => s.label)
    expect(sectionLabels).toContain("Outside git")
    // "Cloud · Jules" per T4a: distinct Cloud/Jules lane-group label (was plain "Cloud").
    expect(sectionLabels).toContain("Cloud · Jules")
  })
})

describe("summarizeJobs", () => {
  it("returns all-zero counts for a null/empty graph", () => {
    expect(summarizeJobs(null)).toEqual({ running: 0, queued: 0, failed: 0, succeeded: 0, canceled: 0, total: 0 })
  })

  it("counts jobs by status across the whole graph", () => {
    const summary = summarizeJobs(baseGraph())
    // baseGraph: job-1 running, job-2 running, job-3 succeeded, job-4 queued
    expect(summary).toEqual({ running: 2, queued: 1, failed: 0, succeeded: 1, canceled: 0, total: 4 })
  })
})

describe("layoutWorkGraph: lane positions, detached/empty lanes", () => {
  it("assigns every lane a distinct y (its own row), never stacked at the same position", () => {
    const layout = layoutWorkGraph(baseGraph())
    const ys = layout.lanes.map((l) => l.y)
    expect(new Set(ys).size).toBe(ys.length)
  })

  it("keeps a job-less lane visible in layout.lanes with its label intact", () => {
    const graph = baseGraph()
    // wt-a (branch "a") has no job runsIn edges pointing at it in baseGraph.
    const laneA = layoutWorkGraph(graph).lanes.find((l) => l.id === `wt:${WT_A}`)
    expect(laneA).toBeDefined()
    expect(laneA!.label).toBe("a")
  })

  it("labels a detached-HEAD worktree (branch: null) as 'detached @ <short head>'", () => {
    const graph = baseGraph()
    graph.nodes = graph.nodes.map((n) =>
      (n as { id: string }).id === `wt:${WT_A}` ? { ...n, branch: null, head: "abcdef1234567" } : n
    ) as never
    const layout = layoutWorkGraph(graph)
    const laneA = layout.lanes.find((l) => l.id === `wt:${WT_A}`)!
    expect(laneA.label).toBe("detached @ abcdef1")
  })
})

describe("layoutWorkGraph: removed worktrees", () => {
  const REMOVED_ID = `wt:/removed/gone-feature`

  function graphWithRemoved(status: string): WorkGraphResponseT {
    const graph = baseGraph()
    graph.nodes.push({
      id: REMOVED_ID,
      kind: "worktree",
      repoRoot: REPO_ROOT,
      path: "/removed/gone-feature",
      branch: null,
      head: null,
      isMain: false,
      removed: true,
      label: "gone-feature",
    } as never)
    graph.edges.push({ kind: "branchesFrom", from: REMOVED_ID, to: `repo:${REPO_ROOT}` } as never)
    graph.nodes.push(job({ id: "job:removed-job", jobId: "removed-job", status }) as never)
    graph.edges.push({ kind: "runsIn", from: "job:removed-job", to: REMOVED_ID } as never)
    return graph
  }

  it("collapses a removed worktree with no active jobs into a 'N removed worktrees' expander under its repo", () => {
    const layout = layoutWorkGraph(graphWithRemoved("succeeded"))
    expect(layout.lanes.some((l) => l.id === REMOVED_ID)).toBe(false)
    const group = layout.removedGroups.find((g) => g.repoLaneId === `repo:${REPO_ROOT}`)
    expect(group).toBeDefined()
    expect(group!.hiddenCount).toBe(1)
  })

  it("shows a removed worktree with an active job as its own (muted) lane, not collapsed", () => {
    const layout = layoutWorkGraph(graphWithRemoved("running"))
    const lane = layout.lanes.find((l) => l.id === REMOVED_ID)
    expect(lane).toBeDefined()
    expect(lane!.label).toBe("gone-feature")
    expect(layout.removedGroups.find((g) => g.repoLaneId === `repo:${REPO_ROOT}`)).toBeUndefined()
  })

  it("expands a collapsed removed group via expandedLaneIds, showing the individual lane", () => {
    const graph = graphWithRemoved("succeeded")
    const layout = layoutWorkGraph(graph, { expandedLaneIds: new Set([`repo:${REPO_ROOT}::removed`]) })
    expect(layout.lanes.some((l) => l.id === REMOVED_ID)).toBe(true)
    expect(layout.removedGroups).toEqual([])
  })
})

describe("layoutWorkGraph: Cloud/Jules group header and pending/unstarted nodes", () => {
  it("adds a 'Cloud · Jules' group header when remoteBranch nodes are present", () => {
    const graph = baseGraph()
    graph.nodes.push({
      id: "remote:owner/repo#jules-branch",
      kind: "remoteBranch",
      source: "owner/repo",
      branch: "jules-branch",
      startingBranch: "main",
      prUrl: null,
    } as never)
    const layout = layoutWorkGraph(graph)
    const header = layout.groupHeaders.find((h) => h.id === "cloud")
    expect(header).toBeDefined()
    expect(header!.label).toBe("Cloud · Jules")
  })

  it("labels a pending Jules node (no branch yet) as 'from <startingBranch>'", () => {
    const graph = baseGraph()
    graph.nodes.push({
      id: "remote:owner/repo#pending:main",
      kind: "remoteBranch",
      source: "owner/repo",
      branch: null,
      startingBranch: "main",
      prUrl: null,
      pending: true,
      label: "from main",
    } as never)
    const layout = layoutWorkGraph(graph)
    const lane = layout.lanes.find((l) => l.id === "remote:owner/repo#pending:main")!
    expect(lane.label).toBe("from main")
  })

  it("renders a lane-to-lane cross-link 'remote' edge (Cloud node -> local branch lane)", () => {
    const graph = baseGraph()
    graph.nodes.push({
      id: "remote:owner/repo#pending:a",
      kind: "remoteBranch",
      source: "owner/repo",
      branch: null,
      startingBranch: "a",
      prUrl: null,
      pending: true,
      label: "from a",
    } as never)
    graph.edges.push({ kind: "remote", from: "remote:owner/repo#pending:a", to: `wt:${WT_A}` } as never)

    const layout = layoutWorkGraph(graph)
    const crossLink = layout.edges.find((e) => e.id === `remote:remote:owner/repo#pending:a->wt:${WT_A}`)
    expect(crossLink).toBeDefined()
    expect(crossLink!.kind).toBe("remote")
  })
})

describe("selectRepoGraph", () => {
  it("returns the full graph unchanged for 'all'", () => {
    const graph = baseGraph()
    expect(selectRepoGraph(graph, "all")).toBe(graph)
  })

  it("narrows to one repo's trunk/worktree lanes and their jobs, keeping outside/remote nodes", () => {
    const graph = baseGraph()
    graph.nodes.push({ id: "outside", kind: "outside" } as never)
    graph.nodes.push(job({ id: "job:job-5", jobId: "job-5", status: "running" }) as never)
    graph.edges.push({ kind: "runsIn", from: "job:job-5", to: "outside" } as never)

    const scoped = selectRepoGraph(graph, REPO_ROOT)
    expect(scoped.repos).toHaveLength(1)
    expect(scoped.nodes.some((n) => n.id === "outside")).toBe(true)
    expect(scoped.nodes.some((n) => n.id === "job:job-5")).toBe(true)
    expect(scoped.nodes.some((n) => n.id === `wt:${WT_B}`)).toBe(true)
  })
})

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { WorkGraphView } from "./index"
import * as queries from "@/lib/queries"
import type { WorkGraphResponseT } from "@/lib/types"

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to, search, className }: any) => (
    <a href={`${to}?q=${search?.q ?? ""}`} className={className}>
      {children}
    </a>
  ),
}))

const REPO_ROOT = "/repo"
const WT_MAIN = "/repo"
const WT_A = "/repo-worktrees/a"

function graphFixture(): WorkGraphResponseT {
  return {
    generatedAt: "2026-09-16T10:00:00.000Z",
    repos: [
      {
        root: REPO_ROOT,
        mainBranch: "main",
        worktrees: [
          { path: WT_MAIN, branch: "main", head: "a", isMain: true, parentBranch: null },
          { path: WT_A, branch: "feature-a", head: "b", isMain: false, parentBranch: "main" },
        ],
      },
    ],
    nodes: [
      { id: `repo:${REPO_ROOT}`, kind: "repo", root: REPO_ROOT, mainBranch: "main" },
      { id: `wt:${WT_MAIN}`, kind: "worktree", repoRoot: REPO_ROOT, path: WT_MAIN, branch: "main", head: "a", isMain: true },
      { id: `wt:${WT_A}`, kind: "worktree", repoRoot: REPO_ROOT, path: WT_A, branch: "feature-a", head: "b", isMain: false },
      {
        id: "job:running-1",
        kind: "job",
        jobId: "running-1",
        agent: "claude",
        model: "sonnet",
        title: "Running task",
        status: "running",
        mode: "write",
        taskType: null,
        createdAt: "2026-09-16T09:00:00.000Z",
        updatedAt: "2026-09-16T09:05:00.000Z",
        durationS: 300,
        prUrl: null,
      },
      {
        id: "job:done-1",
        kind: "job",
        jobId: "done-1",
        agent: "codex",
        model: "gpt-5",
        title: "Finished task",
        status: "succeeded",
        mode: "read",
        taskType: null,
        createdAt: "2026-09-16T08:00:00.000Z",
        updatedAt: "2026-09-16T08:10:00.000Z",
        durationS: 600,
        prUrl: "https://github.com/x/y/pull/1",
      },
      {
        id: "job:queued-1",
        kind: "job",
        jobId: "queued-1",
        agent: "codex",
        model: "gpt-5",
        title: "Queued task",
        status: "queued",
        mode: "write",
        taskType: null,
        createdAt: "2026-09-16T09:10:00.000Z",
        updatedAt: "2026-09-16T09:10:00.000Z",
        durationS: null,
        prUrl: null,
      },
      {
        id: "job:failed-1",
        kind: "job",
        jobId: "failed-1",
        agent: "claude",
        model: "sonnet",
        title: "Failed task",
        status: "failed",
        mode: "write",
        taskType: null,
        createdAt: "2026-09-16T08:20:00.000Z",
        updatedAt: "2026-09-16T08:25:00.000Z",
        durationS: 60,
        prUrl: null,
      },
    ],
    edges: [
      { kind: "branchesFrom", from: `wt:${WT_A}`, to: `wt:${WT_MAIN}` },
      { kind: "runsIn", from: "job:running-1", to: `wt:${WT_A}` },
      { kind: "runsIn", from: "job:done-1", to: `wt:${WT_A}` },
      { kind: "runsIn", from: "job:queued-1", to: `wt:${WT_A}` },
      { kind: "runsIn", from: "job:failed-1", to: `wt:${WT_A}` },
    ],
  } as unknown as WorkGraphResponseT
}

describe("WorkGraphView", () => {
  beforeEach(() => {
    vi.spyOn(queries, "useWorkGraphQuery").mockReturnValue({
      data: graphFixture(),
      isLoading: false,
      isError: false,
      error: null,
    } as any)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("renders lane labels for the repo trunk and worktree branches", () => {
    // Selector-scoped: each label now also carries a <title> tooltip with the
    // same (short, un-truncated) text, so a plain getByText would match both.
    render(<WorkGraphView />)
    expect(screen.getByText("feature-a", { selector: '[data-slot="lane-label"]' })).toBeTruthy()
    expect(screen.getByText("main", { selector: '[data-slot="lane-label"]' })).toBeTruthy()
  })

  it("marks the running job card as animated/running", () => {
    render(<WorkGraphView />)
    const card = screen.getByText("Running task").closest('[data-slot="job-card"]')
    expect(card).toBeTruthy()
    expect(card?.getAttribute("data-running")).toBe("true")
  })

  it("hides finished jobs when Active only is toggled on, keeps running jobs", () => {
    render(<WorkGraphView />)
    expect(screen.getByText("Finished task")).toBeTruthy()

    fireEvent.click(screen.getByRole("button", { name: /active only/i }))

    expect(screen.queryByText("Finished task")).toBeNull()
    expect(screen.getByText("Running task")).toBeTruthy()
  })

  it("opens the detail panel with job fields when a job card is clicked", () => {
    render(<WorkGraphView />)
    fireEvent.click(screen.getByText("Running task"))

    expect(screen.getByText("running-1")).toBeTruthy()
    expect(screen.getByText("claude")).toBeTruthy()
  })

  it("renders a loading state while the query is pending", () => {
    vi.spyOn(queries, "useWorkGraphQuery").mockReturnValue({
      data: undefined,
      isLoading: true,
      isError: false,
      error: null,
    } as any)
    render(<WorkGraphView />)
    expect(screen.getByText(/loading work graph/i)).toBeTruthy()
  })

  it("renders an error state when the query fails", () => {
    vi.spyOn(queries, "useWorkGraphQuery").mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      error: new Error("boom"),
    } as any)
    render(<WorkGraphView />)
    expect(screen.getByText(/couldn't load the work graph/i)).toBeTruthy()
  })

  it("renders an empty state when there is no repo/worktree/job data", () => {
    vi.spyOn(queries, "useWorkGraphQuery").mockReturnValue({
      data: { generatedAt: "x", repos: [], nodes: [], edges: [] },
      isLoading: false,
      isError: false,
      error: null,
    } as any)
    render(<WorkGraphView />)
    expect(screen.getByText(/no active work/i)).toBeTruthy()
  })

  it("shows a compact live summary of running/queued/failed counts", () => {
    render(<WorkGraphView />)
    const summary = screen.getByLabelText("Live summary")
    expect(summary.textContent).toMatch(/1\s*running/i)
    expect(summary.textContent).toMatch(/1\s*queued/i)
    expect(summary.textContent).toMatch(/1\s*failed/i)
  })

  it("renders a legend for job statuses and edge kinds", () => {
    render(<WorkGraphView />)
    expect(screen.getByText("Running")).toBeTruthy()
    expect(screen.getByText("Queued")).toBeTruthy()
    expect(screen.getByText("Succeeded")).toBeTruthy()
    expect(screen.getByText("Failed")).toBeTruthy()
    expect(screen.getByText("Branches from")).toBeTruthy()
    expect(screen.getByText("Waits on")).toBeTruthy()
  })

  it("dims the other job cards while hovering one, and clears the dim on mouse-leave", () => {
    render(<WorkGraphView />)
    const runningCard = screen.getByText("Running task").closest('[data-slot="job-card"]') as HTMLElement
    const finishedCard = screen.getByText("Finished task").closest('[data-slot="job-card"]') as HTMLElement

    fireEvent.mouseEnter(runningCard)
    expect(finishedCard.getAttribute("data-dimmed")).toBe("true")
    expect(runningCard.getAttribute("data-dimmed")).toBeNull()

    fireEvent.mouseLeave(runningCard)
    expect(finishedCard.getAttribute("data-dimmed")).toBeNull()
  })

  it("opens the detail panel when a job card is activated with the keyboard", () => {
    render(<WorkGraphView />)
    const runningCard = screen.getByText("Running task").closest('[data-slot="job-card"]') as HTMLElement

    fireEvent.keyDown(runningCard, { key: "Enter" })

    expect(screen.getByText("running-1")).toBeTruthy()
  })

  it("gives every lane row a distinct position, and keeps the position transform off the reveal-animated element (regression: CSS transform on an SVG transform attribute overrides it, collapsing every lane to the same y)", () => {
    render(<WorkGraphView />)
    const laneGroups = Array.from(document.querySelectorAll('[data-slot="lane"]'))
    expect(laneGroups.length).toBeGreaterThan(1)

    const transforms = laneGroups.map((g) => g.getAttribute("transform"))
    expect(new Set(transforms).size).toBe(transforms.length)

    for (const g of laneGroups) {
      expect(g.classList.contains("wg-reveal")).toBe(false)
    }
  })

  it("truncates a long lane label with a full-name title tooltip", () => {
    const longBranch = "feature/a-really-quite-long-branch-name-that-must-be-truncated"
    vi.spyOn(queries, "useWorkGraphQuery").mockReturnValue({
      data: {
        ...graphFixture(),
        nodes: (graphFixture().nodes as unknown as Array<Record<string, unknown>>).map((n) =>
          n.id === `wt:${WT_A}` ? { ...n, branch: longBranch } : n
        ),
      },
      isLoading: false,
      isError: false,
      error: null,
    } as any)
    render(<WorkGraphView />)
    const label = document.querySelector(`[data-lane-id="wt:${WT_A}"] [data-slot="lane-label"]`) as SVGTextElement
    expect(label).toBeTruthy()
    expect(label.querySelector("title")?.textContent).toBe(longBranch)
    // The visible (non-title) text node is a truncated ellipsis form, shorter than the full name.
    const visibleText = Array.from(label.childNodes)
      .filter((n) => n.nodeType === Node.TEXT_NODE)
      .map((n) => n.textContent)
      .join("")
    expect(visibleText.length).toBeLessThan(longBranch.length)
    expect(visibleText.endsWith("…")).toBe(true)
    expect(longBranch.startsWith(visibleText.slice(0, -1))).toBe(true)
  })
})

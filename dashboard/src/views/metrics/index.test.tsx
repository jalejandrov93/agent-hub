import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { MetricsRowT } from "@/lib/types"
import { MetricsView } from "./index"
import { chartHeightClass, mapMetricsChartRows } from "./chart-data"

const navigate = vi.fn()
const search = { taskType: "" }
const rows: MetricsRowT[] = [
  {
    agent: "agy",
    model: "gemini-3.8-flash-high",
    mode: "read",
    taskType: "call-chain-trace" as const,
    samples: 12,
    succeeded: 11,
    failed: 1,
    canceled: 0,
    successRate: 0.9167,
    p50Ms: 71000,
    p95Ms: 314000,
    errorKinds: { timeout: 1 },
    tokensTotal: 1320000,
    tokensAvg: 120000,
    costUsdAvg: 0.0123,
    verifiedCount: 8,
    verifiedSamples: 9,
    verifiedRate: 0.89,
    qualityScore: 8.9,
    revisionAvg: 1.25,
  },
  {
    agent: "opencode",
    model: "opencode/muse-spark-1.3-contributor-free",
    mode: "read",
    taskType: null,
    samples: 3,
    succeeded: 2,
    failed: 1,
    canceled: 0,
    successRate: 0.6667,
    p50Ms: 95000,
    p95Ms: null,
    errorKinds: { empty: 1 },
    tokensTotal: 180000,
    tokensAvg: 90000,
    costUsdAvg: null,
    verifiedCount: 0,
    verifiedSamples: 0,
    verifiedRate: null,
    qualityScore: null,
    revisionAvg: null,
  },
]

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigate,
  useSearch: () => search,
}))

vi.mock("@/lib/queries", () => ({
  useMetricsQuery: () => ({
    data: { generatedAt: "2026-09-15T04:00:00.000Z", groupBy: [], rows },
    isPending: false,
    isError: false,
  }),
}))

describe("MetricsView", () => {
  beforeEach(() => {
    navigate.mockReset()
    search.taskType = ""
  })

  it("offers task type filters and filters untagged rows", () => {
    render(<MetricsView />)

    fireEvent.click(screen.getByRole("combobox"))
    expect(screen.getAllByText("untagged").length).toBeGreaterThan(1)

    cleanup()
    search.taskType = "untagged"
    render(<MetricsView />)
    expect(screen.getAllByText("opencode").length).toBeGreaterThan(0)
    expect(screen.queryByText("agy")).toBeNull()
  })

  it("renders low-sample badges and an empty state after filtering", () => {
    render(<MetricsView />)
    expect(screen.getByText("low sample")).toBeTruthy()

    search.taskType = "research"
    render(<MetricsView />)
    expect(screen.getByText("No metrics yet")).toBeTruthy()
  })

  it("renders the chart without injecting a style element", () => {
    const stylesBefore = document.head.querySelectorAll("style").length
    const { container } = render(<MetricsView />)

    expect(container.querySelector("style")).toBeNull()
    expect(document.head.querySelectorAll("style").length).toBe(stylesBefore)
    expect(container.querySelector('[data-slot="chart"]')).toBeTruthy()
  })

  it("maps one chart category per row and flags low-sample pairs", () => {
    const chartRows = mapMetricsChartRows(rows)

    expect(chartRows).toHaveLength(rows.length)
    expect(chartRows.map((row) => row.name)).toEqual([
      "agy:gemini-3.8-flash-high",
      "opencode:opencode/muse-spark-1.3-contributor-free",
    ])
    expect(chartRows.map((row) => row.fillOpacity)).toEqual([1, 0.45])
    expect(chartHeightClass(16)).toBe("h-[28rem]")
  })

  it("renders verified, quality, cost, and revision columns", () => {
    render(<MetricsView />)

    expect(screen.getByText("Verified")).toBeTruthy()
    expect(screen.getByText("Quality")).toBeTruthy()
    expect(screen.getByText("Avg cost")).toBeTruthy()
    expect(screen.getByText("Avg revisions")).toBeTruthy()

    expect(screen.getByText("89.0%")).toBeTruthy()
    expect(screen.getByText("8.9")).toBeTruthy()
    expect(screen.getByText("$0.0123")).toBeTruthy()
    expect(screen.getByText("1.25")).toBeTruthy()

    const opencodeRow = screen.getByText("opencode").closest("tr")!
    expect(opencodeRow).toBeTruthy()
    expect(within(opencodeRow).getByText("unverified")).toBeTruthy()
    const opencodeCells = Array.from(opencodeRow.querySelectorAll("td"))
    expect(opencodeCells[10]?.textContent).toBe("—")
    expect(opencodeCells[11]?.textContent).toContain("—")
  })

  it("renders summary cards inside PixelCard without double tab stop and animates CountUpValue", async () => {
    const { container } = render(<MetricsView />)

    // PixelCards wrap summary cards
    const pixelCards = container.querySelectorAll(".pixel-card")
    expect(pixelCards.length).toBeGreaterThanOrEqual(3)

    // noFocus means no tabindex
    pixelCards.forEach((card) => {
      expect(card.getAttribute("tabindex")).toBeNull()
      expect(card.querySelector(".pixel-canvas")).toBeTruthy()
    })

    // Zero style elements in container or injected in head
    expect(container.querySelector("style")).toBeNull()

    // Assert final animated values
    await waitFor(() => {
      expect(screen.getByText("15")).toBeTruthy()
      expect(screen.getByText("86.7%")).toBeTruthy()
    })
  })

  it("renders summary card values immediately under prefers-reduced-motion", () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn().mockImplementation((query: string) => ({
        matches: query.includes("prefers-reduced-motion: reduce"),
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      }))
    )

    render(<MetricsView />)

    // Immediate render under reduced motion (no count-up delay)
    expect(screen.getByText("15")).toBeTruthy()
    expect(screen.getByText("86.7%")).toBeTruthy()
  })
})



import { render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import type { McpToolT } from "@/lib/types"
import { ToolsView } from "./index"

const tools: McpToolT[] = [
  {
    name: "dispatch",
    title: "Dispatch a task through routing, policy, and reservation",
    description: "Route, reserve write lock, and execute a task.",
  },
  {
    name: "jules_wait",
    title: "Wait locally for a Jules session to need you or finish",
    description: "Local orchestration only — the Jules API has no wait endpoint.",
  },
  {
    name: "jules_supervise",
    title: "Supervise a Jules session with autonomous watch and interaction",
    description: "Autonomous watch-and-interact loop for a Jules session.",
  },
]

vi.mock("@/lib/queries", () => ({
  useToolsQuery: () => ({
    data: { tools },
    isPending: false,
    isError: false,
  }),
}))

describe("ToolsView", () => {
  it("renders the total count and one row per tool", () => {
    render(<ToolsView />)

    expect(screen.getByText("Total tools")).toBeTruthy()
    expect(screen.getByText(String(tools.length))).toBeTruthy()
    for (const tool of tools) {
      expect(screen.getByText(tool.name)).toBeTruthy()
      expect(screen.getByText(tool.title)).toBeTruthy()
    }
  })

  it("renders rows sorted by name", () => {
    const { container } = render(<ToolsView />)
    const firstCells = [...container.querySelectorAll("tbody tr td:first-child")].map((cell) =>
      cell.textContent?.trim()
    )
    expect(firstCells).toEqual(["dispatch", "jules_supervise", "jules_wait"])
  })
})

import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { ProviderMark, PROVIDER_ASSETS } from "./ProviderMark"

describe("ProviderMark", () => {
  it("renders the correct 2-letter uppercase monogram", () => {
    render(<ProviderMark agent="agy" />)
    expect(screen.getByText("AG")).toBeTruthy()
  })

  it("applies the expected size classes for sm and md", () => {
    const { rerender } = render(<ProviderMark agent="copilot" size="sm" />)
    const smEl = screen.getByText("CO")
    expect(smEl.className).toContain("size-6")

    rerender(<ProviderMark agent="copilot" size="md" />)
    const mdEl = screen.getByText("CO")
    expect(mdEl.className).toContain("size-8")
  })

  it("applies provider palette and falls back to muted for unknown agents", () => {
    const { rerender } = render(<ProviderMark agent="claude" />)
    const claudeEl = screen.getByText("CL")
    expect(claudeEl.className).toContain("bg-orange")

    rerender(<ProviderMark agent="unknown-bot" />)
    const unknownEl = screen.getByText("UN")
    expect(unknownEl.className).toContain("bg-muted")
  })

  it("renders an img when an asset is registered in PROVIDER_ASSETS, else falls back to monogram", () => {
    PROVIDER_ASSETS["custom-agent"] = "/providers/custom.svg"

    const { rerender } = render(<ProviderMark agent="custom-agent" />)
    const img = screen.getByRole("img")
    expect(img.getAttribute("src")).toBe("/providers/custom.svg")
    expect(img.getAttribute("alt")).toBe("custom-agent")

    delete PROVIDER_ASSETS["custom-agent"]
    rerender(<ProviderMark agent="custom-agent" />)
    expect(screen.getByText("CU")).toBeTruthy()
  })
})

import { describe, expect, it, vi, afterEach } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import { CountUpValue } from "./CountUpValue"

function mockMatchMedia(reduceMotion: boolean) {
  return vi.fn().mockImplementation((query: string) => ({
    matches: query.includes("prefers-reduced-motion: reduce") ? reduceMotion : false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }))
}

describe("CountUpValue", () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("mounts and animates up to the target value", async () => {
    window.matchMedia = mockMatchMedia(false)
    render(<CountUpValue value={42} duration={50} />)

    await waitFor(() => {
      expect(screen.getByText("42")).toBeTruthy()
    })
    expect(screen.getByText("42").className).toContain("tabular-nums")
  })

  it("renders final value instantly under prefers-reduced-motion", () => {
    window.matchMedia = mockMatchMedia(true)
    render(<CountUpValue value={100} duration={1000} />)

    // Under reduced motion, no rAF delay - immediate render of target value
    expect(screen.getByText("100")).toBeTruthy()
  })

  it("does not retrigger animation on re-render with identical value", async () => {
    window.matchMedia = mockMatchMedia(false)
    const { rerender } = render(<CountUpValue value={25} duration={50} />)

    await waitFor(() => {
      expect(screen.getByText("25")).toBeTruthy()
    })

    const rafSpy = vi.spyOn(window, "requestAnimationFrame")
    rerender(<CountUpValue value={25} duration={50} />)

    // Identical value must not request any animation frames
    expect(rafSpy).not.toHaveBeenCalled()
  })

  it("animates to new target when value changes", async () => {
    window.matchMedia = mockMatchMedia(false)
    const { rerender } = render(<CountUpValue value={10} duration={50} />)

    await waitFor(() => {
      expect(screen.getByText("10")).toBeTruthy()
    })

    rerender(<CountUpValue value={20} duration={50} />)

    await waitFor(() => {
      expect(screen.getByText("20")).toBeTruthy()
    })
  })

  it("formats value using custom formatter function", async () => {
    window.matchMedia = mockMatchMedia(false)
    render(
      <CountUpValue
        value={1500}
        duration={50}
        format={(v) => `${(Math.round(v) / 1000).toFixed(1)}k`}
      />
    )

    await waitFor(() => {
      expect(screen.getByText("1.5k")).toBeTruthy()
    })
  })
})

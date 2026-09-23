import { describe, it, expect, vi, afterEach } from "vitest"
import { render } from "@testing-library/react"
import BorderGlow from "./BorderGlow"

describe("BorderGlow", () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it("cancels its pending sweep timers and frames when it unmounts mid-animation", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "requestAnimationFrame", "cancelAnimationFrame", "performance"] })
    const { unmount } = render(<BorderGlow animated>content</BorderGlow>)

    // The sweep schedules its four phases up front (the later ones delayed).
    expect(vi.getTimerCount()).toBeGreaterThan(0)

    unmount()

    expect(vi.getTimerCount()).toBe(0)
  })

  it("schedules nothing when not animated", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "requestAnimationFrame", "cancelAnimationFrame", "performance"] })
    render(<BorderGlow>content</BorderGlow>)
    expect(vi.getTimerCount()).toBe(0)
  })
})

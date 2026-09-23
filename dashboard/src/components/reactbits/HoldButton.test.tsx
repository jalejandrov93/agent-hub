import { describe, it, expect, vi, afterEach } from "vitest"
import { render, screen, fireEvent, act } from "@testing-library/react"
import { HoldButton } from "./HoldButton"

describe("HoldButton", () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it("renders children as its accessible label", () => {
    render(<HoldButton>Cancel</HoldButton>)
    const button = screen.getByRole("button", { name: "Cancel" })
    expect(button).toBeTruthy()
    expect(button.getAttribute("data-phase")).toBe("idle")
  })

  it("does not trigger onHold or change state on a short press", () => {
    const onHold = vi.fn()
    const onTap = vi.fn()
    render(
      <HoldButton holdTime={2000} onHold={onHold} onTap={onTap}>
        Cancel
      </HoldButton>
    )
    const button = screen.getByRole("button", { name: "Cancel" })

    fireEvent.pointerDown(button, { button: 0, isPrimary: true, pointerId: 1 })
    fireEvent.pointerUp(button, { pointerId: 1 })

    expect(onHold).not.toHaveBeenCalled()
    expect(onTap).toHaveBeenCalledTimes(1)
    expect(button.getAttribute("data-phase")).toBe("idle")
  })

  it("fires onHold after a completed sustained hold", () => {
    const onHold = vi.fn()
    render(
      <HoldButton holdTime={2000} onHold={onHold}>
        Cancel
      </HoldButton>
    )
    const button = screen.getByRole("button", { name: "Cancel" })

    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "requestAnimationFrame", "cancelAnimationFrame", "performance", "Date"],
    })

    fireEvent.pointerDown(button, { button: 0, isPrimary: true, pointerId: 1 })
    expect(button.getAttribute("data-phase")).toBe("holding")

    act(() => {
      vi.advanceTimersByTime(2150)
    })

    expect(onHold).toHaveBeenCalledTimes(1)
    expect(button.getAttribute("data-phase")).toBe("done")
    fireEvent.pointerUp(button, { pointerId: 1 })
  })

  it("does not render any <style> element inside the button (CSP constraint)", () => {
    const { container } = render(<HoldButton>Cancel</HoldButton>)
    const button = screen.getByRole("button", { name: "Cancel" })

    // Rule 1: style-src 'self' forbids inline <style> elements
    expect(button.querySelector("style")).toBeNull()
    expect(container.querySelector("style")).toBeNull()
  })
})

import { afterEach } from "vitest"
import { cleanup } from "@testing-library/react"

// happy-dom + Vitest globals don't auto-register React Testing Library's
// cleanup the way Jest's globals do, so unmount every rendered tree by hand
// between tests to avoid leaking DOM nodes/listeners across test files.
afterEach(() => {
  cleanup()
})

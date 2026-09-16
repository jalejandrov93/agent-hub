import { describe, expect, it, vi, beforeEach, afterEach } from "vitest"
import { renderHook, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import * as React from "react"
import { keyForEventKind, keysForEventKind, useEventStream } from "./sse"
import { qk } from "./query-keys"

describe("keyForEventKind", () => {
  it("maps job.* and preflight kinds to the state key", () => {
    expect(keyForEventKind("job.started")).toEqual(qk.state)
    expect(keyForEventKind("job.finished")).toEqual(qk.state)
    expect(keyForEventKind("preflight")).toEqual(qk.state)
  })

  it("maps proposal.* kinds to the proposals key", () => {
    expect(keyForEventKind("proposal.created")).toEqual(qk.proposals)
  })

  it("maps learning.* kinds to the learnings key", () => {
    expect(keyForEventKind("learning.proposed")).toEqual(qk.learnings)
  })

  it("falls back to the state key for an unknown kind", () => {
    expect(keyForEventKind("subagent.start")).toEqual(qk.state)
  })
})

describe("keysForEventKind", () => {
  it("invalidates both state and work-graph for job.* kinds", () => {
    expect(keysForEventKind("job.started")).toEqual([qk.state, qk.workGraph])
    expect(keysForEventKind("job.finished")).toEqual([qk.state, qk.workGraph])
  })

  it("invalidates only the state key for preflight (not job.*)", () => {
    expect(keysForEventKind("preflight")).toEqual([qk.state])
  })

  it("invalidates only the primary key for non-job kinds", () => {
    expect(keysForEventKind("proposal.created")).toEqual([qk.proposals])
    expect(keysForEventKind("learning.proposed")).toEqual([qk.learnings])
    expect(keysForEventKind("subagent.start")).toEqual([qk.state])
  })
})

/** Minimal fake EventSource: captures the last instance and lets tests drive onopen/onmessage/onerror. */
class FakeEventSource {
  static instances: FakeEventSource[] = []
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSED = 2

  url: string
  readyState = FakeEventSource.CONNECTING
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onerror: (() => void) | null = null

  constructor(url: string) {
    this.url = url
    FakeEventSource.instances.push(this)
  }

  close() {
    this.readyState = FakeEventSource.CLOSED
  }
}

describe("useEventStream", () => {
  beforeEach(() => {
    FakeEventSource.instances = []
    // @ts-expect-error test double, not the DOM's real EventSource
    globalThis.EventSource = FakeEventSource
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  function wrapper({ children }: { children: React.ReactNode }) {
    const client = new QueryClient()
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>
  }

  it("invalidates both the state and work-graph queries on a job.* event", async () => {
    const client = new QueryClient()
    const invalidateSpy = vi.spyOn(client, "invalidateQueries")
    function localWrapper({ children }: { children: React.ReactNode }) {
      return <QueryClientProvider client={client}>{children}</QueryClientProvider>
    }

    renderHook(() => useEventStream(), { wrapper: localWrapper })
    const source = FakeEventSource.instances[0]
    source.onmessage?.({
      data: JSON.stringify({ ts: "2024-01-01T00:00:00.000Z", source: "hub", kind: "job.finished" }),
    })

    await waitFor(() => {
      const keys = invalidateSpy.mock.calls.map((call) => call[0]?.queryKey)
      expect(keys).toContainEqual(qk.state)
      expect(keys).toContainEqual(qk.workGraph)
    })
  })

  it("goes live on open and appends messages to the event buffer", async () => {
    const { result } = renderHook(() => useEventStream(), { wrapper })
    expect(result.current.connection).toBe("connecting")

    const source = FakeEventSource.instances[0]
    source.readyState = FakeEventSource.OPEN
    source.onopen?.()

    await waitFor(() => expect(result.current.connection).toBe("live"))

    source.onmessage?.({ data: JSON.stringify({ ts: "2024-01-01T00:00:00.000Z", source: "hub", kind: "job.queued" }) })

    await waitFor(() => expect(result.current.events).toHaveLength(1))
    expect(result.current.events[0].kind).toBe("job.queued")
  })

  it("reports offline once the connection is closed", async () => {
    const { result } = renderHook(() => useEventStream(), { wrapper })
    const source = FakeEventSource.instances[0]
    source.readyState = FakeEventSource.CLOSED
    source.onerror?.()
    await waitFor(() => expect(result.current.connection).toBe("offline"))
  })
})

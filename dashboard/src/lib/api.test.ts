import { describe, expect, it, vi, afterEach } from "vitest"
import { z } from "zod"
import { fetchJson, ApiError } from "./api"

function fakeResponse(status: number, body: unknown, ok = status >= 200 && status < 300) {
  return {
    ok,
    status,
    text: () => Promise.resolve(JSON.stringify(body)),
  } as Response
}

describe("fetchJson", () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("parses the response body with the given schema on success", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(fakeResponse(200, { ok: true })))
    const schema = z.object({ ok: z.boolean() })
    await expect(fetchJson(schema, "/api/whatever")).resolves.toEqual({ ok: true })
  })

  it("throws an ApiError with the server's error message and status on non-2xx", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(fakeResponse(404, { error: "job not found: j1" })))
    const schema = z.unknown()
    await expect(fetchJson(schema, "/api/jobs/j1/cancel")).rejects.toMatchObject({
      name: "ApiError",
      message: "job not found: j1",
      status: 404,
    })
  })

  it("throws an ApiError even when the error body isn't JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: () => Promise.resolve("<html>gateway error</html>"),
      } as Response)
    )
    await expect(fetchJson(z.unknown(), "/api/state")).rejects.toBeInstanceOf(ApiError)
  })
})

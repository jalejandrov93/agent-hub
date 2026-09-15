import * as React from "react"

const STORAGE_KEY = "agent-hub:timeline-seen"

function readStored(): string | null {
  try {
    return window.localStorage.getItem(STORAGE_KEY)
  } catch {
    return null
  }
}

function writeStored(ts: string) {
  try {
    window.localStorage.setItem(STORAGE_KEY, ts)
  } catch {
    // ignore: the timeline badge just won't persist across reloads
  }
}

/**
 * Tracks the newest timeline event ts the user has seen (persisted to
 * localStorage). `markSeen(ts)` is a no-op if `ts` isn't newer than what's
 * already stored, so an out-of-order call never rewinds the badge.
 */
export function useTimelineSeen(): [string | null, (ts: string) => void] {
  const [seen, setSeen] = React.useState<string | null>(() => readStored())

  const markSeen = React.useCallback((ts: string) => {
    setSeen((prev) => {
      if (prev && prev >= ts) return prev
      writeStored(ts)
      return ts
    })
  }, [])

  return [seen, markSeen]
}

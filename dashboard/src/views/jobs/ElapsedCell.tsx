import * as React from "react"
import { elapsedSeconds, formatDuration } from "@/lib/format"

const TICK_INTERVAL_MS = 1000

/**
 * Live elapsed time for a job. Owns its own 1s ticker so a running clock never
 * re-renders the surrounding table — only this cell changes each second.
 */
export function ElapsedCell({ since }: { since: string | null | undefined }) {
  const [, tick] = React.useReducer((n: number) => n + 1, 0)

  React.useEffect(() => {
    const id = setInterval(() => tick(), TICK_INTERVAL_MS)
    return () => clearInterval(id)
  }, [])

  return (
    <span className="font-mono text-xs tabular-nums">
      {formatDuration(elapsedSeconds(since))}
    </span>
  )
}

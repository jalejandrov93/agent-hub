import * as React from "react"
import { formatAge } from "@/lib/format"

const TICK_INTERVAL_MS = 1000

/** Renders `formatAge(iso)` and re-renders itself every second, without a parent re-render. */
export function RelativeTime({ iso, className }: { iso: string | null | undefined; className?: string }) {
  const [, forceTick] = React.useReducer((n: number) => n + 1, 0)

  React.useEffect(() => {
    const id = setInterval(() => forceTick(), TICK_INTERVAL_MS)
    return () => clearInterval(id)
  }, [])

  return (
    <time dateTime={iso ?? undefined} className={className}>
      {formatAge(iso)}
    </time>
  )
}

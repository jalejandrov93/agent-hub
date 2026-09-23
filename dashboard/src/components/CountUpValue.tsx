import * as React from "react"

export interface CountUpValueProps {
  value: number
  duration?: number
  format?: (value: number) => React.ReactNode
  formatter?: (value: number) => React.ReactNode
  className?: string
}

function getReducedMotion(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches
}

export function CountUpValue({
  value,
  duration = 400,
  format,
  formatter,
  className,
}: CountUpValueProps) {
  const isReduced = getReducedMotion()
  const [displayValue, setDisplayValue] = React.useState<number>(() =>
    isReduced ? value : 0
  )
  const currentValRef = React.useRef<number>(isReduced ? value : 0)
  const prevTargetRef = React.useRef<number | null>(null)
  const rafRef = React.useRef<number | null>(null)

  React.useEffect(() => {
    if (getReducedMotion()) {
      setDisplayValue(value)
      currentValRef.current = value
      prevTargetRef.current = value
      return
    }

    // SSE churn protection: identical value does not retrigger animation
    if (prevTargetRef.current === value) return

    const start = currentValRef.current
    const target = value
    prevTargetRef.current = value

    if (start === target) {
      setDisplayValue(target)
      return
    }

    let startTime: number | null = null
    const step = (timestamp: number) => {
      if (startTime === null) startTime = timestamp
      const elapsed = timestamp - startTime
      const progress = Math.min(elapsed / duration, 1)
      const eased = 1 - Math.pow(1 - progress, 3)
      const current = start + (target - start) * eased

      currentValRef.current = progress === 1 ? target : current
      setDisplayValue(progress === 1 ? target : current)

      if (progress < 1) {
        rafRef.current = requestAnimationFrame(step)
      }
    }

    rafRef.current = requestAnimationFrame(step)
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
    }
  }, [value, duration])

  const formatFn = format ?? formatter
  const formatted = formatFn ? formatFn(displayValue) : Math.round(displayValue)

  return (
    <span className={`tabular-nums ${className ?? ""}`.trim()}>{formatted}</span>
  )
}

export default CountUpValue

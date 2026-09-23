import * as React from "react"
import LetterGlitch from "@/components/reactbits/LetterGlitch"
import { useTheme, type ThemeChoice } from "@/components/theme-provider"

// Monochromatic token-adjacent palettes (zinc/neutral spectrum) matching
// light and dark mode foreground/muted/border tokens without raw color classes.
const LIGHT_PALETTE = ["#27272a", "#52525b", "#71717a"]
const DARK_PALETTE = ["#e4e4e7", "#a1a1aa", "#71717a"]

const DEFAULT_CHARACTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ!@#$&*()-_+=/[]{};:<>.,0123456789"

function usePrefersReducedMotion(): boolean {
  const [reducedMotion, setReducedMotion] = React.useState(() => {
    if (typeof window === "undefined" || !window.matchMedia) return false
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches
  })

  React.useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return
    const mql = window.matchMedia("(prefers-reduced-motion: reduce)")
    const onChange = (e: MediaQueryListEvent) => setReducedMotion(e.matches)
    if (mql.addEventListener) {
      mql.addEventListener("change", onChange)
      return () => mql.removeEventListener("change", onChange)
    } else if (mql.addListener) {
      mql.addListener(onChange)
      return () => mql.removeListener(onChange)
    }
  }, [])

  return reducedMotion
}

function useIsDark(theme: ThemeChoice): boolean {
  const [systemDark, setSystemDark] = React.useState(() => {
    if (typeof window === "undefined" || !window.matchMedia) return false
    return window.matchMedia("(prefers-color-scheme: dark)").matches
  })

  React.useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return
    const mql = window.matchMedia("(prefers-color-scheme: dark)")
    const onChange = (e: MediaQueryListEvent) => setSystemDark(e.matches)
    if (mql.addEventListener) {
      mql.addEventListener("change", onChange)
      return () => mql.removeEventListener("change", onChange)
    } else if (mql.addListener) {
      mql.addListener(onChange)
      return () => mql.removeListener(onChange)
    }
  }, [])

  if (theme === "dark") return true
  if (theme === "light") return false
  return systemDark
}

function StaticLetterCanvas({
  glitchColors,
  characters = DEFAULT_CHARACTERS,
}: {
  glitchColors: string[]
  characters?: string
}) {
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null)

  React.useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext("2d")
    if (!ctx) return // Guard against null context in test runners (happy-dom)

    const drawFrame = () => {
      const parent = canvas.parentElement
      if (!parent) return

      const dpr = window.devicePixelRatio || 1
      const rect = parent.getBoundingClientRect()
      canvas.width = rect.width * dpr
      canvas.height = rect.height * dpr
      canvas.style.width = `${rect.width}px`
      canvas.style.height = `${rect.height}px`
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

      const fontSize = 16
      const charWidth = 10
      const charHeight = 20
      const cols = Math.ceil(rect.width / charWidth)
      const rows = Math.ceil(rect.height / charHeight)

      ctx.clearRect(0, 0, rect.width, rect.height)
      ctx.font = `${fontSize}px monospace`
      ctx.textBaseline = "top"

      const chars = Array.from(characters)
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const char = chars[Math.floor(Math.random() * chars.length)]
          const color = glitchColors[Math.floor(Math.random() * glitchColors.length)]
          ctx.fillStyle = color
          ctx.fillText(char, c * charWidth, r * charHeight)
        }
      }
    }

    drawFrame()
    window.addEventListener("resize", drawFrame)
    return () => window.removeEventListener("resize", drawFrame)
  }, [glitchColors, characters])

  return (
    <div
      className="relative w-full h-full overflow-hidden"
      style={{ backgroundColor: "transparent" }}
    >
      <canvas ref={canvasRef} className="block w-full h-full" />
    </div>
  )
}

function useSafeTheme(): ThemeChoice {
  try {
    return useTheme().theme
  } catch {
    return "dark"
  }
}

export function AppBackground() {
  const theme = useSafeTheme()
  const isDark = useIsDark(theme)
  const reducedMotion = usePrefersReducedMotion()
  const palette = isDark ? DARK_PALETTE : LIGHT_PALETTE

  return (
    <div
      data-testid="app-background"
      className="absolute inset-0 -z-10 pointer-events-none"
      aria-hidden="true"
      style={{ opacity: 0.08 }}
    >
      {reducedMotion ? (
        <StaticLetterCanvas
          key={theme}
          glitchColors={palette}
          characters={DEFAULT_CHARACTERS}
        />
      ) : (
        <LetterGlitch
          key={theme}
          glitchColors={palette}
          glitchSpeed={250}
          centerVignette={false}
          outerVignette={false}
          smooth={true}
          characters={DEFAULT_CHARACTERS}
          backgroundColor="transparent"
        />
      )}
    </div>
  )
}

export default AppBackground

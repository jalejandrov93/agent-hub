import * as React from "react"

/**
 * Local theme provider. No next-themes: toggles the `dark` class on
 * <html> and sets `color-scheme` via the CSSOM (React `style`/`className`,
 * never a `<style>` element — the dashboard's CSP is `style-src 'self'`
 * with no nonce, so no inline pre-paint script and no injected stylesheet).
 * Choice persists to localStorage under `agent-hub:theme`; storage access is
 * wrapped in try/catch because it can throw (private browsing, blocked
 * site data) and a failure here must never break rendering.
 */

export type ThemeChoice = "system" | "light" | "dark"

const STORAGE_KEY = "agent-hub:theme"

type ThemeContextValue = {
  theme: ThemeChoice
  setTheme: (theme: ThemeChoice) => void
}

const ThemeContext = React.createContext<ThemeContextValue | undefined>(
  undefined
)

function readStoredTheme(): ThemeChoice {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY)
    if (value === "light" || value === "dark" || value === "system") {
      return value
    }
  } catch {
    // storage unavailable — fall back to system
  }
  return "system"
}

function writeStoredTheme(theme: ThemeChoice) {
  try {
    window.localStorage.setItem(STORAGE_KEY, theme)
  } catch {
    // ignore: theme just won't persist across reloads
  }
}

function systemPrefersDark(): boolean {
  return window.matchMedia("(prefers-color-scheme: dark)").matches
}

function applyTheme(theme: ThemeChoice) {
  const root = document.documentElement
  const isDark = theme === "dark" || (theme === "system" && systemPrefersDark())
  root.classList.toggle("dark", isDark)
  root.style.colorScheme = isDark ? "dark" : "light"
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = React.useState<ThemeChoice>(() =>
    readStoredTheme()
  )

  React.useEffect(() => {
    applyTheme(theme)
    writeStoredTheme(theme)
    if (theme !== "system") return
    const mql = window.matchMedia("(prefers-color-scheme: dark)")
    const onChange = () => applyTheme("system")
    mql.addEventListener("change", onChange)
    return () => mql.removeEventListener("change", onChange)
  }, [theme])

  const setTheme = React.useCallback((next: ThemeChoice) => {
    setThemeState(next)
  }, [])

  const value = React.useMemo(() => ({ theme, setTheme }), [theme, setTheme])

  return (
    <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
  )
}

export function useTheme(): ThemeContextValue {
  const ctx = React.useContext(ThemeContext)
  if (!ctx) throw new Error("useTheme must be used within a ThemeProvider")
  return ctx
}

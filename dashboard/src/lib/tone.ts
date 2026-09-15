/**
 * Shared semantic tone vocabulary. Every place that colors a status —
 * StatusBadge, sidebar badges, KPI cards — maps through this single table so
 * "destructive" always looks the same shade of red everywhere, using the
 * theme's CSS custom properties (never a raw color utility).
 */

export type Tone = "ready" | "running" | "warning" | "destructive" | "muted"

export const TONE_BADGE_CLASS: Record<Tone, string> = {
  ready: "bg-success/10 text-success dark:bg-success/20",
  running: "bg-primary/10 text-primary dark:bg-primary/20",
  warning: "bg-warning/10 text-warning dark:bg-warning/20",
  destructive: "bg-destructive/10 text-destructive dark:bg-destructive/20",
  muted: "bg-muted text-muted-foreground",
}

export const TONE_DOT_CLASS: Record<Tone, string> = {
  ready: "bg-success",
  running: "bg-primary",
  warning: "bg-warning",
  destructive: "bg-destructive",
  muted: "bg-muted-foreground",
}

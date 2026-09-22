/**
 * The subset of DiffStatsT this badge actually reads. Loose on purpose so a
 * caller can pass either the full server shape or a minimal test fixture.
 */
export type DiffStatsSummaryInput = {
  additions: number | null
  deletions: number | null
  filesChanged: number | null
  error?: string | null
} | null

/**
 * GitHub-style `+X −Y · N files` badge, colored like GitHub (additions in
 * the success tone, deletions in the destructive tone via semantic tokens,
 * never a raw color utility — see dashboard/AGENTS.md). Renders nothing for
 * a read-mode job or a job with no baseline (`stats` is null), and an em
 * dash for a degraded/errored computation instead of misleading zeros.
 */
export function DiffStatsSummary({ stats }: { stats: DiffStatsSummaryInput }) {
  if (!stats) return null

  if (stats.additions == null || stats.deletions == null || stats.filesChanged == null) {
    return (
      <span className="font-mono text-xs text-muted-foreground" title={stats.error ?? undefined}>
        —
      </span>
    )
  }

  const fileWord = stats.filesChanged === 1 ? "file" : "files"

  return (
    <span className="flex items-center gap-1 font-mono text-xs whitespace-nowrap">
      <span className="text-success">+{stats.additions}</span>
      <span className="text-destructive">&minus;{stats.deletions}</span>
      <span className="text-muted-foreground">
        · {stats.filesChanged} {fileWord}
      </span>
    </span>
  )
}

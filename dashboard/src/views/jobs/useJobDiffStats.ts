import { useQuery } from "@tanstack/react-query"
import { getJobDiffStats } from "@/lib/api"

const DIFF_STATS_REFETCH_INTERVAL_MS = 5000

/**
 * Live diff stats for one write-mode job. `enabled` should be false for a
 * read-mode job (the server always answers `{ diffStats: null }` for one,
 * but there is no point polling it) — mirrors useJobResultQuery's shape.
 * Server-side this hits GET /api/jobs/:id/diff-stats, which itself reads
 * the persisted snapshot for a terminal job or computes-and-caches a live
 * one for a still-running job (see src/jobrunner.mjs's getJobDiffStats).
 */
export function useJobDiffStatsQuery(jobId: string | null, enabled: boolean) {
  return useQuery({
    queryKey: ["jobs", jobId, "diff-stats"],
    queryFn: () => getJobDiffStats(jobId as string),
    enabled: enabled && Boolean(jobId),
    refetchInterval: enabled && jobId ? DIFF_STATS_REFETCH_INTERVAL_MS : false,
  })
}

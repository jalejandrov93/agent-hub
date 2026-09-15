import { useQuery } from "@tanstack/react-query"
import { JobResultResponse } from "@shared"
import { fetchJson } from "@/lib/api"

export const MAX_LINES = 40
export const TAIL_LINES = 20
const RESULT_REFETCH_INTERVAL_MS = 5000

/**
 * Live partial output for one job. `enabled` maps to the detail sheet being
 * open; while true the query polls every 5s so a running job's output grows in
 * place. The query lives here (not in lib/queries.ts) because it is only ever
 * consumed by this view.
 */
export function useJobResultQuery(jobId: string | null, enabled: boolean) {
  return useQuery({
    queryKey: ["jobs", jobId, "result"],
    queryFn: () =>
      fetchJson(
        JobResultResponse,
        `/api/jobs/${encodeURIComponent(jobId as string)}/result?maxLines=${MAX_LINES}&tailLines=${TAIL_LINES}`
      ),
    enabled: enabled && Boolean(jobId),
    refetchInterval: enabled && jobId ? RESULT_REFETCH_INTERVAL_MS : false,
  })
}

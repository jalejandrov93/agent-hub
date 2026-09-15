import { ScrollArea } from "@/components/ui/scroll-area"
import { Skeleton } from "@/components/ui/skeleton"
import { MAX_LINES, TAIL_LINES, useJobResultQuery } from "./useJobResult"

export function JobResultPanel({ jobId, open }: { jobId: string; open: boolean }) {
  const result = useJobResultQuery(jobId, open)

  if (result.isPending) {
    return <Skeleton className="h-40 w-full" />
  }

  if (result.isError || !result.data) {
    return <p className="text-sm text-destructive">Could not load the job output.</p>
  }

  const data = result.data
  // Mirrors the server's line math (jobResultTool): when the tail is truncated
  // the gap between the head and tail is exactly totalLines - head - tail.
  const omitted = data.tailTruncated
    ? Math.max(0, (data.totalLines ?? 0) - MAX_LINES - TAIL_LINES)
    : 0

  return (
    <div className="flex flex-col gap-2">
      <pre className="max-h-48 overflow-auto rounded-md border bg-muted p-3 font-mono text-xs whitespace-pre-wrap">
        {data.text || "No output yet."}
      </pre>
      {data.tailTruncated ? (
        <p className="text-center text-xs text-muted-foreground">… {omitted} lines omitted …</p>
      ) : null}
      {data.tail ? (
        <ScrollArea className="h-48 rounded-md border">
          <pre className="p-3 font-mono text-xs whitespace-pre-wrap">{data.tail}</pre>
        </ScrollArea>
      ) : null}
    </div>
  )
}

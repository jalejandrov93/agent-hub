import * as React from "react"
import { useCloudSessionsQuery, useCloudJobActivitiesQuery, useCheckCloudJobMutation } from "@/lib/queries"
import { DataTable, type DataTableColumn } from "@/components/DataTable"
import { Button } from "@/components/ui/button"
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet"
import { Skeleton } from "@/components/ui/skeleton"
import { StatusBadge } from "@/components/StatusBadge"
import { RefreshCw } from "lucide-react"
import type { CloudSession } from "@/lib/types"

/** Jules session states arrive UPPERCASE from the API; map the ones with an obvious job-status analog. */
function statusBadgeValue(state: string): string {
  switch (state) {
    case "COMPLETED":
      return "succeeded"
    case "FAILED":
      return "failed"
    case "IN_PROGRESS":
      return "running"
    case "QUEUED":
      return "queued"
    case "PAUSED":
      return "canceled"
    default:
      // PLANNING, AWAITING_PLAN_APPROVAL, AWAITING_USER_FEEDBACK, UNKNOWN: no
      // exact analog — StatusBadge falls back to a plain muted badge.
      return state
  }
}

function SessionActivitySheet({
  session,
  isOpen,
  onClose
}: {
  session: CloudSession | null
  isOpen: boolean
  onClose: () => void
}) {
  const { data, isLoading } = useCloudJobActivitiesQuery(session?.jobId ?? null)
  const checkMut = useCheckCloudJobMutation()

  return (
    <Sheet open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-full sm:max-w-xl overflow-y-auto flex flex-col">
        <SheetHeader>
          <SheetTitle>Session Activities</SheetTitle>
          <SheetDescription>{session?.title ?? session?.sessionId ?? ""}</SheetDescription>
        </SheetHeader>

        {session?.jobId && (
          <div className="py-4">
            <Button
              variant="outline"
              onClick={() => checkMut.mutate(session.jobId!)}
              disabled={checkMut.isPending}
            >
              <RefreshCw className="size-4 mr-2" />
              Check now
            </Button>
          </div>
        )}

        <div className="flex-1 overflow-y-auto py-4 pr-2">
          {isLoading ? (
            <div className="space-y-4">
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
            </div>
          ) : !data || data.activities.length === 0 ? (
            <div className="text-center text-muted-foreground py-8">No activities found.</div>
          ) : (
            <div className="space-y-2">
              {data.activities.map((activity, index) => (
                <div key={index} className="text-sm whitespace-pre-wrap">
                  {activity}
                </div>
              ))}
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}

export function SessionsTab() {
  const { data, isLoading } = useCloudSessionsQuery()
  const [selectedSession, setSelectedSession] = React.useState<CloudSession | null>(null)

  if (isLoading || !data) {
    return <Skeleton className="h-64 w-full" />
  }

  const columns: DataTableColumn<CloudSession>[] = [
    {
      key: "state",
      header: "State",
      cell: (row) => <StatusBadge kind="status" value={statusBadgeValue(row.state)} />,
    },
    {
      key: "title",
      header: "Title",
      cell: (row) => <div className="font-medium">{row.title ?? <span className="text-muted-foreground">Untitled</span>}</div>,
    },
    {
      key: "branch",
      header: "Branch",
      cell: (row) => row.branch ? <div className="text-muted-foreground">{row.branch}</div> : <span className="text-muted-foreground">-</span>,
    },
    {
      key: "pr",
      header: "Pull Request",
      cell: (row) => row.prUrl ? (
        <a href={row.prUrl} target="_blank" rel="noopener noreferrer" className="text-blue-500 hover:underline" onClick={(e) => e.stopPropagation()}>
          View PR
        </a>
      ) : <span className="text-muted-foreground">-</span>,
    },
    {
      key: "account",
      header: "Account",
      cell: (row) => row.accountId ? <div className="font-mono text-xs">{row.accountId}</div> : <span className="text-muted-foreground">-</span>,
    },
    {
      key: "localJob",
      header: "Local Job",
      cell: (row) => row.jobId ? (
        <div className="font-mono text-xs">{row.jobId.slice(0, 8)}</div>
      ) : <span className="text-muted-foreground">-</span>,
    }
  ]

  return (
    <div className="flex flex-col gap-4">
      <SessionActivitySheet
        session={selectedSession}
        isOpen={selectedSession !== null}
        onClose={() => setSelectedSession(null)}
      />
      <DataTable
        columns={columns}
        rows={data.sessions}
        getRowId={(row) => row.sessionId ?? row.jobId ?? row.sessionUrl ?? row.createTime ?? `${row.title ?? ""}-${row.branch ?? ""}`}
        onRowClick={(row) => setSelectedSession(row)}
      />
    </div>
  )
}

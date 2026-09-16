import * as React from "react"
import { useCloudSessionsQuery, useCloudJobActivitiesQuery, useCheckCloudJobMutation } from "@/lib/queries"
import { DataTable, type DataTableColumn } from "@/components/DataTable"
import { Button } from "@/components/ui/button"
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet"
import { Skeleton } from "@/components/ui/skeleton"
import { StatusBadge } from "@/components/StatusBadge"
import { RelativeTime } from "@/components/RelativeTime"
import { RefreshCw } from "lucide-react"
import type { CloudSession } from "@/lib/types"

function SessionActivitySheet({
  session,
  isOpen,
  onClose
}: {
  session: CloudSession | null
  isOpen: boolean
  onClose: () => void
}) {
  const { data, isLoading } = useCloudJobActivitiesQuery(session?.id ?? null)
  const checkMut = useCheckCloudJobMutation()

  return (
    <Sheet open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-full sm:max-w-xl overflow-y-auto flex flex-col">
        <SheetHeader>
          <SheetTitle>Session Activities</SheetTitle>
          <SheetDescription>{session?.title}</SheetDescription>
        </SheetHeader>

        {session && (
          <div className="py-4">
            <Button
              variant="outline"
              onClick={() => checkMut.mutate(session.id)}
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
          ) : data?.activities.length === 0 ? (
            <div className="text-center text-muted-foreground py-8">No activities found.</div>
          ) : (
            <div className="space-y-4">
              {data?.activities.map((act) => (
                <div key={act.id} className="text-sm">
                  <div className="text-muted-foreground text-xs mb-1">
                    <RelativeTime iso={act.ts} />
                  </div>
                  <div className="whitespace-pre-wrap">{act.message}</div>
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
      cell: (row) => <StatusBadge kind="status" value={row.state === "completed" ? "succeeded" : row.state} />,
    },
    {
      key: "title",
      header: "Title",
      cell: (row) => <div className="font-medium">{row.title}</div>,
    },
    {
      key: "branch",
      header: "Branch",
      cell: (row) => <div className="text-muted-foreground">{row.branch}</div>,
    },
    {
      key: "pr",
      header: "Pull Request",
      cell: (row) => row.pullRequestLink ? (
        <a href={row.pullRequestLink} target="_blank" rel="noopener noreferrer" className="text-blue-500 hover:underline" onClick={(e) => e.stopPropagation()}>
          View PR
        </a>
      ) : <span className="text-muted-foreground">-</span>,
    },
    {
      key: "localJob",
      header: "Local Job",
      cell: (row) => row.localJobId ? (
        <div className="font-mono text-xs">{row.localJobId.slice(0, 8)}</div>
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
        getRowId={(row) => row.id}
        onRowClick={(row) => setSelectedSession(row)}
      />
    </div>
  )
}

import { Wrench } from "lucide-react"
import { EmptyState } from "@/components/EmptyState"
import { DataTable, type DataTableColumn } from "@/components/DataTable"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { useToolsQuery } from "@/lib/queries"
import { formatNumber } from "@/lib/format"
import type { McpToolT } from "@/lib/types"

const columns: DataTableColumn<McpToolT>[] = [
  {
    key: "name",
    header: "Name",
    cell: (row) => <span className="font-medium">{row.name}</span>,
  },
  {
    key: "title",
    header: "Title",
    cell: (row) => row.title,
  },
  {
    key: "description",
    header: "Description",
    cell: (row) => (
      <span className="block max-w-[36rem] truncate" title={row.description}>
        {row.description}
      </span>
    ),
  },
]

export function ToolsTab() {
  const toolsQuery = useToolsQuery()
  const tools = toolsQuery.data?.tools ?? []
  const sortedTools = [...tools].sort((a, b) => a.name.localeCompare(b.name))

  return (
    <div className="flex flex-col gap-6">
      {toolsQuery.isPending ? (
        <div className="flex flex-col gap-4">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-48 w-full" />
        </div>
      ) : toolsQuery.isError ? (
        <Alert variant="destructive">
          <AlertTitle>Unable to load tools</AlertTitle>
          <AlertDescription>{toolsQuery.error.message}</AlertDescription>
        </Alert>
      ) : sortedTools.length === 0 ? (
        <EmptyState
          icon={Wrench}
          title="No tools registered"
          description="The server reported an empty tool list."
        />
      ) : (
        <>
          <div className="grid gap-4 md:grid-cols-3">
            <Card>
              <CardHeader>
                <CardTitle>Total tools</CardTitle>
              </CardHeader>
              <CardContent className="text-2xl font-semibold tabular-nums">
                {formatNumber(sortedTools.length)}
              </CardContent>
            </Card>
          </div>

          <DataTable
            columns={columns}
            rows={sortedTools}
            getRowId={(row) => row.name}
          />
        </>
      )}
    </div>
  )
}

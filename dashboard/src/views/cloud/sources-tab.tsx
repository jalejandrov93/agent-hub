import { useSourcesQuery, useAccountsQuery } from "@/lib/queries"
import { DataTable, type DataTableColumn } from "@/components/DataTable"
import { Skeleton } from "@/components/ui/skeleton"
import { Alert, AlertDescription } from "@/components/ui/alert"
import type { CloudSource } from "@/lib/types"

export function SourcesTab() {
  const { data: sourcesData, isLoading: sourcesLoading } = useSourcesQuery()
  const { data: accountsData, isLoading: accountsLoading } = useAccountsQuery()

  if (sourcesLoading || accountsLoading || !sourcesData || !accountsData) {
    return <Skeleton className="h-64 w-full" />
  }

  const noAccessAccounts = accountsData.accounts.filter((a) => a.sourceStatus === "no_source_access")

  const columns: DataTableColumn<CloudSource>[] = [
    {
      key: "repo",
      header: "Repository",
      cell: (row) => <div className="font-medium">{row.repo}</div>,
    },
    {
      key: "defaultBranch",
      header: "Default Branch",
      cell: (row) => <div>{row.defaultBranch}</div>,
    },
    {
      key: "branches",
      header: "Branches",
      cell: (row) => (
        <div className="text-muted-foreground truncate max-w-xs" title={row.branches.join(", ")}>
          {row.branches.join(", ")}
        </div>
      ),
    },
    {
      key: "accounts",
      header: "Accounts",
      cell: (row) => {
        const accountLabels = row.accounts
          .map((id) => accountsData.accounts.find((a) => a.id === id)?.label || id)
          .join(", ")
        return <div className="truncate max-w-xs" title={accountLabels}>{accountLabels}</div>
      },
    }
  ]

  return (
    <div className="flex flex-col gap-4">
      <Alert>
        <AlertDescription>
          Repositories are connected in the Jules web UI. You cannot add them here.
        </AlertDescription>
      </Alert>

      {noAccessAccounts.length > 0 && (
        <Alert>
          <AlertDescription>
            The following accounts are healthy but cannot list sources (they have no source access): {noAccessAccounts.map(a => a.label).join(", ")}
          </AlertDescription>
        </Alert>
      )}

      <DataTable columns={columns} rows={sourcesData.sources} getRowId={(row) => row.id} />
    </div>
  )
}

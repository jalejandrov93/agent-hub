import { RefreshCw } from "lucide-react"
import { useQueryClient } from "@tanstack/react-query"
import { SidebarTrigger } from "@/components/ui/sidebar"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { ThemeToggle } from "@/components/theme-toggle"
import { RelativeTime } from "@/components/RelativeTime"
import { useConnection } from "@/lib/sse"
import { useStateQuery } from "@/lib/queries"
import { qk } from "@/lib/query-keys"
import { cn } from "@/lib/utils"
import type { Connection } from "@/lib/types"

const CONN_LABEL: Record<Connection, string> = {
  connecting: "Connecting…",
  live: "Live",
  reconnecting: "Reconnecting…",
  offline: "Offline",
}

const CONN_CLASS: Record<Connection, string> = {
  connecting: "bg-muted text-muted-foreground",
  live: "bg-success/10 text-success dark:bg-success/20",
  reconnecting: "bg-warning/10 text-warning dark:bg-warning/20",
  offline: "bg-destructive/10 text-destructive dark:bg-destructive/20",
}

export function Topbar({ title }: { title: string }) {
  const { connection } = useConnection()
  const queryClient = useQueryClient()

  function refresh() {
    queryClient.invalidateQueries({ queryKey: qk.state })
    queryClient.invalidateQueries({ queryKey: qk.config })
  }

  return (
    <header className="flex h-14 shrink-0 items-center gap-2 border-b bg-background px-4">
      <SidebarTrigger className="-ml-1" />
      <h2 className="min-w-0 flex-1 truncate text-sm font-medium">{title}</h2>
      <div className="flex items-center gap-2">
        <Badge variant="outline" className={cn("border-transparent", CONN_CLASS[connection])}>
          {CONN_LABEL[connection]}
        </Badge>
        <LastUpdated />
        <Button id="btn-refresh" variant="ghost" size="sm" onClick={refresh}>
          <RefreshCw data-icon="inline-start" />
          Refresh
        </Button>
        <ThemeToggle />
      </div>
    </header>
  )
}

function LastUpdated() {
  const { dataUpdatedAt } = useStateQuery()

  if (!dataUpdatedAt) {
    return <span className="hidden text-xs text-muted-foreground sm:inline">updated —</span>
  }

  return (
    <span className="hidden text-xs text-muted-foreground sm:inline">
      updated <RelativeTime iso={new Date(dataUpdatedAt).toISOString()} />
    </span>
  )
}

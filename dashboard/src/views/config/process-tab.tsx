import { AlertTriangle, RefreshCw } from "lucide-react"
import type { ConfigResponseT } from "@/lib/types"
import { useRefreshDiscoveryMutation } from "@/lib/queries"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert"
import {
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
} from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { toast } from "@/components/ui/toast"

export function ProcessTab({ config }: { config: ConfigResponseT }) {
  const proc = config.process || {
    pid: 0,
    nodeVersion: "—",
    platform: "—",
    pathEntries: [],
    resolvedBins: {},
  }

  const refreshDiscovery = useRefreshDiscoveryMutation()

  const resolvedBinsEntries = Object.entries(proc.resolvedBins || {})
  const unresolved = resolvedBinsEntries.filter(([_, binPath]) => binPath === null)

  const handleRediscover = () => {
    refreshDiscovery.mutate(undefined, {
      onSuccess: () => {
        toast.add({
          title: "Discovery refreshed",
          description: "CLI binaries and models rediscovery complete.",
          type: "success",
        })
      },
      onError: (err) => {
        toast.add({
          title: "Discovery failed",
          description: err instanceof Error ? err.message : "Failed to refresh discovery",
          type: "error",
        })
      },
    })
  }

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between pb-2">
          <CardTitle>Dashboard process</CardTitle>
          <Button
            size="sm"
            disabled={refreshDiscovery.isPending}
            onClick={handleRediscover}
          >
            {refreshDiscovery.isPending ? (
              <Spinner data-icon="inline-start" />
            ) : (
              <RefreshCw data-icon="inline-start" />
            )}
            Rediscover CLIs
          </Button>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-1 gap-x-4 gap-y-2 sm:grid-cols-3">
            <div>
              <dt className="text-xs text-muted-foreground">PID</dt>
              <dd className="font-mono text-sm">{proc.pid != null ? proc.pid : "—"}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Node version</dt>
              <dd className="font-mono text-sm">{proc.nodeVersion || "—"}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Platform</dt>
              <dd className="font-mono text-sm">{proc.platform || "—"}</dd>
            </div>
          </dl>
        </CardContent>
      </Card>

      {unresolved.length > 0 ? (
        <Alert role="alert" className="border-warning/50 text-warning">
          <AlertTriangle className="size-4" />
          <AlertTitle>Unresolved CLI binary</AlertTitle>
          <AlertDescription>
            The following agent CLIs could not be resolved on PATH:{" "}
            <span className="font-medium">
              {unresolved.map(([agent]) => agent).join(", ")}
            </span>
            .
          </AlertDescription>
        </Alert>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Resolved CLI binaries</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="overflow-hidden rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Agent</TableHead>
                  <TableHead>Resolved bin</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {resolvedBinsEntries.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={2} className="h-16 text-center text-muted-foreground">
                      No resolved binaries reported.
                    </TableCell>
                  </TableRow>
                ) : (
                  resolvedBinsEntries.map(([agent, binPath]) => (
                    <TableRow key={agent}>
                      <TableCell className="font-medium">{agent}</TableCell>
                      <TableCell>
                        {binPath ? (
                          <span className="font-mono text-xs text-muted-foreground">
                            {binPath}
                          </span>
                        ) : (
                          <Badge variant="destructive" className="text-[10px]">
                            not found
                          </Badge>
                        )}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Process PATH</CardTitle>
        </CardHeader>
        <CardContent>
          {(proc.pathEntries || []).length === 0 ? (
            <p className="text-sm text-muted-foreground">PATH is empty for this process.</p>
          ) : (
            <ul className="flex flex-col gap-1">
              {(proc.pathEntries || []).map((entry, i) => (
                <li
                  key={`${entry}-${i}`}
                  className="rounded-md bg-muted/40 px-2 py-1 font-mono text-xs text-muted-foreground"
                >
                  {entry}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table"

export type DiffStatsTableFile = {
  path: string
  additions: number | null
  deletions: number | null
  binary: boolean
}

/**
 * Per-file diff table for a job's detail view. `truncated` mirrors the
 * server's per-file list cap (see src/diffstats.mjs) — the file COUNT shown
 * elsewhere (DiffStatsSummary) always reflects the true total even when
 * this table's row list was capped.
 */
export function DiffStatsTable({
  files,
  truncated,
}: {
  files: DiffStatsTableFile[]
  truncated: boolean
}) {
  if (files.length === 0) {
    return <p className="text-sm text-muted-foreground">No file changes measured.</p>
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="max-h-64 overflow-auto rounded-md border">
        <Table>
          <TableHeader className="sticky top-0 z-10 bg-card">
            <TableRow>
              <TableHead>File</TableHead>
              <TableHead className="text-right">+</TableHead>
              <TableHead className="text-right">&minus;</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {files.map((file) => (
              <TableRow key={file.path}>
                <TableCell className="max-w-[22rem] truncate font-mono text-xs" title={file.path}>
                  {file.path}
                </TableCell>
                {file.binary ? (
                  <TableCell colSpan={2} className="text-right text-xs text-muted-foreground">
                    binary
                  </TableCell>
                ) : (
                  <>
                    <TableCell className="text-right font-mono text-xs text-success">
                      {file.additions ?? "—"}
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs text-destructive">
                      {file.deletions ?? "—"}
                    </TableCell>
                  </>
                )}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      {truncated ? (
        <p className="text-xs text-muted-foreground">File list truncated — showing the first {files.length} files.</p>
      ) : null}
    </div>
  )
}

import * as React from "react"
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table"
import { cn } from "@/lib/utils"

export type DataTableColumn<T> = {
  key: string
  header: React.ReactNode
  cell: (row: T) => React.ReactNode
  className?: string
}

export type DataTableProps<T> = {
  columns: DataTableColumn<T>[]
  rows: T[]
  getRowId: (row: T) => string
  onRowClick?: (row: T) => void
  emptyMessage?: React.ReactNode
}

/**
 * A shadcn Table with a sticky header and, when `onRowClick` is given,
 * keyboard-focusable rows (Enter/Space activate, same as a click).
 */
export function DataTable<T>({
  columns,
  rows,
  getRowId,
  onRowClick,
  emptyMessage = "No rows to show.",
}: DataTableProps<T>) {
  return (
    <div className="max-h-[70vh] overflow-auto rounded-md border">
      <Table>
        <TableHeader className="sticky top-0 z-10 bg-card">
          <TableRow>
            {columns.map((column) => (
              <TableHead key={column.key} className={column.className}>
                {column.header}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.length === 0 ? (
            <TableRow>
              <TableCell colSpan={columns.length} className="h-24 text-center text-muted-foreground">
                {emptyMessage}
              </TableCell>
            </TableRow>
          ) : (
            rows.map((row) => {
              const id = getRowId(row)
              const clickable = Boolean(onRowClick)
              return (
                <TableRow
                  key={id}
                  className={cn(clickable && "cursor-pointer")}
                  tabIndex={clickable ? 0 : undefined}
                  onClick={clickable ? () => onRowClick?.(row) : undefined}
                  onKeyDown={
                    clickable
                      ? (event) => {
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault()
                            onRowClick?.(row)
                          }
                        }
                      : undefined
                  }
                >
                  {columns.map((column) => (
                    <TableCell key={column.key} className={column.className}>
                      {column.cell(row)}
                    </TableCell>
                  ))}
                </TableRow>
              )
            })
          )}
        </TableBody>
      </Table>
    </div>
  )
}

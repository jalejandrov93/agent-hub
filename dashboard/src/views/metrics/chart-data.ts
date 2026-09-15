import type { MetricsRowT } from "@/lib/types"

export type MetricsChartRow = MetricsRowT & {
  name: string
  successRatePct: number
  fillOpacity: number
}

export function mapMetricsChartRows(rows: MetricsRowT[]): MetricsChartRow[] {
  return [...rows]
    .sort((a, b) => (b.successRate ?? -1) - (a.successRate ?? -1))
    .map((row) => ({
      ...row,
      name: `${row.agent}:${row.model}${row.mode === "write" ? " (write)" : ""}`,
      successRatePct: row.successRate == null ? 0 : row.successRate * 100,
      fillOpacity: row.samples < 10 ? 0.45 : 1,
    }))
}

export function chartHeightClass(rowCount: number) {
  const height = Math.min(480, 40 + rowCount * 28)
  if (height <= 192) return "h-48"
  if (height <= 256) return "h-64"
  if (height <= 320) return "h-80"
  if (height <= 384) return "h-96"
  return "h-[28rem]"
}

import { breakerFor, overrideFor, isUnhealthy } from "@/lib/badges"
import type { AgentRow, DerivedState } from "@/lib/types"

export type AgentFilter = "all" | "unhealthy" | "held" | "breaker"

export function matchesFilter(state: DerivedState, row: AgentRow, filter: AgentFilter): boolean {
  if (filter === "unhealthy") return isUnhealthy(state, row)
  if (filter === "held") return overrideFor(state, row.agent, row.model)?.hold === true
  if (filter === "breaker") return breakerFor(state, row.agent, row.model)?.open === true
  return true
}

export function matchesSearch(row: AgentRow, query: string): boolean {
  if (!query) return true
  const needle = query.toLowerCase()
  const haystack = [row.agent, row.model, row.reason ?? ""].join(" ").toLowerCase()
  return haystack.includes(needle)
}

export type AgentGroup = { agent: string; rows: AgentRow[] }

export function groupByCli(rows: AgentRow[]): AgentGroup[] {
  const order: string[] = []
  const groups = new Map<string, AgentRow[]>()
  for (const row of rows) {
    const bucket = groups.get(row.agent)
    if (bucket) {
      bucket.push(row)
    } else {
      groups.set(row.agent, [row])
      order.push(row.agent)
    }
  }
  return order.map((agent) => ({ agent, rows: groups.get(agent) ?? [] }))
}

export function isUnresolved(state: DerivedState, agent: string): boolean {
  const bins = state.config?.process?.resolvedBins
  if (!bins || !Object.prototype.hasOwnProperty.call(bins, agent)) return false
  return bins[agent] === null
}

/** Group subtitle: version, bin path, model count — only what is actually known. */
export function groupParts(state: DerivedState, agent: string, first: AgentRow, count: number): string[] {
  const bins = state.config?.process?.resolvedBins
  const parts: string[] = []
  if (first.cliVersion) parts.push(`v${first.cliVersion}`)
  const bin = first.binPath || (bins ? bins[agent] : null)
  if (bin) parts.push(bin)
  else if (isUnresolved(state, agent)) parts.push("not on dashboard PATH")
  parts.push(`${count} model${count === 1 ? "" : "s"}`)
  return parts
}

export const UNRESOLVED_HELP =
  "Revalidate and Ping are disabled for this CLI because the dashboard process cannot find it on its own PATH."

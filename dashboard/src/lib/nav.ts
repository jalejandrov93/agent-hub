import {
  LayoutDashboard,
  Bot,
  PlayCircle,
  History,
  BarChart3,
  Users,
  Activity,
  CheckSquare,
  Settings,
  Cloud,
  GitFork,
  type LucideIcon,
} from "lucide-react"
import type { NavBadgeKey } from "./badges"

export type RouteName =
  | "overview"
  | "agents"
  | "jobs"
  | "history"
  | "metrics"
  | "subagents"
  | "timeline"
  | "work-graph"
  | "approvals"
  | "config"
  | "cloud"

export type NavItem = {
  name: RouteName
  label: string
  path: `/${RouteName}`
  icon: LucideIcon
  badge?: NavBadgeKey
}

export type NavGroup = { label: string; items: NavItem[] }

export const NAV_GROUPS: NavGroup[] = [
  {
    label: "Monitor",
    items: [
      { name: "overview", label: "Overview", path: "/overview", icon: LayoutDashboard },
      { name: "agents", label: "Agents", path: "/agents", icon: Bot, badge: "agents" },
      { name: "jobs", label: "Running jobs", path: "/jobs", icon: PlayCircle, badge: "jobs" },
      { name: "history", label: "Job history", path: "/history", icon: History, badge: "history" },
      { name: "metrics", label: "Metrics", path: "/metrics", icon: BarChart3 },
    ],
  },
  {
    label: "Activity",
    items: [
      { name: "subagents", label: "Claude subagents", path: "/subagents", icon: Users },
      { name: "timeline", label: "Timeline", path: "/timeline", icon: Activity, badge: "timeline" },
      { name: "work-graph", label: "Work graph", path: "/work-graph", icon: GitFork },
    ],
  },
  {
    label: "System",
    items: [
      { name: "approvals", label: "Approvals", path: "/approvals", icon: CheckSquare, badge: "approvals" },
      { name: "cloud", label: "Cloud", path: "/cloud", icon: Cloud },
      { name: "config", label: "Config", path: "/config", icon: Settings, badge: "config" },
    ],
  },
]

export const ROUTE_LABELS: Record<RouteName, string> = Object.fromEntries(
  NAV_GROUPS.flatMap((group) => group.items.map((item) => [item.name, item.label]))
) as Record<RouteName, string>

/** The NAV_GROUPS label containing a route — used for the topbar title. */
export function groupLabelFor(routeName: RouteName): string {
  const group = NAV_GROUPS.find((g) => g.items.some((item) => item.name === routeName))
  return group ? group.label : ""
}

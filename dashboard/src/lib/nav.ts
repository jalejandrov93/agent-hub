import {
  LayoutDashboard,
  Bot,
  Layers,
  PlayCircle,
  History,
  BarChart3,
  Users,
  Activity,
  CheckSquare,
  Settings,
  Cloud,
  GitFork,
  Network,
  type LucideIcon,
} from "lucide-react"
import type { NavBadgeKey } from "./badges"

export type RouteName =
  | "overview"
  | "agents"
  | "providers"
  | "jobs"
  | "history"
  | "metrics"
  | "subagents"
  | "timeline"
  | "work-graph"
  | "graph"
  | "approvals"
  | "config"
  | "cloud"
  | "tools"

export type ViewMeta = {
  label: string
  tip: string
}

/**
 * Single source of truth for view labels and tips across the dashboard.
 * Used by the sidebar navigation, PageHeader, and breadcrumbs/tooltips so
 * labels and descriptions never drift.
 */
export const VIEW_META: Record<RouteName, ViewMeta> = {
  overview: {
    label: "Overview",
    tip: "Fleet health at a glance.",
  },
  jobs: {
    label: "Running jobs",
    tip: "Queued and in-progress jobs.",
  },
  history: {
    label: "Job history",
    tip: "Completed, failed, and canceled jobs.",
  },
  approvals: {
    label: "Approvals",
    tip: "Proposals and learnings waiting for review.",
  },
  timeline: {
    label: "Timeline",
    tip: "Every hub and provider event, newest first.",
  },
  agents: {
    label: "Agents",
    tip: "CLI agents this dashboard can delegate to.",
  },
  providers: {
    label: "Providers",
    tip: "Multi-account agys profiles and quotas. Agent-hub selects a profile per dispatch only when AGENT_HUB_AGYS is set.",
  },
  subagents: {
    label: "Subagents",
    tip: "Lifecycle events and token consumption across providers.",
  },
  graph: {
    label: "Execution DAG",
    tip: "Directed acyclic graph of multi-agent and workflow executions.",
  },
  "work-graph": {
    label: "Filesystem Map",
    tip: "Filesystem hierarchy, git repos, worktrees, branches, and live locks.",
  },
  metrics: {
    label: "Metrics",
    tip: "Aggregate task metrics across time.",
  },
  cloud: {
    label: "Cloud",
    tip: "Manage background agent execution, sources, and schedules.",
  },
  config: {
    label: "Settings",
    tip: "Delegation map, timeouts, breaker, overrides, and process paths.",
  },
  tools: {
    label: "Tools",
    tip: "MCP tools registered by the agent-hub server.",
  },
}

export type NavItem = {
  name: RouteName
  label: string
  tip: string
  path: `/${RouteName}`
  icon: LucideIcon
  badge?: NavBadgeKey
}

export type NavGroup = { label: string; items: NavItem[] }

export const NAV_GROUPS: NavGroup[] = [
  {
    label: "Operations",
    items: [
      {
        name: "overview",
        label: VIEW_META.overview.label,
        tip: VIEW_META.overview.tip,
        path: "/overview",
        icon: LayoutDashboard,
      },
      {
        name: "jobs",
        label: VIEW_META.jobs.label,
        tip: VIEW_META.jobs.tip,
        path: "/jobs",
        icon: PlayCircle,
        badge: "jobs",
      },
      {
        name: "history",
        label: VIEW_META.history.label,
        tip: VIEW_META.history.tip,
        path: "/history",
        icon: History,
        badge: "history",
      },
      {
        name: "approvals",
        label: VIEW_META.approvals.label,
        tip: VIEW_META.approvals.tip,
        path: "/approvals",
        icon: CheckSquare,
        badge: "approvals",
      },
      {
        name: "timeline",
        label: VIEW_META.timeline.label,
        tip: VIEW_META.timeline.tip,
        path: "/timeline",
        icon: Activity,
        badge: "timeline",
      },
    ],
  },
  {
    label: "Agents & Topology",
    items: [
      {
        name: "agents",
        label: VIEW_META.agents.label,
        tip: VIEW_META.agents.tip,
        path: "/agents",
        icon: Bot,
        badge: "agents",
      },
      {
        name: "providers",
        label: VIEW_META.providers.label,
        tip: VIEW_META.providers.tip,
        path: "/providers",
        icon: Layers,
      },
      {
        name: "subagents",
        label: VIEW_META.subagents.label,
        tip: VIEW_META.subagents.tip,
        path: "/subagents",
        icon: Users,
      },
      {
        name: "graph",
        label: VIEW_META.graph.label,
        tip: VIEW_META.graph.tip,
        path: "/graph",
        icon: Network,
      },
      {
        name: "work-graph",
        label: VIEW_META["work-graph"].label,
        tip: VIEW_META["work-graph"].tip,
        path: "/work-graph",
        icon: GitFork,
      },
      {
        name: "metrics",
        label: VIEW_META.metrics.label,
        tip: VIEW_META.metrics.tip,
        path: "/metrics",
        icon: BarChart3,
      },
    ],
  },
  {
    label: "System",
    items: [
      {
        name: "cloud",
        label: VIEW_META.cloud.label,
        tip: VIEW_META.cloud.tip,
        path: "/cloud",
        icon: Cloud,
      },
      {
        name: "config",
        label: VIEW_META.config.label,
        tip: VIEW_META.config.tip,
        path: "/config",
        icon: Settings,
        badge: "config",
      },
    ],
  },
]

export const ROUTE_LABELS: Record<RouteName, string> = Object.fromEntries(
  (Object.keys(VIEW_META) as RouteName[]).map((name) => [name, VIEW_META[name].label])
) as Record<RouteName, string>

/** The NAV_GROUPS label containing a route — used for the topbar title. */
export function groupLabelFor(routeName: RouteName): string {
  const group = NAV_GROUPS.find((g) => g.items.some((item) => item.name === routeName))
  if (group) return group.label
  if (routeName === "tools") return "System"
  return ""
}

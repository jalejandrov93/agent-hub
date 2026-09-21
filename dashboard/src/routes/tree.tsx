/**
 * Code-based route tree (no file-based codegen), hash history — so existing
 * deep links like #/agents?filter=unhealthy keep working unchanged.
 */
import { createRootRoute, createRoute, createRouter, redirect } from "@tanstack/react-router"
import { createHashHistory } from "@tanstack/react-router"
import { AppShell } from "@/components/shell/app-shell"
import { OverviewView } from "@/views/overview"
import { AgentsView } from "@/views/agents"
import { JobsView } from "@/views/jobs"
import { HistoryView } from "@/views/history"
import { MetricsView } from "@/views/metrics"
import { SubagentsView } from "@/views/subagents"
import { TimelineView } from "@/views/timeline"
import { WorkGraphView } from "@/views/work-graph"
import { GraphView } from "@/views/graph"
import { ApprovalsView } from "@/views/approvals"

import { ConfigView } from "@/views/config"
import { CloudView } from "@/views/cloud"
import {
  AgentsSearch,
  HistorySearch,
  MetricsSearch,
  TimelineSearch,
  ApprovalsSearch,
  ConfigSearch,
  CloudSearch,
} from "./search"

const rootRoute = createRootRoute({ component: AppShell })

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  beforeLoad: () => {
    throw redirect({ to: "/overview" })
  },
})

const overviewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/overview",
  component: OverviewView,
})

const agentsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/agents",
  validateSearch: AgentsSearch,
  component: AgentsView,
})

const jobsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/jobs",
  component: JobsView,
})

const historyRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/history",
  validateSearch: HistorySearch,
  component: HistoryView,
})

const metricsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/metrics",
  validateSearch: MetricsSearch,
  component: MetricsView,
})

const subagentsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/subagents",
  component: SubagentsView,
})

const timelineRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/timeline",
  validateSearch: TimelineSearch,
  component: TimelineView,
})

const workGraphRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/work-graph",
  component: WorkGraphView,
})

const graphRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/graph",
  component: GraphView,
})

const approvalsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/approvals",
  validateSearch: ApprovalsSearch,
  component: ApprovalsView,
})

const configRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/config",
  validateSearch: ConfigSearch,
  component: ConfigView,
})

const cloudRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/cloud",
  validateSearch: CloudSearch,
  component: CloudView,
})

const toolsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/tools",
  beforeLoad: () => {
    throw redirect({
      to: "/config",
      search: { section: "tools" },
    })
  },
})

const routeTree = rootRoute.addChildren([
  indexRoute,
  overviewRoute,
  agentsRoute,
  jobsRoute,
  historyRoute,
  metricsRoute,
  subagentsRoute,
  timelineRoute,
  workGraphRoute,
  graphRoute,
  approvalsRoute,
  configRoute,
  cloudRoute,
  toolsRoute,
])

export const router = createRouter({
  routeTree,
  history: createHashHistory(),
  defaultNotFoundComponent: () => <OverviewView />,
})

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router
  }
}

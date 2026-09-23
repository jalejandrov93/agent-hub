import * as React from "react"
import { Outlet, useLocation } from "@tanstack/react-router"
import { useQueryClient } from "@tanstack/react-query"
import { SidebarProvider, SidebarInset } from "@/components/ui/sidebar"
import { AppSidebar } from "./app-sidebar"
import { Topbar } from "./topbar"
import { AppBackground } from "@/components/AppBackground"
import { ROUTE_LABELS, groupLabelFor, type RouteName } from "@/lib/nav"
import { qk } from "@/lib/query-keys"

function routeNameFromPath(pathname: string): RouteName {
  const name = pathname.replace(/^\//, "") || "overview"
  return (name in ROUTE_LABELS ? name : "overview") as RouteName
}

export function AppShell() {
  const location = useLocation()
  const queryClient = useQueryClient()
  const routeName = routeNameFromPath(location.pathname)

  // 'r' refreshes unless the user is typing in a form control.
  React.useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "r" || event.ctrlKey || event.metaKey || event.altKey) return
      const tag = (document.activeElement && document.activeElement.tagName) || ""
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return
      queryClient.invalidateQueries({ queryKey: qk.state })
      queryClient.invalidateQueries({ queryKey: qk.config })
    }
    document.addEventListener("keydown", onKeyDown)
    return () => document.removeEventListener("keydown", onKeyDown)
  }, [queryClient])

  // Focus the active view's heading after every navigation, for screen-reader users.
  React.useEffect(() => {
    document.getElementById("view-title")?.focus()
  }, [location.pathname])

  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset className="min-w-0 isolate">
        <AppBackground />
        <Topbar title={groupLabelFor(routeName) || ROUTE_LABELS[routeName]} />
        <main id="main-content" className="flex flex-1 flex-col gap-4 overflow-auto p-4">
          <Outlet />
        </main>
      </SidebarInset>
    </SidebarProvider>
  )
}

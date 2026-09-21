import { Link, useLocation } from "@tanstack/react-router"
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from "@/components/ui/sidebar"
import { NAV_GROUPS } from "@/lib/nav"
import { useNavBadges } from "@/lib/use-nav-badges"

export function AppSidebar() {
  const location = useLocation()
  const badges = useNavBadges()

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className="flex h-12 flex-row items-center px-3 text-sm font-semibold tracking-tight group-data-[collapsible=icon]:justify-center">
        agent-hub
      </SidebarHeader>
      <SidebarContent>
        {NAV_GROUPS.map((group) => (
          <SidebarGroup key={group.label}>
            <SidebarGroupLabel>{group.label}</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {group.items.map((item) => {
                  const entry = item.badge ? badges[item.badge] : null
                  const Icon = item.icon
                  return (
                    <SidebarMenuItem key={item.name}>
                      <SidebarMenuButton
                        isActive={location.pathname === item.path}
                        tooltip={item.tip}
                        render={<Link to={item.path} data-route={item.name} title={item.tip} />}
                      >
                        <Icon />
                        <span>{item.label}</span>
                      </SidebarMenuButton>
                      {entry ? (
                        <SidebarMenuBadge
                          data-tone={entry.tone}
                          className="data-[tone=warning]:text-warning data-[tone=destructive]:text-destructive data-[tone=running]:text-primary data-[tone=muted]:text-muted-foreground"
                        >
                          {entry.count}
                        </SidebarMenuBadge>
                      ) : null}
                    </SidebarMenuItem>
                  )
                })}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ))}
      </SidebarContent>
      <SidebarRail />
    </Sidebar>
  )
}

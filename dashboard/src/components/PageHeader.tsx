import * as React from "react"
import { Info } from "lucide-react"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { VIEW_META, type RouteName } from "@/lib/nav"

export function PageHeader({
  title: titleProp,
  routeName,
  tip: tipProp,
  description,
  actions,
}: {
  title?: string
  routeName?: RouteName
  tip?: string
  description?: string
  actions?: React.ReactNode
}) {
  const meta = routeName ? VIEW_META[routeName] : undefined
  const title = titleProp ?? meta?.label ?? ""
  const tip =
    tipProp ??
    meta?.tip ??
    (title
      ? Object.values(VIEW_META).find((m) => m.label.toLowerCase() === title.toLowerCase())?.tip
      : undefined)
  const subtitle = description || tip

  return (
    <header className="flex flex-col gap-1 pb-4 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex items-center gap-1.5">
          <h1
            id="view-title"
            tabIndex={-1}
            className="text-xl font-semibold tracking-tight focus-visible:outline-none"
          >
            {title}
          </h1>
          {tip ? (
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      className="inline-flex items-center justify-center rounded-sm text-muted-foreground/70 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                      aria-label={`${title} info`}
                    >
                      <Info className="size-4" />
                    </button>
                  }
                />
                <TooltipContent>{tip}</TooltipContent>
              </Tooltip>
            </TooltipProvider>
          ) : null}
        </div>
        {subtitle ? (
          <p className="text-sm text-muted-foreground">{subtitle}</p>
        ) : null}
      </div>
      {actions ? (
        <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>
      ) : null}
    </header>
  )
}

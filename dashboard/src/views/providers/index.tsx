import { PageHeader } from "@/components/PageHeader"
import { EmptyState } from "@/components/EmptyState"
import { Badge } from "@/components/ui/badge"
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert"
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useProvidersQuery, useSetProvidersModeMutation } from '@/lib/queries'
import { VIEW_META } from '@/lib/nav'
import { cn } from "@/lib/utils"
import { Layers, ServerOff } from "lucide-react"
import type { AgysBucketT } from "@/lib/types"

export function formatResetCountdown(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return ""
  const target = new Date(iso).getTime()
  if (Number.isNaN(target)) return ""
  const diffMs = target - now
  if (diffMs <= 0) return "resets now"
  const s = Math.floor(diffMs / 1000)
  if (s < 60) return `resets in ${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `resets in ${m}m`
  const h = Math.floor(m / 60)
  const remM = m % 60
  if (h < 24) return `resets in ${h}h ${remM}m`
  const d = Math.floor(h / 24)
  const remH = h % 24
  return `resets in ${d}d ${remH}h`
}

export function JobProfileBadge({
  profile,
  status,
}: {
  profile?: string | null
  status?: string | null
}) {
  if (!profile) return null
  return (
    <div className="flex items-center gap-1.5" data-testid="job-profile-badge">
      <Badge variant="outline" className="font-mono text-xs">
        {profile}
      </Badge>
      {status ? (
        <Badge
          variant={
            status === "selected"
              ? "secondary"
              : status === "fallback"
              ? "outline"
              : status === "exhausted" || status === "unavailable"
              ? "destructive"
              : "secondary"
          }
          className="text-[10px] px-1 py-0 h-4"
        >
          {status}
        </Badge>
      ) : null}
    </div>
  )
}

function ProfileStatePill({ state }: { state: string }) {
  const variant =
    state === "selected"
      ? "secondary"
      : state === "exhausted"
      ? "destructive"
      : state === "unavailable"
      ? "destructive"
      : "outline"

  return (
    <Badge variant={variant} className="capitalize text-xs">
      {state}
    </Badge>
  )
}

function QuotaBucketBar({ bucket }: { bucket: AgysBucketT }) {
  const isExhausted = bucket.usedPercent != null && bucket.usedPercent >= 100
  const resetText = formatResetCountdown(bucket.resetTime)

  return (
    <div className="flex flex-col gap-1.5 text-xs">
      <div className="flex items-center justify-between">
        <span className="font-medium text-foreground truncate max-w-[200px]" title={bucket.label}>
          {bucket.label}
        </span>
        {bucket.usedPercent != null ? (
          <span className="text-muted-foreground font-mono">
            {bucket.usedPercent.toFixed(0)}% used
          </span>
        ) : null}
      </div>

      {bucket.usedPercent != null ? (
        <div className="w-full bg-secondary h-2 rounded-full overflow-hidden">
          <div
            className={cn(
              "h-full transition-all rounded-full",
              isExhausted ? "bg-destructive" : "bg-primary"
            )}
            style={{ width: `${Math.min(100, Math.max(0, bucket.usedPercent))}%` }}
          />
        </div>
      ) : null}

      <div className="flex items-center justify-between text-[11px] text-muted-foreground">
        {bucket.usedPercent == null && bucket.description ? (
          <span className="truncate max-w-[240px]" title={bucket.description}>
            {bucket.description}
          </span>
        ) : bucket.remainingPercent != null ? (
          <span>{bucket.remainingPercent.toFixed(0)}% remaining</span>
        ) : (
          <span />
        )}
        {resetText ? <span>{resetText}</span> : null}
      </div>
    </div>
  )
}

export function ProvidersView() {
  const { data, isLoading, error } = useProvidersQuery()
  const setModeMutation = useSetProvidersModeMutation()

  const isEnvOverride = data?.source === 'env'

  const handleModeChange = (val: string | null) => {
    if (!val) return
    const nextMode = val as 'auto' | 'profile' | 'off'
    if (nextMode === 'profile') {
      const nextProfile =
        data?.pinnedProfile ||
        data?.selected?.name ||
        data?.profiles[0]?.name ||
        null
      setModeMutation.mutate({ mode: 'profile', profile: nextProfile })
    } else {
      setModeMutation.mutate({ mode: nextMode, profile: null })
    }
  }

  const handleProfileChange = (val: string | null) => {
    if (!val) return
    setModeMutation.mutate({ mode: 'profile', profile: val })
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title={VIEW_META.providers.label}
        description={VIEW_META.providers.tip}
      />

      {isLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          <Skeleton className="h-48 w-full" />
          <Skeleton className="h-48 w-full" />
          <Skeleton className="h-48 w-full" />
        </div>
      ) : error ? (
        <Alert variant="destructive">
          <ServerOff className="h-4 w-4" />
          <AlertTitle>Failed to load providers</AlertTitle>
          <AlertDescription>{error.message}</AlertDescription>
        </Alert>
      ) : !data?.available ? (
        <Alert variant="destructive" className="max-w-2xl">
          <ServerOff className="h-4 w-4" />
          <AlertTitle>agys CLI unavailable</AlertTitle>
          <AlertDescription className="space-y-2 mt-2">
            <p>{data?.reason || "agys CLI not found or unavailable on PATH."}</p>
            <p className="text-xs opacity-90">
              Hint: Install agys or run{" "}
              <code className="font-mono bg-muted/30 px-1 py-0.5 rounded">
                agys auth login
              </code>{" "}
              to enable multi-account profiles and quota balancing.
            </p>
          </AlertDescription>
        </Alert>
      ) : (
        <>
          <div className='flex flex-wrap items-center gap-3 p-3 rounded-lg border bg-muted/20 text-sm'>
            <div className='flex items-center gap-1.5'>
              <span className='text-muted-foreground'>Mode:</span>
              <Select
                value={data.mode}
                disabled={isEnvOverride || setModeMutation.isPending}
                onValueChange={handleModeChange}
              >
                <SelectTrigger
                  aria-label='Mode toggle'
                  disabled={isEnvOverride || setModeMutation.isPending}
                  className='h-7 text-xs font-mono'
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value='auto'>auto</SelectItem>
                    <SelectItem value='profile'>profile</SelectItem>
                    <SelectItem value='off'>off</SelectItem>
                  </SelectGroup>
                </SelectContent>
              </Select>
            </div>

            {data.mode === 'profile' && data.profiles.length > 0 ? (
              <div className='flex items-center gap-1.5'>
                <span className='text-muted-foreground'>Profile:</span>
                <Select
                  value={
                    data.pinnedProfile ??
                    data.selected?.name ??
                    data.profiles[0]?.name ??
                    ''
                  }
                  disabled={isEnvOverride || setModeMutation.isPending}
                  onValueChange={handleProfileChange}
                >
                  <SelectTrigger
                    aria-label='Profile toggle'
                    disabled={isEnvOverride || setModeMutation.isPending}
                    className='h-7 text-xs font-mono'
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {data.profiles.map((p) => (
                        <SelectItem key={p.name} value={p.name}>
                          {p.name}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </div>
            ) : null}

            {data.source ? (
              <div className='flex items-center gap-1.5'>
                <span className='text-muted-foreground'>Source:</span>
                <Badge variant='outline' className='text-xs' data-testid='providers-source-badge'>
                  {data.source}
                </Badge>
              </div>
            ) : null}

            <div className='flex items-center gap-1.5'>
              <span className='text-muted-foreground'>Selected:</span>
              {data.selected?.name ? (
                <Badge variant='secondary' className='font-mono font-medium'>
                  {data.selected.name}
                </Badge>
              ) : (
                <span className='text-muted-foreground italic'>none</span>
              )}
            </div>

            {isEnvOverride ? (
              <span
                data-testid='env-override-hint'
                className='text-xs text-muted-foreground italic ml-auto'
              >
                Overridden by environment (AGENT_HUB_AGYS or AGENT_HUB_AGYS_PROFILE)
              </span>
            ) : null}
          </div>

          {data.profiles.length === 0 ? (
            <EmptyState
              icon={Layers}
              title="No agys profiles found"
              description="No active profiles configured in ~/.agys/profiles. Create one using agys profile create."
            />
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {data.profiles.map((profile) => {
                const isSelected = data.selected?.name === profile.name
                return (
                  <Card
                    key={profile.name}
                    className={cn(
                      "flex flex-col border transition-colors",
                      isSelected && "border-primary ring-2 ring-primary/20 bg-primary/5"
                    )}
                  >
                    <CardHeader className="pb-3 border-b">
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2 min-w-0">
                          <CardTitle className="truncate font-semibold text-base" title={profile.name}>
                            {profile.name}
                          </CardTitle>
                          {profile.active ? (
                            <Badge variant="secondary" className="text-[10px]">
                              default
                            </Badge>
                          ) : null}
                          {isSelected ? (
                            <Badge variant="default" className="text-[10px]">
                              selected
                            </Badge>
                          ) : null}
                        </div>
                        <ProfileStatePill state={profile.state} />
                      </div>
                      <div className="flex items-center justify-between text-xs text-muted-foreground mt-1">
                        <span className="truncate max-w-[180px]" title={profile.email ?? undefined}>
                          {profile.email || "—"}
                        </span>
                        <span>Priority: {profile.priority}</span>
                      </div>
                    </CardHeader>
                    <CardContent className="pt-4 flex-1 flex flex-col gap-4">
                      <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                        Quota
                      </div>
                      {profile.quota.buckets.length > 0 ? (
                        <div className="flex flex-col gap-3">
                          {profile.quota.buckets.map((b) => (
                            <QuotaBucketBar key={b.id || b.label} bucket={b} />
                          ))}
                        </div>
                      ) : (
                        <span className="text-xs text-muted-foreground">No quota reported</span>
                      )}
                    </CardContent>
                  </Card>
                )
              })}
            </div>
          )}
        </>
      )}
    </div>
  )
}

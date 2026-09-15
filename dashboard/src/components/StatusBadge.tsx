import { CheckCircle2, AlertTriangle, XCircle, Clock, PlayCircle, PauseCircle } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import { statusBadge, errorBadge } from "@/lib/badges"
import { TONE_BADGE_CLASS, type Tone } from "@/lib/tone"

const ICONS = {
  check: CheckCircle2,
  warn: AlertTriangle,
  error: XCircle,
  clock: Clock,
  play: PlayCircle,
  pause: PauseCircle,
}

const TONE_ICON: Record<Tone, keyof typeof ICONS> = {
  ready: "check",
  running: "play",
  warning: "warn",
  destructive: "error",
  muted: "clock",
}

type StatusBadgeProps =
  | { kind: "status"; value: string | null | undefined; className?: string }
  | { kind: "errorKind"; value: string | null | undefined; className?: string }

/**
 * Renders an AgentStatus, JobStatus, or job errorKind as a badge — always
 * text + icon, never color alone, so status is legible without relying on
 * color perception.
 */
export function StatusBadge(props: StatusBadgeProps) {
  const spec =
    props.kind === "status"
      ? statusBadge(props.value)
      : { ...errorBadge(props.value), icon: undefined as string | undefined }

  const iconKey = spec.icon ?? TONE_ICON[spec.tone]
  const Icon = ICONS[iconKey as keyof typeof ICONS]

  return (
    <Badge
      variant="outline"
      className={cn("border-transparent", TONE_BADGE_CLASS[spec.tone], props.className)}
    >
      <Icon data-icon="inline-start" />
      {spec.label}
    </Badge>
  )
}

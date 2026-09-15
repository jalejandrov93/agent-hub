import { Monitor, Sun, Moon } from "lucide-react"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { useTheme, type ThemeChoice } from "@/components/theme-provider"

const OPTIONS: { value: ThemeChoice; label: string; icon: typeof Monitor }[] = [
  { value: "system", label: "System", icon: Monitor },
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
]

export function ThemeToggle() {
  const { theme, setTheme } = useTheme()

  return (
    <Select value={theme} onValueChange={(value) => setTheme(value as ThemeChoice)}>
      <SelectTrigger aria-label="Theme" className="w-[8.5rem]">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          {OPTIONS.map(({ value, label, icon: Icon }) => (
            <SelectItem key={value} value={value}>
              <Icon data-icon="inline-start" />
              {label}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  )
}

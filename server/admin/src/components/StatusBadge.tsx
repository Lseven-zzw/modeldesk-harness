import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'

export type StatusTone = 'success' | 'warning' | 'error' | 'neutral'

const tones: Record<StatusTone, string> = {
  success: 'border-emerald-200 bg-emerald-50 text-emerald-800',
  warning: 'border-amber-200 bg-amber-50 text-amber-900',
  error: 'border-red-200 bg-red-50 text-red-800',
  neutral: 'border-border bg-muted text-muted-foreground',
}

export default function StatusBadge({ tone, children }: { tone: StatusTone; children: React.ReactNode }) {
  return <Badge variant="outline" className={cn('whitespace-nowrap font-medium', tones[tone])}>{children}</Badge>
}

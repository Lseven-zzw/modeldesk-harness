export function tokens(value: number | null): string {
  if (value === null) return '—'
  return value.toLocaleString('zh-CN')
}

export function currentMonth(): string {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit' })
    .format(new Date())
}
export function percent(used: number, limit: number): string {
  if (limit <= 0) return '—'
  return `${Math.min(999, Math.round((used / limit) * 100))}%`
}

export function utcTime(iso: string): string {
  return `${iso.slice(0, 19).replace('T', ' ')} UTC`
}

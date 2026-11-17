import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

export default function OptionSelect({ id, label, value, onChange, options, emptyLabel, disabled }: {
  id?: string
  label?: string
  value: string
  onChange: (value: string) => void
  options: { value: string; label: string }[]
  emptyLabel: string
  disabled?: boolean
}) {
  // Radix reserves the empty string for its placeholder.
  const emptyValue = ':empty:'
  const optionValue = (value: string) => `option:${value}`
  return <Select value={value === '' ? emptyValue : optionValue(value)} disabled={disabled}
    onValueChange={(next) => onChange(next === emptyValue ? '' : next.slice('option:'.length))}>
    <SelectTrigger id={id} aria-label={label}><SelectValue /></SelectTrigger>
    <SelectContent position="popper">
      <SelectGroup>
        <SelectItem value={emptyValue}>{emptyLabel}</SelectItem>
        {options.map((item) => <SelectItem key={item.value} value={optionValue(item.value)}>{item.label}</SelectItem>)}
      </SelectGroup>
    </SelectContent>
  </Select>
}

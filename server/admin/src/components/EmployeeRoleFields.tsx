import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import OptionSelect from '@/components/OptionSelect'
import { api, type AdminAssignment } from '@/lib/api'

export type RoleCatalog = Awaited<ReturnType<typeof api.roles.list>>

export default function EmployeeRoleFields({ catalog, value, onChange, disabled }: {
  catalog: RoleCatalog
  value: AdminAssignment[]
  onChange: (value: AdminAssignment[]) => void
  disabled: boolean
}) {
  const [role, setRole] = useState('')
  const [department, setDepartment] = useState('')
  const [includeDescendants, setIncludeDescendants] = useState(false)
  const selected = catalog.items.find((item) => item.code === role)
  const departmentLabel = (code: string) => catalog.department_names[code] ?? code
  const scoped = catalog.permissions.filter((item) => item.department_scoped && selected?.permissions.includes(item.code))
  const duplicate = value.some((item) => item.role === role &&
    (item.department === null || !department || item.department === department))

  return <fieldset disabled={disabled} className="space-y-3 rounded-lg border p-3">
    <legend className="px-1 font-semibold">角色授权</legend>
    {value.length ? <ul className="divide-y">
      {value.map((item) => <li key={JSON.stringify(item)} className="flex items-center justify-between gap-2 py-1">
        <span>{catalog.items.find((role) => role.code === item.role)?.name ?? item.role}
          <span className="ml-2 text-muted-foreground">{item.department ? departmentLabel(item.department) : '全局'}
            {item.include_descendants ? '及下级' : ''}
          </span>
        </span>
        <Button type="button" size="sm" variant="ghost" onClick={() => onChange(value.filter((entry) => entry !== item))}>移除</Button>
      </li>)}
    </ul> : <p className="text-sm text-muted-foreground">未分配自定义角色。</p>}
    <div className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
      <OptionSelect label="选择角色" value={role} disabled={disabled} emptyLabel="选择角色"
        options={catalog.items.map((item) => ({ value: item.code, label: item.name }))}
        onChange={(value) => { setRole(value); setDepartment(''); setIncludeDescendants(false) }} />
      <OptionSelect label="授权范围" value={department} disabled={disabled} emptyLabel="全局"
        options={scoped.length ? catalog.departments.map((code) => ({ value: code, label: departmentLabel(code) })) : []}
        onChange={(value) => { setDepartment(value); setIncludeDescendants(false) }} />
      <Button type="button" variant="secondary" disabled={!selected || duplicate || value.length >= 200}
        onClick={() => {
          onChange([...value, { role, department: department || null,
            ...(includeDescendants ? { include_descendants: true } : {}) }])
          setRole('')
          setDepartment('')
          setIncludeDescendants(false)
        }}>添加角色</Button>
    </div>
    {department && Object.hasOwn(catalog.department_names, department) && <label className="flex items-center gap-2">
      <Checkbox checked={includeDescendants} onCheckedChange={(value) => setIncludeDescendants(value === true)} />
      同时授权当前和将来的下级部门
    </label>}
    {duplicate && <p className="text-sm text-muted-foreground">该授权已存在，或与已有的全局或部门范围冲突。</p>}
    {department && <p className="text-sm text-muted-foreground">部门内生效：{scoped.map((item) => item.name).join('、')}。</p>}
  </fieldset>
}

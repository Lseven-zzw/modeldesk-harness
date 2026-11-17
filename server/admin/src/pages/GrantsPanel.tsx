import { useEffect, useState } from 'react'

import OptionSelect from '@/components/OptionSelect'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { api, type Department, type EmployeeOption, type Grant, type ModelOption } from '@/lib/api'

export default function GrantsPanel({ model, canWrite, onClose }: { model: ModelOption; canWrite: boolean; onClose: () => void }) {
  const [everyone, setEveryone] = useState(false)
  const [departments, setDepartments] = useState<string[]>([])
  const [departmentDraft, setDepartmentDraft] = useState('')
  const [departmentOptions, setDepartmentOptions] = useState<Pick<Department, 'code' | 'name'>[]>([])
  const [userIds, setUserIds] = useState<number[]>([])
  const [employees, setEmployees] = useState<EmployeeOption[]>([])
  const [query, setQuery] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    let cancelled = false
    Promise.all([api.models.grants(model.id), api.accessOptions()])
      .then(([grants, { employees: people, departments: options }]) => {
        if (cancelled) return
        setEveryone(grants.grants.some((grant) => grant.subject_type === 'EVERYONE'))
        setDepartments(grants.grants.filter((grant) => grant.subject_type === 'DEPARTMENT').map((grant) => grant.subject_id))
        setUserIds(grants.grants.filter((grant) => grant.subject_type === 'USER').map((grant) => Number(grant.subject_id)))
        setEmployees(people)
        setDepartmentOptions(options)
        setReady(true)
      })
      .catch((caught: Error) => { if (!cancelled) setError(caught.message) })
    return () => { cancelled = true }
  }, [model.id])

  const visible = employees.filter((employee) => {
    const needle = query.trim().toLowerCase()
    if (needle === '') return true
    return [employee.display_name, employee.username, employee.department ?? '']
      .some((value) => value.toLowerCase().includes(needle))
  })

  function addDepartment(): void {
    const name = departmentDraft.trim()
    if (name === '' || departments.includes(name)) return
    setDepartments([...departments, name])
    setDepartmentDraft('')
  }

  async function save(): Promise<void> {
    if (!ready) return
    setSaving(true)
    try {
      const grants: Grant[] = []
      if (everyone) grants.push({ subject_type: 'EVERYONE', subject_id: '*' })
      for (const department of departments) grants.push({ subject_type: 'DEPARTMENT', subject_id: department })
      for (const id of userIds) grants.push({ subject_type: 'USER', subject_id: String(id) })
      await api.models.replaceGrants(model.id, grants)
      onClose()
    } catch (caught) {
      setError((caught as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="max-h-[80vh] overflow-y-auto">
        <DialogHeader><DialogTitle>开放范围 · {model.display_name}</DialogTitle></DialogHeader>
        <fieldset className="space-y-4" disabled={!canWrite}>
          {error !== null && <p className="text-sm text-destructive">{error}</p>}

          <label className="flex items-center gap-2 text-sm">
            <Checkbox disabled={!canWrite} checked={everyone} onCheckedChange={(checked) => setEveryone(checked === true)} />
            全员可见（EVERYONE）
          </label>
          <p className="text-xs text-muted-foreground">
            员工只要命中全员、部门或个人中的任一条授权，就能看到该模型。
          </p>

          <div className="space-y-2">
            <Label>部门</Label>
            <div className="flex gap-2">
              <OptionSelect label="部门" value={departmentDraft} emptyLabel="选择部门"
                disabled={!canWrite || !ready} onChange={setDepartmentDraft}
                options={departmentOptions.filter((item) => !departments.includes(item.code))
                  .map((item) => ({ value: item.code, label: item.name }))} />
              <Button type="button" variant="secondary" disabled={!departmentDraft} onClick={addDepartment}>添加</Button>
            </div>
            <div className="flex flex-wrap gap-2">
              {departments.map((department) => (
                <span key={department} className="flex items-center gap-2 rounded bg-accent/10 px-2 py-1 text-xs">
                  {departmentOptions.find((item) => item.code === department)?.name ?? department}
                  <Button type="button" variant="ghost" size="sm"
                          onClick={() => setDepartments(departments.filter((item) => item !== department))}>移除</Button>
                </span>
              ))}
            </div>
          </div>

          <div className="space-y-2">
            <Label>员工</Label>
            <Input placeholder="搜索姓名、用户名或部门" value={query}
                   onChange={(event) => setQuery(event.target.value)} />
            <div className="max-h-48 space-y-1 overflow-y-auto rounded border border-border p-2">
              {visible.map((employee) => (
                <label key={employee.id} className="flex items-center gap-2 text-sm">
                  <Checkbox disabled={!canWrite} checked={userIds.includes(employee.id)}
                            onCheckedChange={(checked) => setUserIds(checked === true
                              ? [...userIds, employee.id]
                              : userIds.filter((id) => id !== employee.id))} />
                  {employee.display_name}
                  <span className="text-xs text-muted-foreground">
                    {employee.username}{employee.department ? ` · ${employee.department}` : ''}
                  </span>
                </label>
              ))}
              {ready && visible.length === 0 && <p className="text-xs text-muted-foreground">没有匹配的员工</p>}
            </div>
          </div>

          {canWrite && <Button className="w-full" disabled={saving || !ready} onClick={() => void save()}>保存开放范围</Button>}
        </fieldset>
      </DialogContent>
    </Dialog>
  )
}

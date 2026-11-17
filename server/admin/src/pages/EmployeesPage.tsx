import { useCallback, useEffect, useState } from 'react'

import { Button } from '@/components/ui/button'
import EmployeeRoleFields, { type RoleCatalog } from '@/components/EmployeeRoleFields'
import EffectivePermissionsDialog from '@/components/EffectivePermissionsDialog'
import OptionSelect from '@/components/OptionSelect'
import StatusBadge from '@/components/StatusBadge'
import { useConfirmation } from '@/components/ConfirmationProvider'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow, TableState } from '@/components/ui/table'
import { api, type AdminAssignment, type Department, type Employee } from '@/lib/api'

const emptyDraft = { username: '', display_name: '', department: '', role: 'EMPLOYEE' as Employee['role'], password: '' }

function DepartmentSelect({ id, value, items, onChange }: {
  id: string; value: string; items: Department[]; onChange: (value: string) => void
}) {
  const options = items.map((item) => ({ value: item.code, label: item.name }))
  if (value && !options.some((item) => item.value === value)) options.unshift({ value, label: value })
  return <OptionSelect id={id} value={value} onChange={onChange} options={options} emptyLabel="未分配部门" />
}

export default function EmployeesPage({ permissions }: { permissions: string[] }) {
  const confirm = useConfirmation()
  const canManageRoles = permissions.includes("roles.manage")
  const [items, setItems] = useState<Employee[]>([])
  const [loading, setLoading] = useState(true)
  const [departments, setDepartments] = useState<Department[]>([])
  const [departmentError, setDepartmentError] = useState('')
  const [query, setQuery] = useState('')
  const [activeQuery, setActiveQuery] = useState('')
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const [resetting, setResetting] = useState<Employee | null>(null)
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [draft, setDraft] = useState(emptyDraft)
  const [creating, setCreating] = useState(false)
  const [editing, setEditing] = useState<Employee | null>(null)
  const [inspecting, setInspecting] = useState<Employee | null>(null)
  const [editDraft, setEditDraft] = useState({ display_name: '', department: '', role: 'EMPLOYEE' as Employee['role'] })
  const [roleCatalog, setRoleCatalog] = useState<RoleCatalog | null>(null)
  const [assignments, setAssignments] = useState<AdminAssignment[] | null>(null)
  const [assignmentsChanged, setAssignmentsChanged] = useState(false)
  const [roleError, setRoleError] = useState('')
  const [saving, setSaving] = useState(false)
  const editingId = editing?.id

  const load = useCallback(async (q: string, requestedPage: number) => {
    setLoading(true)
    try {
      const result = await api.employees.list(q, requestedPage)
      setItems(result.items)
      setTotal(result.total)
      setPage(requestedPage)
      setActiveQuery(q)
      setError(null)
    } catch (caught) {
      setError((caught as Error).message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load('', 1) }, [load])
  useEffect(() => {
    let active = true
    api.departments.list().then(
      ({ items }) => { if (active) setDepartments(items.filter((item) => !item.archived)) },
      (error: Error) => { if (active) setDepartmentError(error.message) },
    )
    return () => { active = false }
  }, [])

  useEffect(() => {
    if (!canManageRoles || (!creating && editingId === undefined)) return
    let active = true
    Promise.all([
      api.roles.list(),
      editingId === undefined ? Promise.resolve({ items: [] }) : api.roles.assignments(editingId),
    ]).then(([catalog, { items }]) => {
      if (!active) return
      setRoleCatalog(catalog)
      setAssignments(items)
    }).catch((caught: Error) => { if (active) setRoleError(caught.message) })
    return () => { active = false }
  }, [canManageRoles, creating, editingId])

  function resetRoleFields() {
    setRoleCatalog(null)
    setAssignments(null)
    setAssignmentsChanged(false)
    setRoleError('')
    setError(null)
  }

  function roleFields(identity: Employee['role']) {
    if (!canManageRoles) return null
    if (identity === 'ADMIN') return <p className="text-sm text-muted-foreground">超级管理员已拥有全部后台权限。</p>
    if (roleError) return <p role="alert" className="text-destructive">无法加载角色授权：{roleError}</p>
    if (!roleCatalog || assignments === null) return <p role="status">正在加载角色授权…</p>
    return <EmployeeRoleFields catalog={roleCatalog} value={assignments} onChange={(items) => {
      setAssignments(items)
      setAssignmentsChanged(true)
    }} disabled={saving} />
  }

  function canSave(identity: Employee['role']) {
    return !saving && (!canManageRoles || identity === 'ADMIN' || assignments !== null)
  }

  async function submitCreate(): Promise<void> {
    if (!canSave(draft.role)) return
    setSaving(true)
    try {
      await api.employees.create({
        username: draft.username,
        display_name: draft.display_name,
        department: draft.department.trim() || null,
        role: draft.role,
        password: draft.password,
        ...(canManageRoles && draft.role === 'EMPLOYEE' ? { assignments: assignments ?? [] } : {}),
      })
      setCreating(false)
      setDraft(emptyDraft)
      await load(activeQuery, page)
    } catch (caught) {
      setError((caught as Error).message)
    } finally {
      setSaving(false)
    }
  }

  async function toggleStatus(employee: Employee): Promise<void> {
    const next = employee.status === 1 ? 0 : 1
    const action = next === 0 ? '停用' : '启用'
    if (!await confirm(`${action}「${employee.display_name}」？`,
      next === 0 ? '该员工的所有设备将立即退出。' : '该员工将恢复登录资格。', action, next === 0)) return
    try {
      await api.employees.setStatus(employee.id, next)
      await load(activeQuery, page)
    } catch (caught) {
      setError((caught as Error).message)
    }
  }

  async function resetPassword(): Promise<void> {
    if (resetting === null) return
    try {
      await api.employees.resetPassword(resetting.id, password)
      setResetting(null)
      setPassword('')
      setError(null)
    } catch (caught) {
      setError((caught as Error).message)
    }
  }
  async function submitEdit(): Promise<void> {
    if (editing === null || !canSave(editDraft.role)) return
    setSaving(true)
    try {
      await api.employees.patch(editing.id, {
        display_name: editDraft.display_name,
        department: editDraft.department.trim() || null,
        ...(canManageRoles ? { role: editDraft.role } : {}),
        ...(canManageRoles && editDraft.role === 'EMPLOYEE' && assignmentsChanged ? { assignments: assignments ?? [] } : {}),
      })
      setEditing(null)
      await load(activeQuery, page)
    } catch (caught) {
      setError((caught as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="space-y-4">
      <header className="flex items-end justify-between">
        <div>
          <h1>员工管理</h1>
          <p className="mt-1 text-sm text-muted-foreground">新增员工、调整部门与角色、停用或重置密码。</p>
        </div>
        {permissions.includes("employees.create") && <Button onClick={() => { resetRoleFields(); setCreating(true) }}>新增员工</Button>}
      </header>

      <div className="console-panel" aria-busy={loading}>
      <form role="search" aria-label="搜索员工" className="flex flex-wrap gap-2 border-b p-4"
            onSubmit={(event) => { event.preventDefault(); void load(query, 1) }}>
        <Input aria-label="用户名、姓名或部门" placeholder="搜索用户名、姓名或部门" value={query}
               onChange={(event) => setQuery(event.target.value)} className="min-w-0 flex-1 sm:max-w-sm" />
        <Button type="submit" variant="secondary" disabled={loading}>搜索</Button>
      </form>

      {error !== null && <p role="alert" className="m-4 text-sm text-destructive">{error}</p>}
      {departmentError && <p role="alert" className="m-4 text-destructive">无法加载部门：{departmentError}</p>}
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>姓名</TableHead>
              <TableHead>用户名</TableHead>
              <TableHead>部门</TableHead>
              <TableHead>角色</TableHead>
              <TableHead>状态</TableHead>
              <TableHead className="text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.length === 0 && <TableState columns={6} loading={loading}>{loading ? '正在加载员工…' : error ? '无法加载员工' : '没有匹配的员工'}</TableState>}
            {items.map((employee) => (
              <TableRow key={employee.id}>
                <TableCell className="whitespace-nowrap font-medium">{employee.display_name}</TableCell>
                <TableCell className="text-muted-foreground">{employee.username}</TableCell>
                <TableCell>{departments.find((item) => item.code === employee.department)?.name ?? employee.department ?? '—'}</TableCell>
                <TableCell>{employee.role === 'ADMIN' ? '超级管理员' : '员工'}</TableCell>
                <TableCell>
                  <StatusBadge tone={employee.status === 1 ? 'success' : 'neutral'}>
                    {employee.status === 1 ? '启用' : '停用'}
                  </StatusBadge>
                </TableCell>
                <TableCell className="whitespace-nowrap text-right">
                  {canManageRoles && <Button size="sm" variant="ghost" onClick={() => setInspecting(employee)}>有效权限</Button>}
                  {permissions.includes("employees.update") && (canManageRoles || employee.role !== "ADMIN") && <Button size="sm" variant="ghost" onClick={() => {
                    resetRoleFields()
                    setEditing(employee)
                    setEditDraft({ display_name: employee.display_name, department: employee.department ?? '', role: employee.role })
                  }}>编辑</Button>}
                  {permissions.includes("employees.status") && (canManageRoles || employee.role !== "ADMIN") && <Button size="sm" variant="ghost" onClick={() => void toggleStatus(employee)}>
                    {employee.status === 1 ? '停用' : '启用'}
                  </Button>}
                  {permissions.includes("employees.password") && (canManageRoles || employee.role !== "ADMIN") && <Button size="sm" variant="ghost" onClick={() => { setPassword(''); setResetting(employee); setError(null) }}>重置密码</Button>}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        <div className="flex flex-wrap items-center justify-between gap-3 border-t p-4" aria-label="员工分页">
          <span className="text-sm text-muted-foreground">共 {total} 人 · 第 {page} 页</span>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" disabled={loading || page === 1} onClick={() => void load(activeQuery, page - 1)}>上一页</Button>
            <Button size="sm" variant="outline" disabled={loading || page * 50 >= total} onClick={() => void load(activeQuery, page + 1)}>下一页</Button>
          </div>
        </div>
      </div>

      <Dialog open={resetting !== null} onOpenChange={(open) => { if (!open) { setResetting(null); setPassword('') } }}>
        <DialogContent>
          <DialogHeader><DialogTitle>重置 {resetting?.display_name} 的密码</DialogTitle></DialogHeader>
          <form className="grid gap-3" onSubmit={(event) => { event.preventDefault(); void resetPassword() }}>
            <Label htmlFor="reset-password">新密码（至少 12 位）</Label>
            <Input id="reset-password" type="password" autoComplete="new-password" minLength={12} required
              value={password} onChange={(event) => setPassword(event.target.value)} />
            <p className="text-muted-foreground">重置后，该员工的桌面会话会退出。</p>
            {error && <p role="alert" className="text-destructive">{error}</p>}
            <Button type="submit">重置密码</Button>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={creating} onOpenChange={(open) => { if (!saving) setCreating(open) }}>
        <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-xl">
          <DialogHeader><DialogTitle>新增员工</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div><Label htmlFor="new-username">用户名</Label>
              <Input id="new-username" value={draft.username}
                     onChange={(event) => setDraft({ ...draft, username: event.target.value })} /></div>
            <div><Label htmlFor="new-name">姓名</Label>
              <Input id="new-name" value={draft.display_name}
                     onChange={(event) => setDraft({ ...draft, display_name: event.target.value })} /></div>
            <div><Label htmlFor="new-department">部门</Label>
              <DepartmentSelect id="new-department" value={draft.department} items={departments}
                     onChange={(department) => setDraft({ ...draft, department })} /></div>
            {canManageRoles && <div><Label>内置身份</Label>
              <Select value={draft.role} onValueChange={(value) => setDraft({ ...draft, role: value === 'ADMIN' ? 'ADMIN' : 'EMPLOYEE' })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="EMPLOYEE">员工</SelectItem>
                  <SelectItem value="ADMIN">超级管理员</SelectItem>
                </SelectContent>
              </Select></div>}
            <div><Label htmlFor="new-password">初始密码（至少 12 位）</Label>
              <Input id="new-password" type="password" value={draft.password}
                     onChange={(event) => setDraft({ ...draft, password: event.target.value })} /></div>
            {roleFields(draft.role)}
            {error && <p role="alert" className="text-destructive">{error}</p>}
            <Button className="w-full" disabled={!canSave(draft.role)} onClick={() => void submitCreate()}>创建</Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={editing !== null} onOpenChange={(open) => { if (!open && !saving) setEditing(null) }}>
        <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-xl">
          <DialogHeader><DialogTitle>编辑员工</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div><Label htmlFor="edit-name">姓名</Label>
              <Input id="edit-name" value={editDraft.display_name}
                     onChange={(event) => setEditDraft({ ...editDraft, display_name: event.target.value })} /></div>
            <div><Label htmlFor="edit-department">部门</Label>
              <DepartmentSelect id="edit-department" value={editDraft.department} items={departments}
                     onChange={(department) => setEditDraft({ ...editDraft, department })} /></div>
            {canManageRoles && <div><Label>内置身份</Label>
              <Select value={editDraft.role} onValueChange={(value) => setEditDraft({ ...editDraft, role: value === 'ADMIN' ? 'ADMIN' : 'EMPLOYEE' })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="EMPLOYEE">员工</SelectItem>
                  <SelectItem value="ADMIN">超级管理员</SelectItem>
                </SelectContent>
              </Select></div>}
            {roleFields(editDraft.role)}
            {error && <p role="alert" className="text-destructive">{error}</p>}
            <Button className="w-full" disabled={!canSave(editDraft.role)} onClick={() => void submitEdit()}>保存</Button>
          </div>
        </DialogContent>
      </Dialog>
      {inspecting && <EffectivePermissionsDialog employee={inspecting} onClose={() => setInspecting(null)} />}
    </section>
  )
}

import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'

import EmployeeRoleFields from '@/components/EmployeeRoleFields'
import OptionSelect from '@/components/OptionSelect'
import { useConfirmation } from '@/components/ConfirmationProvider'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow, TableState } from '@/components/ui/table'
import { api, listAllEmployees, type AdminAssignment, type AdminRole, type Employee } from '@/lib/api'

const emptyRole: AdminRole = { code: '', name: '', permissions: [] }
const permissionGroups: Record<string, string> = {
  skills: '企业技能库',
  employees: '员工管理', models: '模型配置', grants: '模型开放范围',
  credits: '额度规则', usage: '用量与调用记录',
}

export default function RolesPage() {
  const confirm = useConfirmation()
  const [searchParams] = useSearchParams()
  const [catalog, setCatalog] = useState<Awaited<ReturnType<typeof api.roles.list>> | null>(null)
  const [employees, setEmployees] = useState<Employee[]>([])
  const [role, setRole] = useState(emptyRole)
  const [editing, setEditing] = useState(false)
  const [editorOpen, setEditorOpen] = useState(false)
  const [roleQuery, setRoleQuery] = useState('')
  const [employeeQuery, setEmployeeQuery] = useState('')
  const [userId, setUserId] = useState(() => {
    const selected = searchParams.get('employee') ?? ''
    return /^\d+$/.test(selected) ? selected : ''
  })
  const [assignments, setAssignments] = useState<AdminAssignment[]>([])
  const [loadedUser, setLoadedUser] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let active = true
    Promise.all([api.roles.list(), listAllEmployees()]).then(([data, people]) => {
      if (!active) return
      setCatalog(data)
      setEmployees(people)
    }).catch((caught: Error) => { if (active) setError(caught.message) })
    return () => { active = false }
  }, [])

  useEffect(() => {
    setLoadedUser('')
    setAssignments([])
    if (!userId) return
    let active = true
    api.roles.assignments(Number(userId)).then(({ items }) => {
      if (!active) return
      setAssignments(items)
      setLoadedUser(userId)
    }).catch((caught: Error) => { if (active) setError(caught.message) })
    return () => { active = false }
  }, [userId])

  async function change(action: () => Promise<void>, message: string) {
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await action()
      setNotice(message)
    } catch (caught) {
      setError((caught as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function saveRole() {
    if (!editing && catalog?.items.some((item) => item.code === role.code)) {
      throw new Error('该角色标识已存在，请使用其他标识。')
    }
    await api.roles.save(role.code, role.name, role.permissions)
    setCatalog(await api.roles.list())
    setRole(emptyRole)
    setEditing(false)
    setEditorOpen(false)
  }

  async function removeRole(item: AdminRole) {
    await api.roles.remove(item.code)
    setAssignments((current) => current.filter((assignment) => assignment.role !== item.code))
    setCatalog(await api.roles.list())
    if (role.code === item.code) {
      setRole(emptyRole)
      setEditing(false)
    }
  }

  const visibleRoles = catalog?.items.filter((item) =>
    `${item.name} ${item.code}`.toLowerCase().includes(roleQuery.trim().toLowerCase()),
  ) ?? []
  const groupedPermissions = new Map<string, NonNullable<typeof catalog>['permissions']>()
  for (const permission of catalog?.permissions ?? []) {
    const group = permission.code.split('.')[0]
    const entries = groupedPermissions.get(group) ?? []
    entries.push(permission)
    groupedPermissions.set(group, entries)
  }
  const implied = new Set(catalog?.permissions
    .filter((permission) => role.permissions.includes(permission.code))
    .flatMap((permission) => permission.implies ? [permission.implies] : []))
  function openEditor(item?: AdminRole) {
    setError('')
    setNotice('')
    setRole(item ?? emptyRole)
    setEditing(Boolean(item))
    setEditorOpen(true)
  }

  return (
    <section className="space-y-5">
      <header>
        <h1 className="text-lg font-semibold">角色与权限</h1>
        <p className="text-sm text-muted-foreground">员工可叠加多个角色。仅超级管理员可以配置角色和授权。</p>
      </header>
      {error && !editorOpen && <p role="alert" className="text-destructive">{error}</p>}
      {notice && <p role="status" className="text-success">{notice}</p>}
      {catalog === null ? <p>正在加载角色…</p> : (
        <>
          <section aria-labelledby="role-list" className="console-panel overflow-hidden">
            <div className="flex flex-wrap items-center justify-between gap-3 p-4">
              <h2 id="role-list" className="font-semibold">角色列表</h2>
              <div className="flex flex-wrap gap-2">
                <Input aria-label="搜索角色" placeholder="搜索角色名称或标识" className="w-auto"
                       value={roleQuery} onChange={(event) => setRoleQuery(event.target.value)} />
                <Button onClick={() => openEditor()}>新建角色</Button>
              </div>
            </div>
            <Table>
              <TableHeader><TableRow><TableHead>角色名称</TableHead><TableHead>角色标识</TableHead>
                <TableHead>显式权限</TableHead><TableHead>已授权员工</TableHead><TableHead className="text-right">操作</TableHead></TableRow></TableHeader>
              <TableBody>
                {visibleRoles.map((item) => (
                  <TableRow key={item.code}>
                    <TableCell className="font-medium">{item.name}</TableCell>
                    <TableCell className="font-mono text-xs">{item.code}</TableCell>
                    <TableCell>{item.permissions.length} 项</TableCell>
                    <TableCell>{item.member_count ?? 0} 人</TableCell>
                    <TableCell className="text-right"><Button variant="ghost" size="sm" onClick={() => openEditor(item)}>编辑权限</Button></TableCell>
                  </TableRow>
                ))}
                {visibleRoles.length === 0 &&
                  <TableState columns={5}>{roleQuery.trim() ? '没有匹配的角色' : '暂无自定义角色'}</TableState>}
              </TableBody>
            </Table>
          </section>

          <Dialog open={editorOpen} onOpenChange={(open) => { if (!busy) { setEditorOpen(open); setError('') } }}>
            <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-2xl">
              <DialogHeader>
                <DialogTitle>{editing ? '编辑角色权限' : '新建角色'}</DialogTitle>
                <DialogDescription>按模块配置操作权限。保存后会应用到已分配此角色的员工。</DialogDescription>
              </DialogHeader>
              {error && <p role="alert" className="text-destructive">{error}</p>}
          <form className="space-y-4"
                onSubmit={(event) => { event.preventDefault(); void change(saveRole, '角色已保存') }}>
            <label className="block">角色标识
              <Input required pattern="[a-z][a-z0-9_\-]{0,47}" maxLength={48} readOnly={editing}
                     value={role.code} onChange={(event) => setRole({ ...role, code: event.target.value })} />
            </label>
            <label className="block">角色名称
              <Input required maxLength={100} value={role.name}
                     onChange={(event) => setRole({ ...role, name: event.target.value })} />
            </label>
            {[...groupedPermissions].map(([group, permissions]) => (
            <fieldset key={group} className="grid gap-3 rounded-md border px-3 pb-3 sm:grid-cols-2" disabled={busy}>
              <legend className="px-1 font-semibold">{permissionGroups[group] ?? group}</legend>
              {permissions.map((permission) => (
                <label key={permission.code} className="flex items-center gap-2 text-sm">
                  <Checkbox checked={implied.has(permission.code) || role.permissions.includes(permission.code)}
                    disabled={busy || implied.has(permission.code)}
                    onCheckedChange={(checked) => setRole((draft) => ({
                      ...draft,
                      permissions: checked ? [...draft.permissions, permission.code]
                        : draft.permissions.filter((item) => item !== permission.code),
                    }))} />
                  <span>{permission.name}<small className="ml-1 text-muted-foreground">
                    {implied.has(permission.code) ? '自动包含' : permission.department_scoped ? '支持部门' : '仅全局'}
                  </small></span>
                </label>
              ))}
            </fieldset>
            ))}
            <p className="text-xs text-muted-foreground">写入类权限包含对应的查看权限。部门授权只启用标注「可限部门」的权限。</p>
            <div className="flex gap-2">
              <Button disabled={busy} type="submit">保存角色</Button>
              {editing && <Button type="button" variant="destructive" disabled={busy} onClick={async () => {
                if (await confirm(`删除「${role.name}」？`, `将撤销该角色关联的授权，列表中共有 ${role.member_count ?? 0} 名员工使用此角色。`, '删除角色')) {
                  void change(async () => { await removeRole(role); setEditorOpen(false) }, '角色已删除')
                }
              }}>删除角色</Button>}
            </div>
          </form>
            </DialogContent>
          </Dialog>

          <div className="space-y-3 rounded-md border border-border bg-card p-4">
            <h2 className="font-semibold">员工角色授权</h2>
            <Input aria-label="筛选员工" placeholder="按姓名、账号或部门筛选员工" className="max-w-sm"
                   value={employeeQuery} onChange={(event) => setEmployeeQuery(event.target.value)} />
            <div className="max-w-sm">
              <OptionSelect label="员工" value={userId} disabled={busy} emptyLabel="请选择员工"
                onChange={setUserId} options={employees.filter((employee) => employee.role !== 'ADMIN' &&
                  (String(employee.id) === userId || `${employee.display_name} ${employee.username} ${employee.department ?? ''}`.toLowerCase().includes(employeeQuery.trim().toLowerCase())))
                  .map((employee) => ({ value: String(employee.id), label: `${employee.display_name} · ${employee.username}` }))} />
            </div>
            {userId !== '' && loadedUser === userId && (
              <>
                <EmployeeRoleFields key={userId} catalog={catalog} value={assignments}
                  onChange={setAssignments} disabled={busy} />
                <Button disabled={busy} onClick={() => void change(async () => {
                  const result = await api.roles.assign(Number(userId), assignments)
                  setAssignments(result.items)
                  setCatalog(await api.roles.list())
                }, '员工授权已保存')}>保存员工授权</Button>
              </>
            )}
          </div>
        </>
      )}
    </section>
  )
}

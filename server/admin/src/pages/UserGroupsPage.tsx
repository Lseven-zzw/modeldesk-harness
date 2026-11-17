import { useEffect, useState } from 'react'

import { useConfirmation } from '@/components/ConfirmationProvider'
import EmployeeRoleFields, { type RoleCatalog } from '@/components/EmployeeRoleFields'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow, TableState } from '@/components/ui/table'
import { api, listAllEmployees, type Employee, type UserGroup } from '@/lib/api'

export default function UserGroupsPage() {
  const confirm = useConfirmation()
  const [groups, setGroups] = useState<UserGroup[] | null>(null)
  const [employees, setEmployees] = useState<Employee[]>([])
  const [catalog, setCatalog] = useState<RoleCatalog | null>(null)
  const [draft, setDraft] = useState<UserGroup | null>(null)
  const [search, setSearch] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true
    Promise.all([api.groups.list(), listAllEmployees(), api.roles.list()]).then(
      ([{ items }, people, roles]) => {
        if (active) { setGroups(items); setEmployees(people); setCatalog(roles) }
      },
      (caught: Error) => { if (active) setError(caught.message) },
    )
    return () => { active = false }
  }, [])

  function open(group: UserGroup) {
    setSearch('')
    setError('')
    setDraft(group)
  }

  async function save(group: UserGroup) {
    setBusy(true)
    setError('')
    try {
      const saved = await api.groups.save(group)
      setGroups((items) => [...(items ?? []).filter((item) => item.id !== saved.id), saved]
        .sort((left, right) => left.name.localeCompare(right.name, 'zh-CN')))
      setDraft(null)
    } catch (caught) {
      setError((caught as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function remove(group: UserGroup) {
    if (!await confirm(`删除「${group.name}」？`,
      `组内 ${group.member_ids.length} 名成员将失去由此组授予的角色。`, '删除用户组')) return
    setBusy(true)
    setError('')
    try {
      await api.groups.remove(group.id)
      setGroups((items) => items?.filter((item) => item.id !== group.id) ?? null)
    } catch (caught) {
      setError((caught as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return <section className="flex flex-col gap-5">
    <header className="justify-between">
      <div><h1>用户组</h1><p className="text-muted-foreground">通过用户组为一批员工分配后台角色。</p></div>
      <Button disabled={!catalog || busy} onClick={() => open({ id: 0, name: '', member_ids: [], assignments: [] })}>新建用户组</Button>
    </header>
    {error && !draft && <p role="alert" className="text-destructive">{error}</p>}
    <div className="console-panel">
      <Table>
        <TableHeader><TableRow><TableHead>用户组</TableHead><TableHead>成员</TableHead>
          <TableHead>授权项</TableHead><TableHead className="text-right">操作</TableHead></TableRow></TableHeader>
        <TableBody>{groups?.map((group) => <TableRow key={group.id}>
          <TableCell className="font-medium">{group.name}</TableCell>
          <TableCell>{group.member_ids.length} 人</TableCell><TableCell>{group.assignments.length} 项</TableCell>
          <TableCell className="whitespace-nowrap text-right">
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => open(group)}>编辑</Button>
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => void remove(group)}>删除</Button>
          </TableCell>
        </TableRow>)}
        {!groups?.length && <TableState columns={4} loading={groups === null && !error}>
          {groups ? '暂无用户组' : error ? '无法加载用户组' : '正在加载…'}
        </TableState>}</TableBody>
      </Table>
    </div>
    <Dialog open={draft !== null} onOpenChange={(open) => { if (!open && !busy) setDraft(null) }}>
      {draft && catalog && <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-xl">
        <DialogHeader><DialogTitle>{draft.id ? '编辑用户组' : '新建用户组'}</DialogTitle>
          <DialogDescription>组角色与员工直接分配的角色合并生效。</DialogDescription></DialogHeader>
        <form className="flex flex-col gap-4" onSubmit={(event) => { event.preventDefault(); if (!busy) void save(draft) }}>
          <label>用户组名称<Input value={draft.name} maxLength={100} required disabled={busy}
            onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label>
          <fieldset className="flex flex-col gap-2 rounded-md border p-3" disabled={busy}>
            <legend className="px-1 font-semibold">成员 · 已选 {draft.member_ids.length} 人</legend>
            <Input aria-label="筛选员工" placeholder="按姓名或账号筛选" value={search}
              onChange={(event) => setSearch(event.target.value)} />
            <div className="grid max-h-40 gap-2 overflow-y-auto sm:grid-cols-2">
              {employees.filter((employee) => `${employee.display_name} ${employee.username}`.toLowerCase()
                .includes(search.trim().toLowerCase())).map((employee) => <label key={employee.id} className="flex items-center gap-2">
                <Checkbox checked={draft.member_ids.includes(employee.id)}
                  onCheckedChange={(checked) => setDraft({ ...draft, member_ids: checked
                    ? [...draft.member_ids, employee.id] : draft.member_ids.filter((id) => id !== employee.id) })} />
                {employee.display_name} · {employee.username}
              </label>)}
            </div>
          </fieldset>
          <EmployeeRoleFields catalog={catalog} value={draft.assignments} disabled={busy}
            onChange={(assignments) => setDraft({ ...draft, assignments })} />
          {error && <p role="alert" className="text-destructive">{error}</p>}
          <Button type="submit" disabled={busy}>保存用户组</Button>
        </form>
      </DialogContent>}
    </Dialog>
  </section>
}

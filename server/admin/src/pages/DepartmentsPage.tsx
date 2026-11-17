import { useEffect, useState } from 'react'

import OptionSelect from '@/components/OptionSelect'
import { useConfirmation } from '@/components/ConfirmationProvider'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow, TableState } from '@/components/ui/table'
import { api, type Department } from '@/lib/api'

function departmentRows(items: Department[]) {
  const ids = new Set(items.map((item) => item.id))
  const byParent = new Map<number | null, Department[]>()
  for (const item of items) {
    const parent = item.parent_id !== null && ids.has(item.parent_id) ? item.parent_id : null
    const siblings = byParent.get(parent) ?? []
    siblings.push(item)
    byParent.set(parent, siblings)
  }
  const rows: { item: Department; depth: number }[] = []
  function visit(parent: number | null, depth: number) {
    for (const item of byParent.get(parent) ?? []) {
      rows.push({ item, depth })
      visit(item.id, depth + 1)
    }
  }
  visit(null, 0)
  return rows
}

export default function DepartmentsPage({ canManage }: { canManage: boolean }) {
  const confirm = useConfirmation()
  const [items, setItems] = useState<Department[] | null>(null)
  const [error, setError] = useState('')
  const [draft, setDraft] = useState<Omit<Department, 'members'> | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let active = true
    api.departments.list().then(
      ({ items }) => { if (active) setItems(items) },
      (error: Error) => { if (active) setError(error.message) },
    )
    return () => { active = false }
  }, [])

  async function save() {
    if (!draft || busy) return
    setBusy(true)
    setError('')
    try {
      const saved = draft.id
        ? await api.departments.update(draft.id, draft.name, draft.parent_id)
        : await api.departments.create(draft.code, draft.name, draft.parent_id)
      setItems((current) => {
        const previous = current?.find((item) => item.id === saved.id)
        return [...(current ?? []).filter((item) => item.id !== saved.id), { ...saved, members: previous?.members ?? 0 }]
          .sort((left, right) => left.name.localeCompare(right.name, 'zh-CN'))
      })
      setDraft(null)
    } catch (caught) {
      setError((caught as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function changeStatus(item: Department) {
    const action = item.archived ? '恢复' : '归档'
    if (!await confirm(`${action}「${item.name}」？`, item.archived
      ? '恢复后可重新用于员工归属和授权。'
      : '部门没有成员、有效下级或关联授权时才能归档。', action, !item.archived)) return
    setBusy(true)
    setError('')
    try {
      const status = await api.departments.setArchived(item.id, !item.archived)
      setItems((current) => current?.map((row) => row.id === item.id ? { ...row, ...status } : row) ?? null)
    } catch (caught) {
      setError((caught as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="space-y-5">
      <header className="justify-between">
        <div>
          <h1>部门管理</h1>
          <p className="mt-1 text-muted-foreground">维护组织层级和员工归属。分配角色时可选择是否包含下级部门。</p>
        </div>
        {canManage && <Button disabled={items === null || busy} onClick={() => {
          setError(''); setDraft({ id: 0, code: '', name: '', parent_id: null, archived: false })
        }}>新建部门</Button>}
      </header>
      {error && !draft && <p role="alert" className="text-destructive">{error}</p>}
      <div className="console-panel">
        <Table>
          <TableHeader><TableRow><TableHead>部门名称</TableHead><TableHead>部门标识</TableHead>
            <TableHead>成员数</TableHead>{canManage && <TableHead className="text-right">操作</TableHead>}</TableRow></TableHeader>
          <TableBody>
            {departmentRows(items ?? []).map(({ item, depth }) => <TableRow key={item.id}>
              <TableCell className="font-medium"><span style={{ paddingInlineStart: Math.min(depth, 8) * 16 }}>
                {depth > 0 && <span aria-hidden="true" className="mr-2 text-muted-foreground">↳</span>}{item.name}
              </span>{item.archived && <Badge className="ml-2" variant="secondary">已归档</Badge>}</TableCell>
              <TableCell className="font-mono text-xs">{item.code}</TableCell>
              <TableCell>{item.members}</TableCell>
              {canManage && <TableCell className="whitespace-nowrap text-right">
                {!item.archived && <Button disabled={busy} size="sm" variant="ghost" onClick={() => { setError(''); setDraft(item) }}>编辑</Button>}
                <Button disabled={busy} size="sm" variant="ghost" onClick={() => void changeStatus(item)}>{item.archived ? '恢复' : '归档'}</Button>
              </TableCell>}
            </TableRow>)}
            {!items?.length && <TableState columns={canManage ? 4 : 3} loading={items === null && !error}>
              {items ? '暂无部门' : error ? '无法加载部门' : '正在加载部门…'}
            </TableState>}
          </TableBody>
        </Table>
      </div>
      <Dialog open={draft !== null} onOpenChange={(open) => { if (!open && !busy) { setDraft(null); setError('') } }}>
        {draft && <DialogContent>
          <DialogHeader>
            <DialogTitle>{draft.id ? '编辑部门' : '新建部门'}</DialogTitle>
            <DialogDescription>部门标识用于成员归属和授权，创建后固定。</DialogDescription>
          </DialogHeader>
          <form className="grid gap-3" onSubmit={(event) => { event.preventDefault(); void save() }}>
            <label>部门名称<Input value={draft.name} required maxLength={100}
              onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label>
            <label>部门标识<Input value={draft.code} required readOnly={Boolean(draft.id)}
              pattern={draft.id ? undefined : '[a-z][a-z0-9_\\-]{0,63}'}
              onChange={(event) => setDraft({ ...draft, code: event.target.value })} /></label>
            <OptionSelect label="上级部门" value={draft.parent_id === null ? '' : String(draft.parent_id)}
              emptyLabel="无上级部门" disabled={busy}
              options={departmentRows(items ?? []).filter(({ item }) => item.id !== draft.id && !item.archived)
                .map(({ item, depth }) => ({ value: String(item.id), label: `${'　'.repeat(Math.min(depth, 8))}${item.name}` }))}
              onChange={(value) => setDraft({ ...draft, parent_id: value ? Number(value) : null })} />
            {error && <p role="alert" className="text-destructive">{error}</p>}
            <Button type="submit" disabled={busy}>保存部门</Button>
          </form>
        </DialogContent>}
      </Dialog>
    </section>
  )
}

import { useEffect, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow, TableState } from '@/components/ui/table'
import { api, type AuthorizationAudit } from '@/lib/api'
import { utcTime } from '@/lib/format'

const actions: Record<string, string> = {
  'role.save': '保存角色',
  'role.delete': '删除角色',
  'group.save': '保存用户组',
  'group.delete': '删除用户组',
  'employee.roles': '调整员工角色',
  'employee.identity': '调整内置身份',
  'employee.department': '调整员工部门',
  'employee.status': '调整员工状态',
  'department.create': '新建部门',
  'department.rename': '部门改名',
  'department.move': '移动部门',
  'department.archive': '归档部门',
  'department.restore': '恢复部门',
  'model.grants': '修改模型开放范围',
  'model.delegations': '修改模型管理权限',
  'skill.publish': '发布企业技能',
  'skill.unpublish': '下架企业技能',
  'skill.draft.save': '保存企业技能草稿',
  'skill.draft.discard': '丢弃企业技能草稿',
  'skill.import': '导入企业技能',
  'skill.attachment': '修改企业技能附件',
  'credit.create': '新增额度规则',
  'credit.delete': '删除额度规则',
}

export default function AuthorizationAuditPage() {
  const [page, setPage] = useState<Awaited<ReturnType<typeof api.roles.audit>> | null>(null)
  const [cursors, setCursors] = useState<number[]>([])
  const [selected, setSelected] = useState<AuthorizationAudit | null>(null)
  const [error, setError] = useState('')
  const before = cursors.at(-1)

  useEffect(() => {
    let active = true
    api.roles.audit(before).then(
      (result) => { if (active) setPage(result) },
      (caught: Error) => { if (active) setError(caught.message) },
    )
    return () => { active = false }
  }, [before])

  return <section className="flex flex-col gap-5">
    <header><div><h1>授权审计</h1><p className="text-muted-foreground">查看权限管理变更及变更前后的配置。</p></div></header>
    {error && <p role="alert" className="text-destructive">{error}</p>}
    <div className="console-panel">
      <Table>
        <TableHeader><TableRow><TableHead>时间</TableHead><TableHead>操作人 ID</TableHead>
          <TableHead>操作</TableHead><TableHead>目标</TableHead><TableHead>变更</TableHead></TableRow></TableHeader>
        <TableBody>
          {page?.items.map((item) => <TableRow key={item.id}>
            <TableCell>{utcTime(item.created_at)}</TableCell><TableCell>{item.actor_id}</TableCell>
            <TableCell>{actions[item.action] ?? item.action}</TableCell><TableCell>{item.target}</TableCell>
            <TableCell><Button size="sm" variant="ghost" onClick={() => setSelected(item)}>查看详情</Button></TableCell>
          </TableRow>)}
          {!page?.items.length && <TableState columns={5} loading={page === null && !error}>
            {error ? '加载失败' : page ? '暂无审计记录' : '正在加载…'}
          </TableState>}
        </TableBody>
      </Table>
    </div>
    <div className="flex justify-end gap-2">
      <Button variant="outline" disabled={!cursors.length} onClick={() => {
        setError(''); setPage(null); setCursors(cursors.slice(0, -1))
      }}>上一页</Button>
      <Button variant="outline" disabled={!page?.next_before} onClick={() => {
        if (page?.next_before) { setError(''); setPage(null); setCursors([...cursors, page.next_before]) }
      }}>下一页</Button>
    </div>
    <Dialog open={selected !== null} onOpenChange={(open) => { if (!open) setSelected(null) }}>
      {selected && <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader><DialogTitle>{actions[selected.action] ?? selected.action}</DialogTitle>
          <DialogDescription>目标 {selected.target} · 操作人 ID {selected.actor_id}</DialogDescription></DialogHeader>
        {(['before', 'after'] as const).map((key) => <section key={key}>
          <h2 className="mb-2 font-medium">{key === 'before' ? '变更前' : '变更后'}</h2>
          <pre className="whitespace-pre-wrap break-all rounded-md bg-muted p-3 text-xs">
            {selected.details[key] == null ? '无' : JSON.stringify(selected.details[key], null, 2)}
          </pre>
        </section>)}
      </DialogContent>}
    </Dialog>
  </section>
}

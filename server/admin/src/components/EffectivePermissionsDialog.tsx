import { useEffect, useState } from 'react'

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { api, type Employee, type EmployeeCapabilities } from '@/lib/api'

const subjectType = { USER: '直接授权', DEPARTMENT: '部门', GROUP: '用户组' }

const sourceLabels = { USER: '个人授权', DEPARTMENT: '部门', GROUP: '用户组', EVERYONE: '全员', ADMIN: '内置管理员' }
const sections = [
  ['models', '可用模型', '/admin/models'],
  ['skills', '企业技能', '/admin/enterprise-skills'],
  ['documents', '企业资料', '/admin/enterprise-documents'],
  ['mcp', '企业 MCP', '/admin/enterprise-mcp'],
] as const
const tokens = new Intl.NumberFormat('zh-CN')

function CapabilityList({ capabilities }: { capabilities: EmployeeCapabilities }) {
  return <div className="grid gap-3 sm:grid-cols-2">
    {sections.map(([key, title, href]) => <section key={key} className="min-w-0 rounded-lg border p-3">
      <header className="mb-2 flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">{title} <span className="font-normal text-muted-foreground">{capabilities[key].length}</span></h2>
        <a className="text-xs text-primary underline" href={href}>管理</a>
      </header>
      {capabilities[key].length === 0 ? <p className="text-xs text-muted-foreground">当前无可用资源</p>
        : <ul className="max-h-56 divide-y overflow-y-auto">
          {capabilities[key].map(item => <li className="space-y-1 py-2 text-sm" key={item.id}>
            <p className="break-words font-medium">{item.name}</p>
            <p className="text-xs text-muted-foreground">{item.sources.map(source =>
              source.type === 'EVERYONE' || source.type === 'ADMIN' ? source.name : `${sourceLabels[source.type]} · ${source.name}`).join('、')}</p>
            {'limit' in item && <p className="text-xs">本月已用 {tokens.format(item.used)} / {tokens.format(item.limit)} Token</p>}
            {'tools' in item && <p className="break-words text-xs">{item.tools.length ? item.tools.map(tool =>
              `${tool.name}（${tool.access === 'write' ? '写入' : '只读'}）`).join('、') : '暂无已启用工具'}</p>}
          </li>)}
        </ul>}
    </section>)}
  </div>
}

export default function EffectivePermissionsDialog({ employee, onClose }: { employee: Employee; onClose: () => void }) {
  const [result, setResult] = useState<Awaited<ReturnType<typeof api.roles.effective>> | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    let active = true
    api.roles.effective(employee.id).then(
      (data) => { if (active) setResult(data) },
      (caught: Error) => { if (active) setError(caught.message) },
    )
    return () => { active = false }
  }, [employee.id])

  return <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
    <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-3xl">
      <DialogHeader><DialogTitle>有效权限 · {employee.display_name}</DialogTitle>
        <DialogDescription>查看该员工实际可用的企业资源、额度与授权来源，以及后台操作权限。</DialogDescription>
      </DialogHeader>
      {error && <p role="alert" className="text-destructive">{error}</p>}
      {!result && !error && <p role="status">正在查询权限…</p>}
      {result?.active && <CapabilityList capabilities={result.capabilities} />}
      {result && !result.items.length && !result.model_items.length && <p className="text-muted-foreground">
        {result.active ? '该员工没有后台管理权限。' : '该账号已停用，后台权限不生效。'}
      </p>}
      {result && result.items.length > 0 && <Table>
        <TableHeader><TableRow><TableHead>操作权限</TableHead><TableHead>授权范围</TableHead>
          <TableHead>来源角色</TableHead><TableHead>授予方式</TableHead></TableRow></TableHeader>
        <TableBody>{result.items.map((item) => <TableRow key={JSON.stringify(item)}>
          <TableCell>{item.name}</TableCell><TableCell>{item.department_name ?? item.department ?? '全局'}
            {item.scope_root !== null && <div className="text-xs text-muted-foreground">
              {item.scope_root_name ?? item.scope_root}及下级
            </div>}
          </TableCell>
          <TableCell>{item.role_name ?? item.role ?? '内置超级管理员'}
            {item.group_id !== null && <div className="text-xs text-muted-foreground">用户组：{item.group_name ?? item.group_id}</div>}
          </TableCell>
          <TableCell>{item.permission === item.granted_permission ? '直接授予' : `由 ${item.granted_permission} 自动包含`}</TableCell>
        </TableRow>)}</TableBody>
      </Table>}
      {result && result.model_items.length > 0 && <section className="flex flex-col gap-2">
        <h2 className="font-semibold">单模型委派</h2>
        <Table>
          <TableHeader><TableRow><TableHead>模型</TableHead><TableHead>操作权限</TableHead><TableHead>授权来源</TableHead></TableRow></TableHeader>
          <TableBody>{result.model_items.map((item) => <TableRow key={JSON.stringify(item)}>
            <TableCell>{item.model_name}</TableCell><TableCell>{item.name}</TableCell>
            <TableCell>{subjectType[item.subject_type]} · {item.subject_name ?? item.subject_id}{item.include_descendants ? '及下级' : ''}</TableCell>
          </TableRow>)}</TableBody>
        </Table>
      </section>}
    </DialogContent>
  </Dialog>
}

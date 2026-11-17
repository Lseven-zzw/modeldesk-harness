import { useEffect, useState } from 'react'

import OptionSelect from '@/components/OptionSelect'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow, TableState } from '@/components/ui/table'
import { Textarea } from '@/components/ui/textarea'
import { api, type McpServer, type McpServerBody, type SkillAudienceType } from '@/lib/api'

const audienceNames: Record<SkillAudienceType, string> = { EVERYONE: '全员', DEPARTMENT: '部门', GROUP: '用户组', USER: '员工' }
const audienceTypes = Object.entries(audienceNames).map(([value, label]) => ({ value, label }))
const accessOptions = [{ value: 'read', label: '只读' }, { value: 'write', label: '读写' }]
const emptyServer: McpServer = {
  id: 0, name: '', endpoint: '', description: '', guide: '', token_masked: null,
  enabled: true, revision: 0, grants: [], tools: [], discovered_at: null,
}

export default function EnterpriseMcpPage({ canManage }: { canManage: boolean }) {
  const [items, setItems] = useState<McpServer[] | null>(null)
  const [options, setOptions] = useState<Awaited<ReturnType<typeof api.mcp.options>>>({ USER: [], DEPARTMENT: [], GROUP: [] })
  const [draft, setDraft] = useState<McpServer | null>(null)
  const [tokenInput, setTokenInput] = useState('')
  const [clearToken, setClearToken] = useState(false)
  const [audience, setAudience] = useState<SkillAudienceType>('EVERYONE')
  const [subject, setSubject] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void api.mcp.list().then(({ items }) => setItems(items)).catch((caught: Error) => setError(caught.message))
    if (canManage) void api.mcp.options().then(setOptions).catch((caught: Error) => setError(caught.message))
  }, [canManage])

  async function run(action: () => Promise<void>) {
    setBusy(true)
    setError('')
    try {
      await action()
    } catch (caught) {
      setError((caught as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function load() {
    setItems((await api.mcp.list()).items)
  }

  function open(server: McpServer | null) {
    setAudience('EVERYONE')
    setSubject('')
    setTokenInput('')
    setClearToken(false)
    setError('')
    setDraft(server)
  }

  function update(patch: Partial<McpServer>) {
    setDraft((current) => current && { ...current, ...patch })
  }

  function updateTool(name: string, patch: Partial<Pick<McpServer['tools'][number], 'enabled' | 'access'>>) {
    setDraft((current) => current && {
      ...current,
      tools: current.tools.map((tool) => tool.name === name ? { ...tool, ...patch } : tool),
    })
  }

  async function save() {
    if (!draft) return
    const body: McpServerBody = {
      name: draft.name, endpoint: draft.endpoint, description: draft.description,
      guide: draft.guide, enabled: draft.enabled, grants: draft.grants,
    }
    if (clearToken) body.token = ''
    else if (tokenInput.trim()) body.token = tokenInput
    if (draft.id) {
      await api.mcp.update(draft.id, draft.revision, {
        ...body, tools: draft.tools.map(({ name, enabled, access }) => ({ name, enabled, access })),
      })
    } else await api.mcp.create(body)
    open(null)
    await load()
  }

  return <section className="grid gap-4">
    <header className="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-lg font-semibold">企业 MCP</h1>
        <p className="mt-1 text-sm text-muted-foreground">接入企业 MCP 服务，按工具控制开放范围；员工在 Harness 中经服务端代理调用，凭据不下发。</p>
      </div>
      {canManage && <Button disabled={busy || !items} onClick={() => open(emptyServer)}>添加服务</Button>}
    </header>
    {error && !draft && <p role="alert" className="text-sm text-destructive">{error}</p>}
    <div className="console-panel">
      <Table>
        <TableHeader><TableRow>
          <TableHead>服务名称</TableHead><TableHead>状态</TableHead><TableHead>工具</TableHead>
          <TableHead>最近发现</TableHead><TableHead className="text-right">操作</TableHead>
        </TableRow></TableHeader>
        <TableBody>
          {items?.map((item) => <TableRow key={item.id}>
            <TableCell><div className="font-medium">{item.name}</div>
              <div className="max-w-72 truncate text-xs text-muted-foreground" title={item.endpoint}>{item.endpoint}</div>
            </TableCell>
            <TableCell><Badge variant={item.enabled ? 'default' : 'secondary'}>{item.enabled ? '启用' : '停用'}</Badge></TableCell>
            <TableCell className="whitespace-nowrap text-muted-foreground">
              {item.tools.filter((tool) => tool.enabled).length} / {item.tools.length} 开放
            </TableCell>
            <TableCell className="whitespace-nowrap text-muted-foreground">
              {item.discovered_at ? new Date(item.discovered_at).toLocaleString() : '未测试'}
            </TableCell>
            <TableCell className="text-right">
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => void run(async () => open(await api.mcp.read(item.id)))}>
                {canManage ? '查看与编辑' : '查看'}
              </Button>
            </TableCell>
          </TableRow>)}
          {!items?.length && <TableState columns={5} loading={!items && !error}>
            {error ? '无法加载 MCP 服务' : !items ? '正在加载…' : '暂无 MCP 服务'}
          </TableState>}
        </TableBody>
      </Table>
    </div>
    <Dialog open={Boolean(draft)} onOpenChange={(openDialog) => { if (!openDialog && !busy) open(null) }}>
      {draft && <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{draft.id ? (canManage ? '查看与编辑 MCP 服务' : draft.name) : '添加 MCP 服务'}</DialogTitle>
          <DialogDescription>支持 Streamable HTTP 协议的服务。新发现的工具默认停用，需逐个启用并设置只读 / 读写。</DialogDescription>
        </DialogHeader>
        {canManage ? <form className="grid gap-4" onSubmit={(event) => { event.preventDefault(); if (!busy) void run(save) }}>
          <label className="grid gap-2 text-sm font-medium">服务名称
            <Input required maxLength={100} value={draft.name} onChange={(event) => update({ name: event.target.value })} />
          </label>
          <label className="grid gap-2 text-sm font-medium">服务地址
            <Input required maxLength={512} placeholder="https://mcp.example.com/mcp" value={draft.endpoint}
              onChange={(event) => update({ endpoint: event.target.value })} />
          </label>
          <label className="grid gap-2 text-sm font-medium">服务说明
            <Textarea rows={2} maxLength={4000} value={draft.description} onChange={(event) => update({ description: event.target.value })} />
          </label>
          <label className="grid gap-2 text-sm font-medium">使用说明（随工具下发给模型）
            <Textarea rows={4} maxLength={20000} placeholder="例如：查询工单时先用 search_tickets 获取编号，再用 get_ticket 查看详情。"
              value={draft.guide} onChange={(event) => update({ guide: event.target.value })} />
            <span className="text-xs font-normal text-muted-foreground">
              建议写明服务用途、工具调用示例、写入范围和常见错误。标记为读写的工具在 Harness 中需员工确认后才会执行。
            </span>
          </label>
          <div className="grid gap-2">
            <Label htmlFor="mcp-token">访问凭据（Bearer Token，可选）</Label>
            {draft.token_masked && <p className="text-xs text-muted-foreground">
              当前凭据 {draft.token_masked}，留空保持不变。
              <Button type="button" size="sm" variant="ghost" className="ml-1 h-6 px-2" disabled={busy}
                onClick={() => { setClearToken(!clearToken); setTokenInput('') }}>
                {clearToken ? '取消清除' : '清除凭据'}
              </Button>
            </p>}
            {clearToken
              ? <p className="text-sm text-muted-foreground">保存后将清除凭据，以匿名方式访问服务。</p>
              : <Input id="mcp-token" type="password" maxLength={512} autoComplete="new-password" value={tokenInput}
                placeholder={draft.token_masked ? '输入新凭据以替换' : '可选，服务要求认证时填写'}
                onChange={(event) => setTokenInput(event.target.value)} />}
          </div>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={draft.enabled} onCheckedChange={(value) => update({ enabled: value === true })} />启用服务
          </label>
          <fieldset className="grid gap-3 rounded-md border p-3">
            <legend className="px-1 text-sm font-medium">开放范围</legend>
            {!draft.grants.length && <p className="text-sm text-muted-foreground">暂无授权对象。</p>}
            {draft.grants.map((grant) => <div className="flex justify-between gap-2" key={`${grant.subject_type}:${grant.subject_id}`}>
              <span className="text-sm">{audienceNames[grant.subject_type]}
                {grant.subject_type !== 'EVERYONE' && ` · ${options[grant.subject_type].find((item) => item.id === grant.subject_id)?.name ?? grant.subject_id}`}
              </span>
              <Button type="button" size="sm" variant="ghost" onClick={() => update({ grants: draft.grants.filter((item) => item !== grant) })}>移除</Button>
            </div>)}
            <div className="flex flex-wrap gap-2">
              <OptionSelect label="授权类型" value={audience} options={audienceTypes} emptyLabel="选择类型"
                onChange={(value) => { if (value) { setAudience(value as SkillAudienceType); setSubject('') } }} />
              {audience !== 'EVERYONE' && <OptionSelect label="授权对象" value={subject} emptyLabel="选择对象"
                options={options[audience].map((item) => ({ value: String(item.id), label: item.name }))} onChange={setSubject} />}
              <Button type="button" variant="outline" disabled={(!subject && audience !== 'EVERYONE') ||
                draft.grants.some((grant) => grant.subject_type === audience && grant.subject_id === Number(subject))}
                onClick={() => update({ grants: [...draft.grants, { subject_type: audience, subject_id: Number(subject) }] })}>添加范围</Button>
            </div>
          </fieldset>
          {draft.id && <fieldset className="grid gap-3 rounded-md border p-3">
            <legend className="px-1 text-sm font-medium">工具配置</legend>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm text-muted-foreground">
                {draft.discovered_at ? `最近发现：${new Date(draft.discovered_at).toLocaleString()}` : '尚未测试连接。'}
              </p>
              <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void run(async () => {
                const view = await api.mcp.discover(draft.id)
                setDraft((current) => current && { ...current, ...view })
              })}>测试连接并发现工具</Button>
            </div>
            {!draft.tools.length && <p className="text-sm text-muted-foreground">暂无工具，请先测试连接。</p>}
            {draft.tools.map((tool) => <div className="grid gap-2 rounded-md border p-3" key={tool.name}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-mono text-sm font-medium">{tool.name}</span>
                <div className="flex items-center gap-3">
                  <OptionSelect label={`${tool.name} 访问级别`} value={tool.access} options={accessOptions} emptyLabel="选择级别"
                    onChange={(value) => { if (value === 'read' || value === 'write') updateTool(tool.name, { access: value }) }} />
                  <label className="flex items-center gap-2 text-sm">
                    <Checkbox checked={tool.enabled} onCheckedChange={(value) => updateTool(tool.name, { enabled: value === true })} />开放
                  </label>
                </div>
              </div>
              {tool.description && <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">{tool.description}</p>}
            </div>)}
          </fieldset>}
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          <Button className="justify-self-end" type="submit" disabled={busy}>保存服务</Button>
        </form> : <div className="grid gap-3 text-sm">
          <p className="text-muted-foreground [overflow-wrap:anywhere]">地址：{draft.endpoint}</p>
          {draft.description && <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{draft.description}</p>}
          {draft.guide && <pre className="min-w-0 whitespace-pre-wrap rounded-md bg-muted p-3 [overflow-wrap:anywhere]">{draft.guide}</pre>}
          <div className="grid gap-2">
            {draft.tools.map((tool) => <div className="flex flex-wrap items-center gap-2" key={tool.name}>
              <span className="font-mono">{tool.name}</span>
              <Badge variant={tool.enabled ? 'default' : 'secondary'}>{tool.enabled ? '开放' : '停用'}</Badge>
              <Badge variant="outline">{tool.access === 'read' ? '只读' : '读写'}</Badge>
            </div>)}
            {!draft.tools.length && <p className="text-muted-foreground">暂无已发现的工具。</p>}
          </div>
        </div>}
      </DialogContent>}
    </Dialog>
  </section>
}
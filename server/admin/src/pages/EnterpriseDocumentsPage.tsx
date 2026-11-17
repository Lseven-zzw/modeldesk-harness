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
import { api, type EnterpriseDocumentBody, type EnterpriseDocumentSummary, type SkillAudienceType } from '@/lib/api'

const audienceNames: Record<SkillAudienceType, string> = { EVERYONE: '全员', DEPARTMENT: '部门', GROUP: '用户组', USER: '员工' }
const audienceTypes = Object.entries(audienceNames).map(([value, label]) => ({ value, label }))
const emptyDocument: EnterpriseDocumentBody = { title: '', content: '', enabled: true, format: 'markdown', grants: [] }
const parseStatuses: Record<string, string> = {
  pending: '等待解析', ready: '可检索', failed: '解析失败', original_only: '仅原件', truncated: '正文已截断',
}

export default function EnterpriseDocumentsPage({ canManage }: { canManage: boolean }) {
  const [items, setItems] = useState<EnterpriseDocumentSummary[] | null>(null)
  const [options, setOptions] = useState<Awaited<ReturnType<typeof api.documents.options>>>({ USER: [], DEPARTMENT: [], GROUP: [] })
  const [query, setQuery] = useState('')
  const [activeQuery, setActiveQuery] = useState('')
  const [next, setNext] = useState<number | null>(null)
  const [draft, setDraft] = useState<(EnterpriseDocumentBody & { id?: number; revision?: number }) | null>(null)
  const [audience, setAudience] = useState<SkillAudienceType>('EVERYONE')
  const [subject, setSubject] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [files, setFiles] = useState<File[]>([])

  useEffect(() => {
    void api.documents.list('').then(({ items, next_before }) => {
      setItems(items)
      setNext(next_before)
    }).catch((caught: Error) => setError(caught.message))
    if (canManage) void api.documents.options().then(setOptions).catch((caught: Error) => setError(caught.message))
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

  async function load(term: string, before?: number) {
    const result = await api.documents.list(term, before)
    setActiveQuery(term)
    setItems((current) => before === undefined ? result.items : [...(current ?? []), ...result.items])
    setNext(result.next_before)
  }

  function open(body: typeof draft) {
    setAudience('EVERYONE')
    setSubject('')
    setError('')
    setFiles([])
    setDraft(body)
  }

  function update(patch: Partial<EnterpriseDocumentBody>) {
    setDraft((current) => current && { ...current, ...patch })
  }

  return <section className="grid gap-4">
    <header className="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-lg font-semibold">企业资料库</h1>
        <p className="mt-1 text-sm text-muted-foreground">维护公司制度、流程和知识文档，并设置员工查阅范围。</p>
      </div>
      {canManage && <Button disabled={busy || !items} onClick={() => open(emptyDocument)}>添加资料</Button>}
    </header>
    <form className="flex gap-2" onSubmit={(event) => { event.preventDefault(); void run(() => load(query.trim())) }}>
      <Input className="min-w-0 max-w-sm" aria-label="搜索企业资料" placeholder="搜索标题或正文" value={query}
        maxLength={120} onChange={(event) => setQuery(event.target.value)} />
      <Button type="submit" variant="outline" disabled={busy}>搜索</Button>
      {items?.some((item) => item.parse_status === 'pending') &&
        <Button type="button" variant="ghost" disabled={busy} onClick={() => void run(() => load(activeQuery))}>
          刷新解析状态
        </Button>}
    </form>
    {error && !draft && <p role="alert" className="text-sm text-destructive">{error}</p>}
    <div className="console-panel">
      <Table>
        <TableHeader><TableRow>
          <TableHead>资料标题</TableHead><TableHead>状态</TableHead><TableHead>更新时间</TableHead>
          <TableHead className="text-right">操作</TableHead>
        </TableRow></TableHeader>
        <TableBody>
          {items?.map((item) => <TableRow key={item.id}>
            <TableCell><div className="font-medium">{item.title}</div>
              <div className="text-xs text-muted-foreground">{item.filename ?? (item.format === 'markdown' ? 'Markdown' : '纯文本')} · 版本 {item.revision}
                {item.parse_status && parseStatuses[item.parse_status] ? ` · ${parseStatuses[item.parse_status]}` : ''}</div>
            </TableCell>
            <TableCell><Badge variant={item.enabled ? 'default' : 'secondary'}>{item.enabled ? '启用' : '停用'}</Badge></TableCell>
            <TableCell className="whitespace-nowrap text-muted-foreground">{new Date(item.updated_at).toLocaleString()}</TableCell>
            <TableCell className="text-right">
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => void run(async () => open(await api.documents.read(item.id)))}>
                {canManage ? '查看与编辑' : '查看'}
              </Button>
              {canManage && item.parse_status === 'failed' &&
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => void run(async () => {
                  const queued = await api.documents.retryParse(item.id)
                  setItems((current) => current?.map((row) => row.id === queued.id ? queued : row) ?? [])
                })}>重试解析</Button>}
              {item.filename && <a className="ml-2 text-sm underline" href={`/api/admin/documents/${item.id}/file`}>下载原件</a>}
            </TableCell>
          </TableRow>)}
          {!items?.length && <TableState columns={4} loading={!items && !error}>
            {error ? '无法加载资料' : !items ? '正在加载…' : activeQuery ? '没有匹配的资料' : '暂无企业资料'}
          </TableState>}
        </TableBody>
      </Table>
    </div>
    {next !== null && <Button className="justify-self-start" variant="outline" disabled={busy} onClick={() => void run(() => load(activeQuery, next))}>加载更多</Button>}
    <Dialog open={Boolean(draft)} onOpenChange={(openDialog) => { if (!openDialog && !busy) open(null) }}>
      {draft && <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{draft.id ? (canManage ? '查看与编辑资料' : draft.title) : '添加资料'}</DialogTitle>
          <DialogDescription>上传文件会保留原件。员工只能访问已启用且对其开放的资料。</DialogDescription>
        </DialogHeader>
        {canManage ? <form className="grid gap-4" onSubmit={(event) => {
          event.preventDefault()
          if (busy) return
          const { id, revision, ...body } = draft
          void run(async () => {
            if (id && revision) await api.documents.update(id, revision, body)
            else if (files.length) {
              for (const file of files) {
                await api.documents.upload(file, body.grants)
                setFiles((remaining) => remaining.filter((item) => item !== file))
              }
            } else await api.documents.create(body)
            open(null)
            await load(activeQuery)
          })
        }}>
          {!draft.id && <div className="grid gap-2">
            <Label htmlFor="document-upload">批量上传文件</Label>
            <div className="rounded-md border border-dashed p-3"
              onDragOver={(event) => event.preventDefault()} onDrop={(event) => {
                event.preventDefault()
                if (!busy) setFiles(Array.from(event.dataTransfer.files))
              }}>
              <Input id="document-upload" type="file" multiple disabled={busy}
                onChange={(event) => setFiles(Array.from(event.target.files ?? []))} />
              <p className="mt-2 text-sm text-muted-foreground">可拖入多个文件，单个文件最多 16 MiB。</p>
            </div>
            {files.length > 0 && <p className="text-sm text-muted-foreground">{files.length} 个文件将使用下方开放范围</p>}
          </div>}
          {files.length === 0 && <>
            <label className="grid gap-2 text-sm font-medium">资料标题
              <Input required maxLength={200} value={draft.title} onChange={(event) => update({ title: event.target.value })} />
            </label>
            <div className="grid gap-2 text-sm font-medium">正文格式
              <OptionSelect label="正文格式" emptyLabel="选择格式" value={draft.format}
                options={[{ value: 'markdown', label: 'Markdown' }, { value: 'text', label: '纯文本' }]}
                onChange={(value) => { if (value === 'markdown' || value === 'text') update({ format: value }) }} />
            </div>
            <label className="grid gap-2 text-sm font-medium">正文
              <Textarea rows={9} required={!draft.id} maxLength={48000} value={draft.content} onChange={(event) => update({ content: event.target.value })} />
            </label>
            <label className="flex items-center gap-2 text-sm">
              <Checkbox checked={draft.enabled} onCheckedChange={(value) => update({ enabled: value === true })} />启用资料
            </label>
          </>}
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
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          <Button className="justify-self-end" type="submit" disabled={busy}>保存资料</Button>
        </form> : <pre className="min-w-0 whitespace-pre-wrap rounded-md bg-muted p-3 text-sm [overflow-wrap:anywhere]">{draft.content}</pre>}
      </DialogContent>}
    </Dialog>
  </section>
}

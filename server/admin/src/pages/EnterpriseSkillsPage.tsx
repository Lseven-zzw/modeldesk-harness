import { useEffect, useState } from 'react'
import { FileText, Search } from 'lucide-react'

import { useConfirmation } from '@/components/ConfirmationProvider'
import OptionSelect from '@/components/OptionSelect'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import SkillImportDialog from '@/pages/SkillImportDialog'
import SkillFileList from '@/pages/SkillFileList'
import { api, type EnterpriseSkill, type SkillAudience, type SkillAudienceType, type SkillBundleView, type SkillCategory, type SkillDraft, type SkillImportTarget, type SkillVersion } from '@/lib/api'

const names: Record<SkillAudienceType, string> = { EVERYONE: '全员', USER: '员工', DEPARTMENT: '部门', GROUP: '用户组' }
const filters = [
  { id: 'all', label: '全部技能', matches: () => true },
  { id: 'published', label: '已发布', matches: (skill: EnterpriseSkill) => skill.revision > 0 && skill.enabled },
  { id: 'drafts', label: '有草稿', matches: (skill: EnterpriseSkill) => Boolean(skill.draft) },
  { id: 'offline', label: '已下架', matches: (skill: EnterpriseSkill) => skill.revision > 0 && !skill.enabled },
] as const
const categoryNames: Record<SkillCategory | 'uncategorized', string> = {
  productivity: '效率工具',
  content: '内容创作',
  'data-analysis': '数据分析',
  business: '商业运营',
  collaboration: '办公协同',
  knowledge: '知识与学习',
  development: '开发工具',
  finance: '投资理财',
  lifestyle: '生活服务',
  uncategorized: '未分类',
}
const categoryOptions = Object.entries(categoryNames).map(([value, label]) => ({ value, label }))
const editableCategories = categoryOptions.filter(({ value }) => value !== 'uncategorized')

type DraftForm = Pick<SkillDraft, 'description' | 'remarks' | 'category' | 'instructions' | 'enabled' | 'grants'> & SkillBundleView & {
  code: string; revision: number; draft_revision: string | null; source_revision?: number
}

const newDraft: DraftForm = {
  code: '', revision: 0, draft_revision: null, enabled: true, description: '', remarks: null, category: null,
  instructions: '', grants: [], files: [], source: null,
}

function formFor(skill: EnterpriseSkill, version?: SkillVersion): DraftForm {
  const source = skill.draft ?? skill
  return {
    code: skill.code, revision: skill.revision, draft_revision: skill.draft?.revision ?? null,
    description: version?.description ?? source.description,
    remarks: (version ?? source).remarks,
    category: (version ?? source).category ?? null,
    instructions: version?.instructions ?? source.instructions,
    enabled: source.enabled, grants: source.grants,
    files: (version ?? source).files, source: (version ?? source).source,
    ...(version ? { source_revision: version.revision } : {}),
  }
}

export default function EnterpriseSkillsPage({ permissions }: { permissions: string[] }) {
  const confirm = useConfirmation()
  const canEdit = permissions.includes('skills.edit')
  const canPublish = permissions.includes('skills.publish')
  const canSeeAudience = canEdit || canPublish
  const [items, setItems] = useState<EnterpriseSkill[] | null>(null)
  const [options, setOptions] = useState<Awaited<ReturnType<typeof api.skills.options>>>({ USER: [], DEPARTMENT: [], GROUP: [] })
  const [editor, setEditor] = useState<{ form: DraftForm; lockCode: boolean } | null>(null)
  const [history, setHistory] = useState<{ skill: EnterpriseSkill; versions: SkillVersion[]; next: number | null } | null>(null)
  const [importTarget, setImportTarget] = useState<SkillImportTarget | null>(null)
  const [attachment, setAttachment] = useState<File | null>(null)
  const [attachmentPath, setAttachmentPath] = useState('')
  const [attachmentInput, setAttachmentInput] = useState(0)
  const [kind, setKind] = useState<SkillAudienceType>('EVERYONE')
  const [subject, setSubject] = useState('')
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<(typeof filters)[number]['id']>('all')
  const [categoryFilter, setCategoryFilter] = useState('all')
  const [detail, setDetail] = useState<{ code: string; version: 'published' | 'draft' } | null>(null)
  const [reload, setReload] = useState(0)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let active = true
    Promise.all([api.skills.list(), canSeeAudience ? api.skills.options() : null])
      .then(([{ items }, audience]) => {
        if (!active) return
        setItems(items)
        if (audience) setOptions(audience)
      }).catch((caught: Error) => { if (active) setError(caught.message) })
    return () => { active = false }
  }, [canSeeAudience, reload])

  const draft = editor?.form
  const canManageFiles = Boolean(draft?.draft_revision && draft.source_revision === undefined)
  const activeFilter = filters.find(({ id }) => id === filter) ?? filters[0]
  const visible = items?.filter(activeFilter.matches).map((item) => {
    const showDraft = item.revision === 0 || filter === 'drafts'
    const version = showDraft ? item.draft ?? item : item
    const category: SkillCategory | 'uncategorized' = version.category ?? 'uncategorized'
    return { item, version, showDraft, category }
  }).filter(({ item, category }) => (categoryFilter === 'all' || categoryFilter === category) &&
    [item.code, item.description, item.remarks, item.draft?.description, item.draft?.remarks, categoryNames[category]]
      .join(' ').toLowerCase().includes(query.trim().toLowerCase()))
  const hasFilters = Boolean(query.trim() || filter !== 'all' || categoryFilter !== 'all')
  const detailSkill = detail && items?.find((item) => item.code === detail.code)
  const detailDraft = detailSkill && detail?.version === 'draft' ? detailSkill.draft : null
  const detailVersion = detailDraft ?? detailSkill
  const subjectId = kind === 'EVERYONE' ? 0 : Number(subject)
  const duplicate = draft?.grants.some((grant) => grant.subject_type === kind && grant.subject_id === subjectId)

  function openEditor(form: DraftForm, lockCode = true) {
    setError('')
    setNotice('')
    setKind('EVERYONE')
    setSubject('')
    resetAttachment()
    setEditor({ form, lockCode })
  }

  function resetAttachment() {
    setAttachment(null)
    setAttachmentPath('')
    setAttachmentInput((value) => value + 1)
  }

  function update(patch: Partial<DraftForm>) {
    setEditor((current) => current && { ...current, form: { ...current.form, ...patch } })
  }

  function audienceLabel(grant: SkillAudience) {
    return grant.subject_type === 'EVERYONE' ? names.EVERYONE
      : `${names[grant.subject_type]} · ${options[grant.subject_type].find((item) => item.id === grant.subject_id)?.name ?? grant.subject_id}`
  }

  function replace(code: string, item: EnterpriseSkill | null) {
    setItems((current) => [...(current ?? []).filter((entry) => entry.code !== code), ...(item ? [item] : [])]
      .sort((left, right) => left.code.localeCompare(right.code)))
  }

  async function run(action: () => Promise<void>, message?: string) {
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await action()
      if (message) setNotice(message)
    } catch (caught) {
      setError((caught as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function publish(skill: EnterpriseSkill) {
    if (!skill.draft || !await confirm(`发布「${skill.code}」？`,
      skill.draft.enabled ? '有同步权限的员工将在下一次同步时收到这个版本。' : '本版本将保留在历史中，员工端会移除该技能。', '发布版本', false)) return
    const draftRevision = skill.draft.revision
    await run(async () => replace(skill.code, await api.skills.publishDraft(skill.code, skill.revision, draftRevision)), '版本已发布。')
  }

  async function unpublish(skill: EnterpriseSkill) {
    if (!await confirm(`下架「${skill.code}」？`, '员工端将在下一次同步时移除此技能，已发布版本和现有草稿会保留。', '下架')) return
    await run(async () => replace(skill.code, await api.skills.unpublish(skill.code, skill.revision)), '技能已下架。')
  }

  async function discard(skill: EnterpriseSkill) {
    if (!skill.draft || !await confirm(`丢弃「${skill.code}」的草稿？`, '这会删除尚未发布的修改。', '丢弃草稿')) return
    const draftRevision = skill.draft.revision
    await run(async () => replace(skill.code, (await api.skills.discardDraft(skill.code, skill.revision, draftRevision)).item), '草稿已丢弃。')
  }

  async function uploadFile() {
    if (!draft?.draft_revision || !attachment || !attachmentPath.trim()) return
    const path = attachmentPath.trim()
    const file = attachment
    const revision = draft.draft_revision
    if (draft.files.some((name) => name.toLowerCase() === path.toLowerCase()) &&
      !await confirm(`替换「${path}」？`, '此操作只替换草稿里的附件。', '替换')) return
    await run(async () => {
      const saved = await api.skills.uploadAttachment(draft.code, path, file, draft.revision, revision)
      if (!saved.draft) throw new Error('附件已上传，但草稿未返回。请刷新。')
      replace(draft.code, saved)
      update({ draft_revision: saved.draft.revision, files: saved.draft.files, source: saved.draft.source })
      resetAttachment()
    }, '附件已保存到草稿。')
  }

  async function removeFile(path: string) {
    if (!draft?.draft_revision ||
      !await confirm(`删除「${path}」？`, '已发布版本的附件仍可使用。', '删除附件')) return
    const revision = draft.draft_revision
    await run(async () => {
      const saved = await api.skills.removeAttachment(draft.code, path, draft.revision, revision)
      if (!saved.draft) throw new Error('草稿未返回。请刷新。')
      replace(draft.code, saved)
      update({ draft_revision: saved.draft.revision, files: saved.draft.files, source: saved.draft.source })
    }, '已从草稿删除附件。')
  }

  function loadHistory(skill: EnterpriseSkill, before?: number) {
    void run(async () => {
      const result = await api.skills.versions(skill.code, before)
      setHistory((current) => ({
        skill, versions: before === undefined ? result.items : [...(current?.versions ?? []), ...result.items],
        next: result.next_before,
      }))
    })
  }

  return <section className="flex flex-col gap-5">
    <header className="flex flex-wrap items-end justify-between gap-3"><div>
      <h1 className="text-lg font-semibold">企业技能库</h1>
      <p className="mt-1 text-sm text-muted-foreground">浏览企业技能，管理发布版本和员工同步范围。</p>
    </div>{canEdit && <div className="flex flex-wrap gap-2">
      <Button variant="outline" disabled={!items || busy} onClick={() => setImportTarget({})}>导入技能</Button>
      <Button disabled={!items || busy} onClick={() => openEditor(newDraft, false)}>新建技能</Button>
    </div>}</header>
    <div className="console-panel flex flex-wrap items-center justify-between gap-3 p-3">
      <div role="group" aria-label="筛选技能状态" className="flex flex-wrap gap-1">
        {filters.map(({ id, label, matches }) => <Button key={id} size="sm"
          variant={filter === id ? 'secondary' : 'ghost'} aria-pressed={filter === id}
          onClick={() => setFilter(id)}>
          {label}{items && <span className="ml-1 tabular-nums text-muted-foreground">{items.filter(matches).length}</span>}
        </Button>)}
      </div>
      <div className="flex w-full min-w-0 gap-2 sm:w-auto">
        <div className="relative min-w-0 flex-1">
          <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input className="pl-9 sm:w-56" aria-label="搜索企业技能" placeholder="搜索标识、描述或备注"
            value={query} onChange={(event) => setQuery(event.target.value)} />
        </div>
        <Button variant="outline" disabled={busy} onClick={() => { setError(''); setItems(null); setReload((value) => value + 1) }}>刷新列表</Button>
      </div>
    </div>
    <div role="group" aria-label="按技能分类筛选" className="flex flex-wrap gap-1">
      {[{ value: 'all', label: '全部分类' }, ...categoryOptions].map(({ value, label }) =>
        <Button key={value} size="sm" variant={categoryFilter === value ? 'secondary' : 'ghost'}
          aria-pressed={categoryFilter === value} onClick={() => setCategoryFilter(value)}>{label}</Button>)}
    </div>
    {error && !editor && !history && !detailSkill && <p role="alert" className="text-destructive">{error}</p>}
    {notice && !editor && !detailSkill && <p role="status" className="text-success">{notice}</p>}
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
      {visible?.map(({ item, version, showDraft, category }) => (
        <Card key={item.code} className="flex min-w-0 flex-col shadow-sm">
          <CardHeader className="gap-3 space-y-0 p-4 sm:p-5">
            <div className="flex flex-wrap items-center gap-2">
              <div className="grid size-9 shrink-0 place-items-center rounded-lg bg-muted text-primary">
                <FileText aria-hidden="true" className="size-4" />
              </div>
              <h2 className="min-w-0 flex-1 text-sm font-semibold [overflow-wrap:anywhere]">{item.code}</h2>
              <Badge variant={item.revision > 0 && item.enabled ? 'default' : 'secondary'}>
                {item.revision === 0 ? '未发布' : item.enabled ? '已发布' : '已下架'}
              </Badge>
              {item.draft && <Badge variant="outline">{item.revision > 0 ? '有草稿' : '草稿'}</Badge>}
            </div>
            <CardDescription className="line-clamp-3 break-words leading-relaxed">{version.description}</CardDescription>
          </CardHeader>
          <CardContent className="mt-auto px-4 pb-3 pt-0 sm:px-5">
            <p className="text-xs text-muted-foreground">
              {showDraft ? '草稿同步范围' : '已发布同步范围'} · {version.grants.some((grant) => grant.subject_type === 'EVERYONE')
                ? '全员' : version.grants.length ? `${version.grants.length} 个授权对象` : '暂无授权'}
            </p>
          </CardContent>
          <CardFooter className="justify-between gap-2 border-t px-4 py-3 sm:px-5">
            <span className="text-xs text-muted-foreground">{categoryNames[category]} · {showDraft ? '草稿' : `版本 ${item.revision}`}</span>
            <Button size="sm" variant="ghost" aria-label={`查看详情：${item.code}`} disabled={busy} onClick={() => {
              setNotice(''); setError(''); setDetail({ code: item.code, version: showDraft ? 'draft' : 'published' })
            }}>查看详情</Button>
          </CardFooter>
        </Card>
      ))}
    </div>
    {!visible?.length && <div className="console-panel grid justify-items-center gap-2 px-5 py-14 text-center" role="status">
      <FileText aria-hidden="true" className="size-6 text-muted-foreground" />
      <p className="text-sm font-medium">
        {items ? (hasFilters ? '没有匹配的技能' : '暂无企业技能') : error ? '无法加载技能' : '正在加载技能…'}
      </p>
      {items && hasFilters && <Button variant="ghost" size="sm" onClick={() => { setQuery(''); setFilter('all'); setCategoryFilter('all') }}>清除筛选</Button>}
    </div>}
    <Dialog open={Boolean(detailSkill)} onOpenChange={(open) => { if (!open && !busy) { setDetail(null); setError('') } }}>
      {detail && detailSkill && detailVersion && <DialogContent className="min-w-0 sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="break-all">{detailSkill.code}</DialogTitle>
          <DialogDescription>技能内容、同步范围与版本管理</DialogDescription>
        </DialogHeader>
        <div role="group" aria-label="选择技能版本" className="flex flex-wrap gap-2">
          {detailSkill.revision > 0 && <Button size="sm" variant={detailDraft ? 'outline' : 'secondary'}
            aria-pressed={!detailDraft} onClick={() => setDetail({ ...detail, version: 'published' })}>已发布版本 {detailSkill.revision}</Button>}
          {detailSkill.draft && <Button size="sm" variant={detailDraft ? 'secondary' : 'outline'}
            aria-pressed={Boolean(detailDraft)} onClick={() => setDetail({ ...detail, version: 'draft' })}>草稿</Button>}
        </div>
        <div className="grid min-w-0 gap-4 rounded-lg border p-4 [overflow-wrap:anywhere]">
          <Badge variant="secondary" className="justify-self-start">{categoryNames[detailVersion.category ?? 'uncategorized']}</Badge>
          <p className="whitespace-pre-wrap break-words text-sm">{detailVersion.description}</p>
          {detailVersion.remarks && <div className="grid gap-1 text-sm">
            <h3 className="font-medium">管理备注</h3>
            <p className="whitespace-pre-wrap break-words text-muted-foreground">{detailVersion.remarks}</p>
          </div>}
          <div className="grid gap-2 text-sm">
            <h3 className="font-medium">同步范围</h3>
            <p className="text-muted-foreground">
              {detailDraft ? (detailDraft.enabled ? '发布后启用同步' : '发布后关闭同步') : detailSkill.enabled ? '同步已启用' : '同步已关闭'}
            </p>
            <div className="flex flex-wrap gap-2">{detailVersion.grants.length > 0
              ? detailVersion.grants.map((grant) => <Badge key={`${grant.subject_type}:${grant.subject_id}`} variant="secondary">{audienceLabel(grant)}</Badge>)
              : <span className="text-muted-foreground">暂无授权</span>}
            </div>
          </div>
        </div>
        <details className="min-w-0 rounded-md border p-3">
          <summary className="cursor-pointer text-sm font-medium">技能指令</summary>
          <pre className="mt-2 whitespace-pre-wrap break-words rounded-md bg-muted p-3 text-sm">{detailVersion.instructions}</pre>
        </details>
        <SkillFileList code={detailSkill.code} files={detailVersion.files} source={detailVersion.source}
          revision={detailDraft ? undefined : detailSkill.revision} />
        {error && <p role="alert" className="text-destructive">{error}</p>}
        {notice && <p role="status" className="text-success">{notice}</p>}
        <div className="flex flex-wrap items-center gap-2 border-t pt-4">
          {canEdit && <Button disabled={busy} onClick={() => { setDetail(null); openEditor(formFor(detailSkill)) }}>
            {detailSkill.draft ? '编辑草稿' : '创建草稿'}
          </Button>}
          {canPublish && detailDraft && <Button variant="outline" disabled={busy} onClick={() => void publish(detailSkill)}>发布草稿</Button>}
          {detailSkill.revision > 0 && <Button variant="outline" disabled={busy} onClick={() => { setDetail(null); loadHistory(detailSkill) }}>版本历史</Button>}
          {canEdit && <Button variant="ghost" disabled={busy} onClick={() => {
            setDetail(null)
            setImportTarget({
              code: detailSkill.code, revision: detailSkill.revision,
              ...(detailSkill.draft ? { draft_revision: detailSkill.draft.revision } : {}),
            })
          }}>导入新版本</Button>}
          {canPublish && !detailDraft && detailSkill.enabled && <Button variant="ghost" disabled={busy} onClick={() => void unpublish(detailSkill)}>下架</Button>}
          {canEdit && detailDraft && <Button variant="ghost" disabled={busy} onClick={() => void discard(detailSkill)}>丢弃草稿</Button>}
        </div>
      </DialogContent>}
    </Dialog>
    <Dialog open={editor !== null} onOpenChange={(open) => { if (!open && !busy) { setEditor(null); setError('') } }}>
      {draft && <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader><DialogTitle>{editor.lockCode ? '编辑技能草稿' : '新建技能草稿'}</DialogTitle>
          <DialogDescription>保存草稿后，有发布权限的人可以将它发布到企业。</DialogDescription></DialogHeader>
        <form className="flex flex-col gap-4" onSubmit={(event) => {
          event.preventDefault()
          if (busy) return
          const { code, files: _files, source: _source, ...body } = draft
          void run(async () => {
            const saved = await api.skills.saveDraft(code, body)
            replace(code, saved)
            setEditor({ form: formFor(saved), lockCode: true })
          }, '草稿已保存。')
        }}>
          <label>技能标识<Input value={draft.code} required maxLength={64} readOnly={editor.lockCode}
            pattern="[a-z][a-z0-9]*(?:-[a-z0-9]+)*" onChange={(event) => update({ code: event.target.value })} /></label>
          <label>描述<Input value={draft.description} required maxLength={1024}
            onChange={(event) => update({ description: event.target.value })} /></label>
          <div className="grid gap-1">
            <span className="text-sm font-medium">技能分类</span>
            <OptionSelect label="技能分类" value={draft.category ?? ''}
              options={editableCategories} emptyLabel="未分类" disabled={busy}
              onChange={(value) => update({ category: value ? value as SkillCategory : null })} />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="skill-remarks">管理备注</label>
            <Textarea id="skill-remarks" aria-describedby="skill-remarks-help" rows={3} maxLength={1000}
              value={draft.remarks ?? ''} placeholder="可填写维护人、适用场景或维护说明"
              onChange={(event) => update({ remarks: event.target.value })} />
            <p id="skill-remarks-help" className="text-sm text-muted-foreground">备注仅在管理台显示。</p>
          </div>
          <label>技能指令<Textarea required rows={10} maxLength={48000} value={draft.instructions}
            placeholder="填写 Markdown 正文，系统会生成 SKILL.md 的头部"
            onChange={(event) => update({ instructions: event.target.value })} /></label>
          <SkillFileList code={draft.code} files={draft.files} source={draft.source}
            revision={draft.source_revision ?? (draft.draft_revision ? undefined : draft.revision || undefined)}
            onRemove={canManageFiles ? (path) => void removeFile(path) : undefined} busy={busy} />
          {canManageFiles ? <fieldset className="flex flex-col gap-3 rounded-md border p-3" disabled={busy}>
            <legend className="px-1 font-semibold">添加或替换附件</legend>
            <label>选择附件<Input key={attachmentInput} type="file" onChange={(event) => {
              const file = event.target.files?.[0] ?? null
              setAttachment(file)
              setAttachmentPath(file?.name ?? '')
            }} /></label>
            <label>相对路径<Input value={attachmentPath} maxLength={220} placeholder="例如 references/guide.md"
              onChange={(event) => setAttachmentPath(event.target.value)} /></label>
            <Button type="button" variant="outline" disabled={busy || !attachment || !attachmentPath.trim()}
              onClick={() => void uploadFile()}>保存附件</Button>
          </fieldset> : <p className="text-sm text-muted-foreground">保存草稿后即可管理附件。</p>}
          <label className="flex items-center gap-2"><Checkbox checked={draft.enabled} disabled={busy}
            onCheckedChange={(checked) => update({ enabled: checked === true })} />发布后启用同步</label>
          <fieldset className="flex flex-col gap-2 rounded-md border p-3" disabled={busy}>
            <legend className="px-1 font-semibold">同步范围</legend>
            {!draft.grants.length && <p className="text-muted-foreground">没有授权对象。</p>}
            {draft.grants.map((grant) => <div key={`${grant.subject_type}:${grant.subject_id}`} className="flex items-center justify-between gap-2">
              <span>{audienceLabel(grant)}</span>
              <Button type="button" variant="ghost" size="sm"
                onClick={() => update({ grants: draft.grants.filter((item) => item !== grant) })}>移除</Button>
            </div>)}
            <div className="grid gap-2 sm:grid-cols-[8rem_1fr_auto]">
              <OptionSelect label="同步对象类型" value={kind} disabled={busy} emptyLabel="选择类型"
                options={Object.entries(names).map(([value, label]) => ({ value, label }))}
                onChange={(value) => { if (value) { setKind(value as SkillAudienceType); setSubject('') } }} />
              {kind !== 'EVERYONE' && <OptionSelect label="同步对象" value={subject} disabled={busy}
                onChange={setSubject} emptyLabel={`选择${names[kind]}`}
                options={options[kind].map((entry) => ({ value: String(entry.id), label: entry.name }))} />}
              <Button type="button" variant="secondary" disabled={busy || duplicate || (kind !== 'EVERYONE' && !subject)}
                onClick={() => {
                  update({ grants: [...draft.grants, { subject_type: kind, subject_id: subjectId }] })
                  setSubject('')
                }}>添加范围</Button>
            </div>
          </fieldset>
          {error && <p role="alert" className="text-destructive">{error}</p>}
          {notice && <p role="status" className="text-success">{notice}</p>}
          <Button type="submit" disabled={busy}>保存草稿</Button>
        </form>
      </DialogContent>}
    </Dialog>
    <Dialog open={history !== null} onOpenChange={(open) => { if (!open && !busy) { setHistory(null); setError('') } }}>
      {history && <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader><DialogTitle>版本历史 · {history.skill.code}</DialogTitle>
          <DialogDescription>旧版本内容可以恢复为草稿，重新发布后才会同步。</DialogDescription></DialogHeader>
        {history.versions.map((version) => <details key={version.revision} className="rounded-md border p-3">
          <summary className="cursor-pointer font-medium">版本 {version.revision} · {version.description}</summary>
          <p className="my-2 text-xs text-muted-foreground">{categoryNames[version.category ?? 'uncategorized']} · {new Date(version.published_at).toLocaleString()}
            {version.published_by === null ? '' : ` · 操作人 #${version.published_by}`}</p>
          <pre className="mb-3 whitespace-pre-wrap break-words rounded-md bg-muted p-3">{version.instructions}</pre>
          {version.remarks && <div className="mb-3 whitespace-pre-wrap break-words text-sm">
            <span className="font-medium">管理备注</span><p>{version.remarks}</p>
          </div>}
          <SkillFileList code={history.skill.code} files={version.files} source={version.source} revision={version.revision} />
          {canEdit && <Button type="button" size="sm" variant="outline" onClick={() => {
            const skill = history.skill
            setHistory(null)
            openEditor(formFor(skill, version))
          }}>用此版本编辑草稿</Button>}
        </details>)}
        {history.next !== null && <Button disabled={busy} variant="outline" onClick={() => {
          if (history.next !== null) loadHistory(history.skill, history.next)
        }}>加载更早版本</Button>}
        {error && <p role="alert" className="text-destructive">{error}</p>}
      </DialogContent>}
    </Dialog>
    {importTarget && <SkillImportDialog target={importTarget} onClose={() => setImportTarget(null)} onImported={(skill) => {
      replace(skill.code, skill)
      setImportTarget(null)
      openEditor(formFor(skill))
      setNotice('导入已保存为草稿。')
    }} />}
  </section>
}

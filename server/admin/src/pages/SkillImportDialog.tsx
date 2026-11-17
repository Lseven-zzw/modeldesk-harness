import { useState } from 'react'

import OptionSelect from '@/components/OptionSelect'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { api, type EnterpriseSkill, type SkillImportTarget } from '@/lib/api'

type ImportMethod = 'markdown' | 'zip' | 'git'

export default function SkillImportDialog({ target, onClose, onImported }: {
  target: SkillImportTarget
  onClose: () => void
  onImported: (skill: EnterpriseSkill) => void
}) {
  const [method, setMethod] = useState<ImportMethod>('markdown')
  const [file, setFile] = useState<File | null>(null)
  const [repository, setRepository] = useState('')
  const [ref, setRef] = useState('')
  const [skillPath, setSkillPath] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function submit() {
    setBusy(true)
    setError('')
    try {
      const imported = method === 'git'
        ? await api.skills.importGit(repository.trim(), ref.trim(), skillPath.trim(), target)
        : file && await api.skills.importFile(file, method, target, skillPath.trim())
      if (imported) onImported(imported)
    } catch (caught) {
      setError((caught as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (<Dialog open onOpenChange={(open) => { if (!open && !busy) onClose() }}>
    <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-xl">
      <DialogHeader>
        <DialogTitle>{target.code ? `导入新版本 · ${target.code}` : '导入企业技能'}</DialogTitle>
        <DialogDescription>{target.code
          ? '文件中的技能标识必须一致。导入会替换当前草稿内容，保留现有同步范围。'
          : '导入内容会保存为草稿，由有发布权限的人确认后发布。'}</DialogDescription>
      </DialogHeader>
      <form className="flex flex-col gap-4" onSubmit={(event) => { event.preventDefault(); if (!busy) void submit() }}>
        <OptionSelect label="导入方式" value={method} emptyLabel="选择导入方式" disabled={busy}
          options={[
            { value: 'markdown', label: '上传 SKILL.md' }, { value: 'zip', label: '上传 ZIP 技能包' },
            { value: 'git', label: '公开 GitHub 仓库' },
          ]}
          onChange={(value) => { if (value) { setMethod(value as ImportMethod); setFile(null); setSkillPath('') } }} />
        {method === 'git' ? <>
          <label>GitHub 仓库<Input placeholder="owner/repository" value={repository} required maxLength={250}
            disabled={busy} onChange={(event) => setRepository(event.target.value)} /></label>
          <label>分支、标签或提交<Input placeholder="默认分支（HEAD）" value={ref} maxLength={200}
            disabled={busy} onChange={(event) => setRef(event.target.value)} /></label>
        </> : <label>{method === 'zip' ? 'ZIP 文件' : 'SKILL.md 文件'}
          <Input key={method} type="file" accept={method === 'zip' ? '.zip,application/zip' : '.md,text/markdown'}
            required disabled={busy} onChange={(event) => setFile(event.target.files?.[0] ?? null)} />
        </label>}
        {method !== 'markdown' && <label>技能目录（可选）
          <Input value={skillPath} placeholder="例如 skills/review，根目录填 ." maxLength={220}
            disabled={busy} onChange={(event) => setSkillPath(event.target.value)} />
        </label>}
        {method !== 'markdown' && <p className="text-sm text-muted-foreground">
          ZIP 下载或上传上限 20 MiB；所选技能最多 100 个附件，合计不超过 2 MiB。
        </p>}
        {error && <p role="alert" className="text-destructive">{error}</p>}
        <Button type="submit" disabled={busy || (method === 'git' ? !repository.trim() : !file)}>
          {busy ? '正在导入…' : '导入为草稿'}
        </Button>
      </form>
    </DialogContent>
  </Dialog>
  )
}

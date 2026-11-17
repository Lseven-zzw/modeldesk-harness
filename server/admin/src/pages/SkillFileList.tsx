import { Button } from '@/components/ui/button'
import { api, type SkillBundleView } from '@/lib/api'

export default function SkillFileList({ code, files, source, revision, onRemove, busy }: SkillBundleView & {
  code: string
  revision?: number
  onRemove?: (path: string) => void
  busy?: boolean
}) {
  return <details className="rounded-md border p-3">
    <summary className="cursor-pointer font-medium">文件与来源 · {files.length} 个附件</summary>
    <div className="mt-3 flex flex-col gap-2">
      <p className="text-sm text-muted-foreground">{
        !source ? '手动创建'
          : source.kind === 'git' ? `GitHub 导入：${source.repository} · ${source.ref}`
            : source.kind === 'zip' ? 'ZIP 导入' : 'SKILL.md 导入'
      }</p>
      {files.length > 0 ? <ul className="divide-y rounded-md border">
        {files.map((path) => <li key={path} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
          <span className="min-w-0 break-all text-sm">{path.startsWith('references/') &&
            <span className="mr-2 text-xs text-muted-foreground">参考文档</span>}{path}</span>
          <div className="flex gap-1">
            <Button asChild variant="ghost" size="sm">
              <a href={api.skills.attachmentUrl(code, path, revision)} download aria-label={`下载 ${path}`}>下载</a>
            </Button>
            {onRemove && <Button type="button" variant="ghost" size="sm" disabled={busy}
              aria-label={`删除 ${path}`} onClick={() => onRemove(path)}>删除</Button>}
          </div>
        </li>)}
      </ul> : <p className="text-sm text-muted-foreground">暂无附件。</p>}
    </div>
  </details>
}

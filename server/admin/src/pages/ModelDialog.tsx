import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { api, type ModelView } from '@/lib/api'

const CAPS = [
  { key: 'streaming', label: '流式输出（必需）' },
  { key: 'tools', label: '工具调用' },
  { key: 'reasoning_content', label: '思考过程' },
] as const

function parseCapabilities(value: string): { caps: string[]; contextWindow: string } {
  const parts = value.split(',').map((part) => part.trim()).filter(Boolean)
  return {
    caps: parts.filter((part) => !part.startsWith('ctx:')),
    contextWindow: parts.find((part) => part.startsWith('ctx:'))?.slice(4) ?? '',
  }
}

export default function ModelDialog({ model, kinds, onClose, onSaved }: {
  model: ModelView
  kinds: string[]
  onClose: () => void
  onSaved: () => Promise<void>
}) {
  const parsed = parseCapabilities(model.capabilities)
  const [displayName, setDisplayName] = useState(model.display_name)
  const [providerName, setProviderName] = useState(model.provider_name ?? '')
  const [kind, setKind] = useState(model.upstream_kind)
  const [upstreamModel, setUpstreamModel] = useState(model.upstream_model)
  const [upstreamBase, setUpstreamBase] = useState(model.upstream_base)
  const [apiKey, setApiKey] = useState('')
  const [caps, setCaps] = useState<string[]>(parsed.caps)
  const [contextWindow, setContextWindow] = useState(parsed.contextWindow)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  function toggleCap(key: string, checked: boolean): void {
    setCaps((current) => (checked ? [...current, key] : current.filter((item) => item !== key)))
  }

  async function submit(): Promise<void> {
    const context = contextWindow.trim()
    if (context !== '' && (!/^[1-9][0-9]*$/.test(context) || !Number.isSafeInteger(Number(context)))) {
      setError('上下文窗口必须是正整数')
      return
    }
    const capabilities = [...caps, ...(context ? [`ctx:${context}`] : [])].join(',')
    setSaving(true)
    try {
      await api.models.patch(model.id, {
        display_name: displayName.trim(),
        upstream_model: upstreamModel.trim(),
        capabilities,
        ...(model.channel_id == null ? {
          provider_name: providerName.trim() || null,
          upstream_kind: kind,
          upstream_base: upstreamBase.trim(),
          ...(apiKey.trim() ? { api_key: apiKey.trim() } : {}),
        } : {}),
      })
      await onSaved()
      onClose()
    } catch (caught) {
      setError((caught as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="max-h-[80vh] overflow-y-auto">
        <DialogHeader><DialogTitle>{`编辑模型 · ${model.display_name}`}</DialogTitle></DialogHeader>
        <form className="grid gap-3" onSubmit={(event) => { event.preventDefault(); void submit() }}>
          {error !== null && <p className="text-sm text-destructive">{error}</p>}

          <div><Label htmlFor="model-code">模型编码</Label>
            <Input id="model-code" placeholder="deepseek-chat" disabled value={model.code} /></div>

          <div><Label htmlFor="model-name">显示名称</Label>
            <Input id="model-name" placeholder="DeepSeek Chat" value={displayName}
                   onChange={(event) => setDisplayName(event.target.value)} /></div>

          {model.channel_id != null && <p className="text-sm text-muted-foreground">渠道：{model.provider_name}</p>}
          {model.channel_id == null && <>
          <div><Label htmlFor="model-provider">厂商名称（可选）</Label>
            <Input id="model-provider" placeholder="deepseek" value={providerName}
                   onChange={(event) => setProviderName(event.target.value)} /></div>

          <div><Label>上游类型</Label>
            <Select value={kind} onValueChange={setKind}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {kinds.map((item) => <SelectItem key={item} value={item}>{item}</SelectItem>)}
              </SelectContent>
            </Select></div>

          <div><Label htmlFor="model-base">上游地址（不含 /chat/completions）</Label>
            <Input id="model-base" placeholder="https://api.deepseek.com/v1" value={upstreamBase}
                   onChange={(event) => setUpstreamBase(event.target.value)} /></div>

          <div><Label htmlFor="model-key">上游密钥（留空表示不修改）</Label>
            <Input id="model-key" type="password" autoComplete="off" value={apiKey}
                   onChange={(event) => setApiKey(event.target.value)} />
            <p className="mt-1 text-xs text-muted-foreground">保存后只显示末 4 位，服务端从不解密回显。</p></div>
          </>}

          <div><Label htmlFor="model-upstream-model">上游模型名</Label>
            <Input id="model-upstream-model" placeholder="deepseek-chat" value={upstreamModel}
                   onChange={(event) => setUpstreamModel(event.target.value)} /></div>

          <div className="space-y-2">
            <Label>能力</Label>
            {CAPS.map(({ key, label }) => (
              <label key={key} className="flex items-center gap-2 text-sm">
                <Checkbox checked={caps.includes(key)}
                          onCheckedChange={(checked) => toggleCap(key, checked === true)} />
                {label}
              </label>
            ))}
            <div className="flex items-center gap-2">
              <Input aria-label="上下文窗口" placeholder="上下文窗口，如 65536" value={contextWindow}
                     onChange={(event) => setContextWindow(event.target.value)} className="max-w-48" />
              <span className="text-xs text-muted-foreground">留空使用默认值 32,768</span>
            </div>
          </div>

          <Button className="w-full" disabled={saving} type="submit">
            保存修改
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  )
}

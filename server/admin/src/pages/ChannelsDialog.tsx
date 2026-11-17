import { useEffect, useState, type FormEvent } from 'react'

import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { api, type ModelChannel } from '@/lib/api'

const PRESET_GROUPS = [
  {
    label: '国内厂商与云平台',
    presets: [
      { name: 'DeepSeek', base: 'https://api.deepseek.com/v1' },
      { name: 'Kimi（月之暗面）', base: 'https://api.moonshot.cn/v1' },
      { name: '智谱 GLM', base: 'https://open.bigmodel.cn/api/paas/v4' },
      { name: 'MiniMax（中国站）', base: 'https://api.minimax.cn/v1' },
      { name: '阿里云百炼', base: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
      { name: '火山方舟（豆包）', base: 'https://ark.cn-beijing.volces.com/api/v3' },
    ],
  },
  {
    label: '国际厂商与云平台',
    presets: [
      { name: 'OpenAI', base: 'https://api.openai.com/v1' },
      { name: 'Google Gemini（OpenAI 兼容）', base: 'https://generativelanguage.googleapis.com/v1beta/openai' },
      { name: 'xAI（Grok）', base: 'https://api.x.ai/v1' },
      { name: 'Kimi（国际站）', base: 'https://api.moonshot.ai/v1' },
      { name: 'Z.ai（GLM 国际站）', base: 'https://api.z.ai/api/paas/v4' },
    ],
  },
  {
    label: '模型聚合与推理平台',
    presets: [
      { name: '硅基流动', base: 'https://api.siliconflow.cn/v1' },
      { name: 'OpenRouter', base: 'https://openrouter.ai/api/v1' },
      { name: 'Groq', base: 'https://api.groq.com/openai/v1' },
      { name: 'Fireworks AI', base: 'https://api.fireworks.ai/inference/v1' },
    ],
  },
]
const PRESET_NAMES = new Map(PRESET_GROUPS.flatMap(({ presets }) => presets.map(({ base, name }) => [base, name])))

type Props = {
  canCreate: boolean
  canEdit: boolean
  onClose: () => void
  onChanged: () => Promise<void>
}

export default function ChannelsDialog({ canCreate, canEdit, onClose, onChanged }: Props) {
  const [channels, setChannels] = useState<ModelChannel[]>([])
  const [channelId, setChannelId] = useState('')
  const [mode, setMode] = useState<'select' | 'create' | 'edit'>('select')
  const [name, setName] = useState('')
  const [base, setBase] = useState('')
  const [key, setKey] = useState('')
  const [models, setModels] = useState<string[]>([])
  const [selected, setSelected] = useState<string[]>([])
  const [search, setSearch] = useState('')
  const [manual, setManual] = useState('')
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(true)
  const channel = channels.find((item) => String(item.id) === channelId)
  const matching = models.filter((model) => model.toLowerCase().includes(search.trim().toLowerCase()))

  useEffect(() => {
    let active = true
    void api.channels.list().then(({ items }) => {
      if (!active) return
      setChannels(items)
      setChannelId(items.length > 0 ? String(items[0].id) : '')
      if (items.length === 0 && canCreate) setMode('create')
    }).catch((caught: Error) => {
      if (active) setError(caught.message)
    }).finally(() => {
      if (active) setBusy(false)
    })
    return () => { active = false }
  }, [canCreate])

  function resetCatalog() {
    setModels([])
    setSelected([])
    setSearch('')
    setManual('')
    setMessage('')
    setError('')
  }

  function openForm(target?: ModelChannel) {
    setMode(target ? 'edit' : 'create')
    setName(target?.name ?? '')
    setBase(target?.upstream_base ?? '')
    setKey('')
    setError('')
    setMessage('')
  }

  async function perform(action: () => Promise<void>) {
    setError('')
    setMessage('')
    setBusy(true)
    try {
      await action()
    } catch (caught) {
      setError((caught as Error).message)
    } finally {
      setBusy(false)
    }
  }

  function save(event: FormEvent) {
    event.preventDefault()
    void perform(async () => {
      const body = { name: name.trim(), upstream_base: base.trim() }
      const saved = mode === 'edit' && channel
        ? await api.channels.patch(channel.id, { ...body, ...(key.trim() ? { api_key: key.trim() } : {}) })
        : await api.channels.create({ ...body, api_key: key.trim() })
      setChannels((current) => [...current.filter((item) => item.id !== saved.id), saved].sort((a, b) => a.id - b.id))
      setChannelId(String(saved.id))
      setKey('')
      setMode('select')
      resetCatalog()
      setMessage('渠道已保存')
      await onChanged()
    })
  }

  function discover(target: ModelChannel) {
    void perform(async () => {
      setModels([])
      setSelected([])
      setSearch('')
      const result = await api.channels.discover(target.id)
      setModels(result.items)
      setMessage(result.supported
        ? `模型列表连接成功，找到 ${result.items.length} 个模型`
        : '该渠道没有返回模型列表，可手动填写模型 ID')
    })
  }

  function importModels(event: FormEvent, target: ModelChannel) {
    event.preventDefault()
    void perform(async () => {
      const ids = [...new Set([...selected, ...manual.split(/[\r\n]+/).map((item) => item.trim()).filter(Boolean)])]
      if (!ids.length || ids.length > 100 || ids.some((id) => id.length > 200)) {
        throw new Error('每次可接入 1 至 100 个模型，模型 ID 最长 200 字符')
      }
      const result = await api.channels.importModels(target.id, ids)
      setManual('')
      setSelected([])
      setMessage(`已接入 ${result.items.length} 个模型${result.skipped.length ? `，跳过 ${result.skipped.length} 个已接入模型` : ''}。可在模型列表配置开放范围。`)
      await onChanged()
    })
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose() }}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{mode === 'create' ? '添加渠道' : mode === 'edit' ? '编辑渠道' : '渠道与模型接入'}</DialogTitle>
          <DialogDescription>同一渠道下的模型共用接口地址和 API Key。</DialogDescription>
        </DialogHeader>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        {message && <p role="status" className="text-sm text-muted-foreground">{message}</p>}
        {mode !== 'select' ? (
          <form className="grid gap-4" onSubmit={save}>
            {mode === 'create' && <div className="grid gap-2">
              <Label htmlFor="channel-preset">渠道预设</Label>
              <Select defaultValue="custom" onValueChange={(value) => {
                setName(PRESET_NAMES.get(value) ?? '')
                setBase(value === 'custom' ? '' : value)
                setKey('')
              }} disabled={busy}>
                <SelectTrigger id="channel-preset"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="custom">自定义 OpenAI 兼容渠道</SelectItem>
                  {PRESET_GROUPS.map(({ label, presets }) => (
                    <SelectGroup key={label}>
                      <SelectLabel>{label}</SelectLabel>
                      {presets.map(({ name, base }) => <SelectItem key={base} value={base}>{name}</SelectItem>)}
                    </SelectGroup>
                  ))}
                </SelectContent>
              </Select>
            </div>}
            <div className="grid gap-2">
              <Label htmlFor="channel-name">渠道名称</Label>
              <Input id="channel-name" value={name} onChange={(event) => setName(event.target.value)} maxLength={100} required />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="channel-base">API 基础地址</Label>
              <Input id="channel-base" type="url" value={base} onChange={(event) => setBase(event.target.value)} placeholder="https://example.com/v1" required />
              <p className="text-xs text-muted-foreground">填写基础地址，例如以 /v1 结尾的地址。模型列表和聊天路径由系统拼接。</p>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="channel-key">API Key</Label>
              <Input id="channel-key" type="password" autoComplete="new-password" value={key} onChange={(event) => setKey(event.target.value)}
                placeholder={mode === 'edit' ? channel?.api_key_masked : undefined}
                required={mode === 'create' || base.trim().replace(/\/+$/, '') !== channel?.upstream_base} />
              {mode === 'edit' && <p className="text-xs text-muted-foreground">留空沿用当前密钥。更换地址时需填写密钥，保存后对该渠道下所有模型生效。</p>}
            </div>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" disabled={busy} onClick={() => { setMode('select'); setKey(''); setError('') }}>返回</Button>
              <Button type="submit" disabled={busy}>{busy ? '正在保存…' : '保存渠道'}</Button>
            </div>
          </form>
        ) : <>
          <div className="flex flex-wrap items-end gap-2">
            {channels.length > 0 && <div className="grid min-w-48 flex-1 gap-2">
              <Label htmlFor="channel-select">选择渠道</Label>
              <Select value={channelId} disabled={busy} onValueChange={(value) => { setChannelId(value); resetCatalog() }}>
                <SelectTrigger id="channel-select"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {channels.map((item) => <SelectItem key={item.id} value={String(item.id)}>{item.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>}
            {canEdit && channel && <Button variant="outline" disabled={busy} onClick={() => openForm(channel)}>编辑渠道</Button>}
            {canCreate && <Button variant="outline" disabled={busy} onClick={() => openForm()}>添加渠道</Button>}
          </div>
          {channel && <p className="break-all text-xs text-muted-foreground">{channel.upstream_base} · {channel.api_key_masked}</p>}
          {!channel && <p className="text-sm text-muted-foreground">{busy ? '正在加载渠道…' : '暂无渠道'}</p>}
          {canCreate && channel && <form className="grid gap-3" onSubmit={(event) => importModels(event, channel)}>
            <Button className="justify-self-start" variant="secondary" type="button" disabled={busy} onClick={() => discover(channel)}>
              测试连接并拉取模型
            </Button>
            {models.length > 0 && <>
              <Input aria-label="搜索模型" placeholder="搜索模型 ID" value={search} onChange={(event) => setSearch(event.target.value)} />
              <div className="grid max-h-52 gap-2 overflow-y-auto rounded-md border p-3">
                {matching.length === 0 && <p className="text-sm text-muted-foreground">没有匹配的模型</p>}
                {matching.map((model) => (
                  <Label className="flex items-center gap-2 break-all" key={model}>
                    <Checkbox checked={selected.includes(model)} disabled={busy} onCheckedChange={(checked) =>
                      setSelected((current) => checked === true ? [...current, model] : current.filter((item) => item !== model))} />
                    {model}
                  </Label>
                ))}
              </div>
            </>}
            <div className="grid gap-2">
              <Label htmlFor="channel-manual-models">手动填写模型 ID</Label>
              <Textarea id="channel-manual-models" rows={3} placeholder="每行一个模型 ID，例如 deepseek-chat" value={manual} onChange={(event) => setManual(event.target.value)} />
            </div>
            <Button className="justify-self-end" type="submit" disabled={busy || (!selected.length && !manual.trim())}>
              {busy ? '正在处理…' : selected.length ? `接入模型（已勾选 ${selected.length} 个）` : '接入模型'}
            </Button>
          </form>}
        </>}
      </DialogContent>
    </Dialog>
  )
}

import { useCallback, useEffect, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow, TableState } from '@/components/ui/table'
import { api, type ModelOption, type ModelView } from '@/lib/api'
import ChannelsDialog from '@/pages/ChannelsDialog'
import CreditRulesPanel from '@/pages/CreditRulesPanel'
import GrantsPanel from '@/pages/GrantsPanel'
import ModelDialog from '@/pages/ModelDialog'
import ModelDelegationsDialog from '@/pages/ModelDelegationsDialog'

import { useConfirmation } from '@/components/ConfirmationProvider'
import StatusBadge from '@/components/StatusBadge'

function capabilityLabel(part: string): string {
  if (part === 'streaming') return '流式'
  if (part === 'tools') return '工具'
  if (part === 'reasoning_content') return '思考'
  if (part.startsWith('ctx:')) return `上下文 ${part.slice(4)}`
  return part
}

const noModelPermissions: Record<string, string[]> = {}

export default function ModelsPage({ permissions, modelPermissions = noModelPermissions }: {
  permissions: string[]
  modelPermissions?: Record<string, string[]>
}) {
  const confirm = useConfirmation()
  const scoped = Object.values(modelPermissions)
  const canReadModels = permissions.includes('models.read') || scoped.some((operations) => operations.includes('models.read'))
  const canReadGrants = permissions.includes('grants.read') || scoped.some((operations) => operations.includes('grants.read'))
  const canReadCredits = permissions.includes('credits.read')
  const canCreate = permissions.includes('models.create')
  const canEditChannels = permissions.includes('models.update')
  const can = (modelId: number, operation: string) =>
    permissions.includes(operation) || modelPermissions[modelId]?.includes(operation)
  const [options, setOptions] = useState<ModelOption[]>([])
  const [models, setModels] = useState<ModelView[]>([])
  const [kinds, setKinds] = useState<string[]>(['openai'])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [editingModel, setEditingModel] = useState<ModelView | null>(null)
  const [channelsOpen, setChannelsOpen] = useState(false)
  const [grantsFor, setGrantsFor] = useState<ModelOption | null>(null)
  const [rulesOpen, setRulesOpen] = useState(false)
  const [delegationsFor, setDelegationsFor] = useState<ModelOption | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [catalog, access] = await Promise.all([
        canReadModels ? api.models.list() : null,
        canReadGrants || canReadCredits ? api.accessOptions() : null,
      ])
      setModels(catalog?.items ?? [])
      if (catalog) setKinds(catalog.upstream_kinds)
      setOptions(access?.models ?? [])
      setError(null)
    } catch (caught) {
      setError((caught as Error).message)
    } finally {
      setLoading(false)
    }
  }, [canReadModels, canReadGrants, canReadCredits])

  useEffect(() => { void load() }, [load])

  async function toggle(model: ModelView): Promise<void> {
    const next = model.enabled ? 0 : 1
    const action = next === 0 ? '停用' : '启用'
    if (!await confirm(`${action}「${model.display_name}」？`,
      next === 0 ? '客户端将立即看不到该模型。' : '模型将按现有开放范围重新可用。', action, next === 0)) return
    try {
      await api.models.setStatus(model.id, next)
      await load()
    } catch (caught) {
      setError((caught as Error).message)
    }
  }

  return (
    <section className="space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold">模型与开放范围</h1>
          <p className="mt-1 text-sm text-muted-foreground">按渠道接入上游模型，并为每个模型设置开放范围和额度。</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {canReadCredits && <Button variant="secondary" onClick={() => setRulesOpen(true)}>额度规则</Button>}
          {(canCreate || canEditChannels) && <Button onClick={() => setChannelsOpen(true)}>渠道管理</Button>}
        </div>
      </header>

      {error !== null && <p className="text-sm text-destructive">{error}</p>}

      {canReadModels && <div className="console-panel">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>名称</TableHead>
              <TableHead>上游</TableHead>
              <TableHead>能力</TableHead>
              <TableHead>密钥</TableHead>
              <TableHead>状态</TableHead>
              <TableHead className="text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {models.map((model) => (
              <TableRow key={model.id}>
                <TableCell>
                  <div>{model.display_name}</div>
                  <div className="text-xs text-muted-foreground">{model.code}</div>
                </TableCell>
                <TableCell>
                  <div className="text-sm">{model.upstream_model}</div>
                  <div className="text-xs text-muted-foreground">{model.provider_name || model.upstream_kind} · {model.upstream_base}</div>
                </TableCell>
                <TableCell className="space-x-1">
                  {model.capabilities.split(',').filter(Boolean).map((part) => (
                    <span key={part} className="rounded bg-accent/10 px-2 py-0.5 text-xs">{capabilityLabel(part)}</span>
                  ))}
                </TableCell>
                <TableCell className="text-muted-foreground">{model.api_key_masked}</TableCell>
                <TableCell>
                  <StatusBadge tone={model.enabled ? 'success' : 'neutral'}>
                    {model.enabled ? '启用' : '停用'}
                  </StatusBadge>
                </TableCell>
                <TableCell className="whitespace-nowrap text-right">
                  {can(model.id, 'models.update') && <Button size="sm" variant="ghost" onClick={() => setEditingModel(model)}>编辑</Button>}
                  {can(model.id, 'grants.read') && <Button size="sm" variant="ghost" onClick={() => setGrantsFor(model)}>开放范围</Button>}
                  {can(model.id, 'models.status') && <Button size="sm" variant="ghost" onClick={() => void toggle(model)}>{model.enabled ? '停用' : '启用'}</Button>}
                  {permissions.includes('roles.manage') && <Button size="sm" variant="ghost" onClick={() => setDelegationsFor(model)}>管理权限</Button>}
                </TableCell>
              </TableRow>
            ))}
            {models.length === 0 && (
              <TableState columns={6} loading={loading}>{loading ? '正在加载模型…' : error ? '无法加载模型' : '还没有接入模型'}</TableState>
            )}
          </TableBody>
        </Table>
      </div>}
      {canReadGrants && (
        <ul className="space-y-2">
          {options.filter((option) => can(option.id, 'grants.read')
            && !models.some((model) => model.id === option.id)).map((model) => (
            <li key={model.id} className="flex items-center justify-between rounded border border-border p-3">
              {model.display_name}
              <Button variant="ghost" onClick={() => setGrantsFor(model)}>开放范围</Button>
            </li>
          ))}
        </ul>
      )}

      {editingModel !== null && (
        <ModelDialog
          key={editingModel.id}
          model={editingModel}
          kinds={kinds}
          onClose={() => setEditingModel(null)}
          onSaved={load}
        />
      )}
      {channelsOpen && <ChannelsDialog canCreate={canCreate} canEdit={canEditChannels} onClose={() => setChannelsOpen(false)} onChanged={load} />}
      {grantsFor !== null && <GrantsPanel model={grantsFor} canWrite={Boolean(can(grantsFor.id, 'grants.write'))} onClose={() => setGrantsFor(null)} />}
      {delegationsFor && <ModelDelegationsDialog model={delegationsFor} onClose={() => setDelegationsFor(null)} />}
      {rulesOpen && <CreditRulesPanel models={options} canCreate={permissions.includes("credits.create")} canDelete={permissions.includes("credits.delete")} onClose={() => setRulesOpen(false)} />}
    </section>
  )
}

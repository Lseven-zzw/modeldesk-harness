import { useEffect, useState } from 'react'

import OptionSelect from '@/components/OptionSelect'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { ApiError, api, listAllEmployees, type ModelDelegation, type ModelDelegationSubject, type ModelDelegationSubjectType, type ModelOption } from '@/lib/api'

const labels: Record<ModelDelegationSubjectType, string> = {
  USER: '员工', DEPARTMENT: '部门', GROUP: '用户组',
}

function subjectKey(item: ModelDelegationSubject) {
  return `${item.subject_type}:${item.subject_id}`
}

function sameGrant(left: ModelDelegation, right: ModelDelegation) {
  return left.include_descendants === right.include_descendants &&
    left.permissions.length === right.permissions.length &&
    left.permissions.every((permission) => right.permissions.includes(permission))
}

export default function ModelDelegationsDialog({ model, onClose }: { model: ModelOption; onClose: () => void }) {
  const [catalog, setCatalog] = useState<Awaited<ReturnType<typeof api.models.delegations>> | null>(null)
  const [options, setOptions] = useState<Record<ModelDelegationSubjectType, { value: string; label: string }[]>>({
    USER: [], DEPARTMENT: [], GROUP: [],
  })
  const [items, setItems] = useState<ModelDelegation[]>([])
  const [kind, setKind] = useState<ModelDelegationSubjectType>('USER')
  const [subject, setSubject] = useState('')
  const [reload, setReload] = useState(0)
  const [conflict, setConflict] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true
    Promise.all([api.models.delegations(model.id), listAllEmployees(), api.departments.list(), api.groups.list()])
      .then(([data, people, departments, groups]) => {
        if (!active) return
        setCatalog(data)
        setItems(data.items)
        setOptions({
          USER: people.filter((user) => user.role !== 'ADMIN')
            .map((user) => ({ value: String(user.id), label: `${user.display_name} · ${user.username}` })),
          DEPARTMENT: departments.items.filter((item) => !item.archived)
            .map((item) => ({ value: String(item.id), label: item.name })),
          GROUP: groups.items.map((item) => ({ value: String(item.id), label: item.name })),
        })
      }).catch((caught: Error) => { if (active) setError(caught.message) })
    return () => { active = false }
  }, [model.id, reload])

  const original = new Map(catalog?.items.map((item) => [subjectKey(item), item]))
  const current = new Set(items.map(subjectKey))
  const upsert = items.filter((item) => {
    const previous = original.get(subjectKey(item))
    return !previous || !sameGrant(item, previous)
  })
  const remove = (catalog?.items ?? []).filter((item) => !current.has(subjectKey(item)))
    .map(({ subject_type, subject_id }) => ({ subject_type, subject_id }))
  const canSave = Boolean(catalog && (upsert.length || remove.length)) &&
    !busy && !conflict && items.every((item) => item.permissions.length > 0)

  async function save() {
    if (!catalog || !canSave) return
    setBusy(true)
    setError('')
    try {
      await api.models.saveDelegations(model.id, catalog.revision, upsert, remove)
      onClose()
    } catch (caught) {
      setError((caught as Error).message)
      setConflict(caught instanceof ApiError && caught.code === 'revision_conflict')
    } finally {
      setBusy(false)
    }
  }

  function update(item: ModelDelegation, patch: Partial<ModelDelegation>) {
    setItems(items.map((entry) => entry === item ? { ...entry, ...patch } : entry))
  }

  return <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose() }}>
    <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-2xl">
      <DialogHeader><DialogTitle>管理权限 · {model.display_name}</DialogTitle>
        <DialogDescription>可将此模型的管理权限授给员工、部门或用户组。模型调用仍由开放范围控制。</DialogDescription></DialogHeader>
      {error && <Alert variant="destructive"><AlertDescription>
        {error}
        <Button type="button" variant="outline" size="sm" className="ml-2" onClick={() => {
          setCatalog(null)
          setError('')
          setConflict(false)
          setSubject('')
          setReload((value) => value + 1)
        }}>{conflict ? '放弃本次修改并重新加载' : '重新加载'}</Button>
      </AlertDescription></Alert>}
      {catalog ? <form className="flex flex-col gap-4" onSubmit={(event) => { event.preventDefault(); void save() }}>
        <div className="grid gap-2 sm:grid-cols-[8rem_1fr_auto]">
          <OptionSelect label="授权对象类型" value={kind} disabled={busy || conflict} emptyLabel="选择类型"
            options={Object.entries(labels).map(([value, label]) => ({ value, label }))}
            onChange={(value) => {
              if (!value) return
              setKind(value as ModelDelegationSubjectType)
              setSubject('')
            }} />
          <OptionSelect label="授权对象" value={subject} disabled={busy || conflict} onChange={setSubject}
            emptyLabel={`选择${labels[kind]}`} options={options[kind].filter((item) => !current.has(`${kind}:${item.value}`))} />
          <Button type="button" variant="secondary" disabled={!subject || busy || conflict || items.length >= 500} onClick={() => {
            setItems([...items, { subject_type: kind, subject_id: Number(subject), permissions: ['models.read'], include_descendants: false }])
            setSubject('')
          }}>添加授权</Button>
        </div>
        {!items.length && <p className="text-muted-foreground">此模型还没有委派管理权限。</p>}
        {items.map((item) => <fieldset key={subjectKey(item)} disabled={busy || conflict} className="flex flex-col gap-3 rounded-md border p-3">
          <legend className="px-1 font-semibold">{labels[item.subject_type]} · {
            options[item.subject_type].find((entry) => Number(entry.value) === item.subject_id)?.label ?? `#${item.subject_id}`
          }</legend>
          {item.subject_type === 'DEPARTMENT' && <label className="flex items-center gap-2">
            <Checkbox checked={item.include_descendants} onCheckedChange={(checked) => update(item, { include_descendants: checked === true })} />
            包含当前和将来的下级部门
          </label>}
          <div className="grid gap-2 sm:grid-cols-2">
            {catalog.operations.map((operation) => <label key={operation.code} className="flex items-center gap-2">
              <Checkbox checked={item.permissions.includes(operation.code)}
                onCheckedChange={(checked) => update(item, {
                  permissions: checked ? [...item.permissions, operation.code] : item.permissions.filter((code) => code !== operation.code),
                })} />{operation.name}
            </label>)}
          </div>
          <Button type="button" size="sm" variant="ghost" className="self-end"
            onClick={() => setItems(items.filter((entry) => entry !== item))}>移除授权</Button>
        </fieldset>)}
        <p className="text-sm text-muted-foreground">编辑、启停和管理开放范围自动包含对应的查看权限。</p>
        <Button type="submit" disabled={!canSave}>保存管理权限</Button>
      </form> : !error && <p role="status">正在加载授权…</p>}
    </DialogContent>
  </Dialog>
}

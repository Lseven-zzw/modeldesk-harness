import { useEffect, useState } from 'react'

import OptionSelect from '@/components/OptionSelect'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { api, type CreditRule, type Department, type EmployeeOption, type ModelOption } from '@/lib/api'
import { tokens } from '@/lib/format'

const WAN = 10_000

import { useConfirmation } from '@/components/ConfirmationProvider'

function subjectLabel(rule: CreditRule, employees: EmployeeOption[], models: ModelOption[],
  departments: Pick<Department, 'code' | 'name'>[]): string {
  const model = rule.model_id === 0
    ? '全部模型'
    : (models.find((item) => item.id === rule.model_id)?.display_name ?? `#${rule.model_id}`)
  if (rule.subject_type === 'DEFAULT') return `默认 · ${model}`
  if (rule.subject_type === 'DEPARTMENT') return `${departments.find((item) => item.code === rule.subject_id)?.name ?? rule.subject_id} · ${model}`
  const employee = employees.find((item) => item.id === Number(rule.subject_id))
  return `${employee?.display_name ?? `#${rule.subject_id}`} · ${model}`
}

export default function CreditRulesPanel({ models, canCreate, canDelete, onClose }: { models: ModelOption[]; canCreate: boolean; canDelete: boolean; onClose: () => void }) {
  const confirm = useConfirmation()
  const [rules, setRules] = useState<CreditRule[]>([])
  const [employees, setEmployees] = useState<EmployeeOption[]>([])
  const [departments, setDepartments] = useState<Pick<Department, 'code' | 'name'>[]>([])
  const [subjectType, setSubjectType] = useState<'USER' | 'DEPARTMENT' | 'DEFAULT'>('DEFAULT')
  const [subjectId, setSubjectId] = useState('*')
  const [modelId, setModelId] = useState('0')
  const [limitWan, setLimitWan] = useState('1000')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function load(): Promise<void> {
    try {
      const [rulesBody, { employees: people, departments: options }] = await Promise.all([api.creditRules.list(), api.accessOptions()])
      setRules(rulesBody.items)
      setEmployees(people)
      setDepartments(options)
      setError(null)
    } catch (caught) {
      setError((caught as Error).message)
    }
  }

  useEffect(() => { void load() }, [])

  async function create(): Promise<void> {
    const limit = Math.round(Number(limitWan) * WAN)
    if (!/^[0-9]+(?:\.[0-9]{1,4})?$/.test(limitWan.trim()) || !Number.isSafeInteger(limit)) {
      setError('额度须为非负数字，最多保留四位小数')
      return
    }
    if (subjectType !== 'DEFAULT' && subjectId.trim() === '') {
      setError('请选择或填写主体')
      return
    }
    setBusy(true)
    try {
      await api.creditRules.create({
        subject_type: subjectType,
        subject_id: subjectType === 'DEFAULT' ? '*' : subjectId.trim(),
        model_id: Number(modelId),
        monthly_token_limit: limit,
      })
      await load()
    } catch (caught) {
      setError((caught as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function remove(rule: CreditRule): Promise<void> {
    if (!await confirm(`删除「${subjectLabel(rule, employees, models, departments)}」的额度规则？`,
      '删除后将按其他适用的额度规则计算。', '删除规则')) return
    try {
      await api.creditRules.remove(rule.id)
      await load()
    } catch (caught) {
      setError((caught as Error).message)
    }
  }

  function changeSubjectType(value: string): void {
    const next = value === 'USER' || value === 'DEPARTMENT' ? value : 'DEFAULT'
    setSubjectType(next)
    setSubjectId(next === 'DEFAULT' ? '*' : '')
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="max-h-[80vh] max-w-3xl overflow-y-auto">
        <DialogHeader><DialogTitle>月度额度规则</DialogTitle></DialogHeader>
        <div className="space-y-4">
          {error !== null && <p className="text-sm text-destructive">{error}</p>}

          <p className="text-xs text-muted-foreground">
            裁决顺序：员工 &gt; 部门 &gt; 默认；模型专属规则先于「全部模型」。单位「万 token」，默认 1000 万。
          </p>

          {canCreate && <>
          <div className="grid grid-cols-2 gap-3">
            <div><Label>主体</Label>
              <Select value={subjectType} onValueChange={changeSubjectType}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="DEFAULT">默认（未单独配置的人）</SelectItem>
                  <SelectItem value="DEPARTMENT">部门</SelectItem>
                  <SelectItem value="USER">员工</SelectItem>
                </SelectContent>
              </Select></div>

            <div><Label>模型</Label>
              <Select value={modelId} onValueChange={setModelId}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="0">全部模型</SelectItem>
                  {models.map((model) => <SelectItem key={model.id} value={String(model.id)}>{model.display_name}</SelectItem>)}
                </SelectContent>
              </Select></div>

            <div><Label>主体值</Label>
              {subjectType === 'DEFAULT' && <Input value="*" disabled />}
              {subjectType === 'DEPARTMENT' && (
                <OptionSelect label="额度规则部门" value={subjectId} emptyLabel="选择部门" onChange={setSubjectId}
                  options={departments.map((item) => ({ value: item.code, label: item.name }))} />
              )}
              {subjectType === 'USER' && (
                <Select value={subjectId} onValueChange={setSubjectId}>
                  <SelectTrigger><SelectValue placeholder="选择员工" /></SelectTrigger>
                  <SelectContent>
                    {employees.map((employee) => (
                      <SelectItem key={employee.id} value={String(employee.id)}>{employee.display_name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>

            <div><Label htmlFor="limit-wan">月度额度（万 token）</Label>
              <Input id="limit-wan" inputMode="decimal" value={limitWan}
                     onChange={(event) => setLimitWan(event.target.value)} /></div>
          </div>

          <Button disabled={busy} onClick={() => void create()}>新增规则</Button>
          </>}

          <div className="rounded-md border border-border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>主体 · 模型</TableHead>
                  <TableHead className="text-right">月度额度</TableHead>
                  <TableHead className="text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rules.map((rule) => (
                  <TableRow key={rule.id}>
                    <TableCell>{subjectLabel(rule, employees, models, departments)}</TableCell>
                    <TableCell className="text-right">{tokens(rule.monthly_token_limit)}</TableCell>
                    <TableCell className="text-right">
                      {canDelete && <Button size="sm" variant="ghost" onClick={() => void remove(rule)}>删除</Button>}
                    </TableCell>
                  </TableRow>
                ))}
                {rules.length === 0 && (
                  <TableRow><TableCell colSpan={3} className="text-center text-sm text-muted-foreground">还没有额度规则</TableCell></TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

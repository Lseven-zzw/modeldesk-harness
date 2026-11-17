import { useEffect, useState } from 'react'
import { Activity, CircleAlert, Users } from 'lucide-react'

import StatusBadge, { type StatusTone } from '@/components/StatusBadge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow, TableState } from '@/components/ui/table'
import { api, type CallRow, type ModelView, type SummaryRow } from '@/lib/api'
import { currentMonth, percent, tokens, utcTime } from '@/lib/format'

const PAGE_SIZE = 50
type EmployeeOption = Pick<SummaryRow, 'user_id' | 'display_name'>

const callStatuses: Record<string, { label: string; tone: StatusTone }> = {
  SUCCESS: { label: '成功', tone: 'success' },
  BLOCKED_QUOTA: { label: '额度用尽', tone: 'warning' },
  MODEL_NOT_ALLOWED: { label: '模型未授权', tone: 'warning' },
  INVALID_REQUEST: { label: '请求无效', tone: 'error' },
  UPSTREAM_ERROR: { label: '上游错误', tone: 'error' },
  UPSTREAM_TIMEOUT: { label: '上游超时', tone: 'error' },
  UPSTREAM_INCOMPLETE: { label: '上游响应中断', tone: 'error' },
  CLIENT_CANCELLED: { label: '客户端取消', tone: 'warning' },
}

export default function UsagePage({ canReadModels }: { canReadModels: boolean }) {
  const [month, setMonth] = useState(currentMonth)
  const [summary, setSummary] = useState<SummaryRow[]>([])
  const [summaryPage, setSummaryPage] = useState(1)
  const [totals, setTotals] = useState({ people: 0, used: 0, unknown: 0 })
  const [calls, setCalls] = useState<CallRow[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [employee, setEmployee] = useState<EmployeeOption>()
  const [employeeQuery, setEmployeeQuery] = useState('')
  const [employees, setEmployees] = useState<EmployeeOption[]>([])
  const [employeesError, setEmployeesError] = useState('')
  const [status, setStatus] = useState('')
  const [modelId, setModelId] = useState('')
  const [models, setModels] = useState<ModelView[]>([])
  const [summaryError, setSummaryError] = useState<string | null>(null)
  const [callsError, setCallsError] = useState<string | null>(null)
  const [modelsError, setModelsError] = useState<string | null>(null)
  const [summaryLoading, setSummaryLoading] = useState(true)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!canReadModels) return
    let active = true
    api.models.list().then(
      (result) => { if (active) setModels(result.items) },
      (error: Error) => { if (active) setModelsError(error.message) },
    )
    return () => { active = false }
  }, [canReadModels])

  useEffect(() => {
    let active = true
    setSummaryLoading(true)
    setSummaryError(null)
    setSummary([])
    api.usage.summary(month, summaryPage, PAGE_SIZE).then(
      (result) => {
        if (!active) return
        setSummary(result.items)
        setTotals(result.totals)
      },
      (error: Error) => { if (active) setSummaryError(error.message) },
    ).finally(() => { if (active) setSummaryLoading(false) })
    return () => { active = false }
  }, [month, summaryPage])

  useEffect(() => {
    let active = true
    setEmployeesError('')
    const timer = window.setTimeout(() => {
      api.usage.employees(month, employeeQuery.trim()).then(
        ({ items }) => { if (active) setEmployees(items) },
        (error: Error) => { if (active) setEmployeesError(error.message) },
      )
    }, 250)
    return () => {
      active = false
      window.clearTimeout(timer)
    }
  }, [month, employeeQuery])

  const userId = employee?.user_id

  useEffect(() => {
    let active = true
    setLoading(true)
    setCallsError(null)
    setCalls([])
    setTotal(0)
    api.usage.calls({
      month,
      page,
      page_size: PAGE_SIZE,
      user_id: userId,
      model_id: modelId === '' ? undefined : Number(modelId),
      status,
    }).then(
      (result) => {
        if (!active) return
        setCalls(result.items)
        setTotal(result.total)
      },
      (error: Error) => { if (active) setCallsError(error.message) },
    ).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [month, page, userId, modelId, status])

  const employeeOptions = employee && !employees.some((option) => option.user_id === employee.user_id)
    ? [employee, ...employees]
    : employees
  const modelOptions = canReadModels
    ? models
    : [...new Map(calls.map((call) => [call.model_id, { id: call.model_id, display_name: call.model_code }])).values()]
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const summaryPages = Math.max(1, Math.ceil(totals.people / PAGE_SIZE))

  return (
    <section className="space-y-5">
      <header className="flex items-end justify-between">
        <div>
          <h1>用量分析</h1>
          <p className="mt-1 text-sm text-muted-foreground">按自然月统计（Asia/Shanghai）。额度以「已用 token」为准。</p>
        </div>
        <Input aria-label="账期月份" type="month" value={month} className="w-40"
               onChange={(event) => {
                 if (!event.target.value) return
                 setMonth(event.target.value)
                 setEmployee(undefined)
                 setEmployeeQuery('')
                 setEmployees([])
                 setSummaryPage(1)
                 setPage(1)
               }} />
      </header>

      {summaryError && <p role="alert" className="text-sm text-destructive">汇总加载失败：{summaryError}</p>}

      <dl className="grid gap-4 sm:grid-cols-3" aria-busy={summaryLoading}>
        {[
          { label: '本期已用 Token', value: tokens(totals.used), icon: Activity },
          { label: '有调用的员工', value: totals.people, icon: Users },
          { label: '未知用量调用', value: totals.unknown, icon: CircleAlert, warning: totals.unknown > 0 },
        ].map(({ label, value, icon: Icon, warning }) => (
          <div key={label} className="rounded-lg border bg-card p-5 shadow-sm">
            <dt className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
              <span className="grid size-8 place-items-center rounded-lg bg-primary/10 text-primary">
                <Icon size={16} aria-hidden="true" />
              </span>{label}
            </dt>
            <dd className={`mt-3 text-2xl font-semibold tabular-nums ${warning ? 'text-warning' : ''}`}>
              {summaryLoading || summaryError ? '—' : value}
            </dd>
          </div>
        ))}
      </dl>

      <div className="console-panel">
        <div className="border-b px-4 py-3"><h2 className="font-semibold">员工月度用量</h2></div>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>员工</TableHead>
              <TableHead>部门</TableHead>
              <TableHead className="text-right">额度</TableHead>
              <TableHead className="text-right">已用</TableHead>
              <TableHead className="text-right">占比</TableHead>
              <TableHead className="text-right">调用</TableHead>
              <TableHead className="text-right">未知用量</TableHead>
              <TableHead className="text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {summary.map((row) => (
              <TableRow key={row.user_id}>
                <TableCell>{row.display_name}</TableCell>
                <TableCell>{row.department ?? '—'}</TableCell>
                <TableCell className="text-right">{tokens(row.limit_tokens)}</TableCell>
                <TableCell className="text-right">{tokens(row.used_tokens)}</TableCell>
                <TableCell className="text-right">{percent(row.used_tokens, row.limit_tokens)}</TableCell>
                <TableCell className="text-right">{row.call_count}</TableCell>
                <TableCell className={`text-right ${row.unknown_usage_calls > 0 ? 'text-warning' : 'text-muted-foreground'}`}>
                  {row.unknown_usage_calls}
                </TableCell>
                <TableCell className="whitespace-nowrap text-right">
                  <Button size="sm" variant="ghost"
                          onClick={() => { setEmployee(row); setPage(1) }}>查看调用</Button>
                </TableCell>
              </TableRow>
            ))}
            {summary.length === 0 && !summaryError && (
              <TableState columns={8} loading={summaryLoading}>{summaryLoading ? '正在加载汇总…' : '本月还没有调用'}</TableState>
            )}
          </TableBody>
        </Table>
        {summaryPages > 1 && <div className="flex items-center justify-end gap-3 border-t px-4 py-3 text-sm">
          <Button size="sm" variant="secondary" disabled={summaryLoading || summaryPage <= 1}
                  onClick={() => setSummaryPage(summaryPage - 1)}>上一页</Button>
          <span>第 {summaryPage} / {summaryPages} 页</span>
          <Button size="sm" variant="secondary" disabled={summaryLoading || summaryPage >= summaryPages}
                  onClick={() => setSummaryPage(summaryPage + 1)}>下一页</Button>
        </div>}
      </div>

      <div className="console-panel">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b p-4">
          <h2 className="font-semibold">调用明细</h2>
          <div className="grid w-full min-w-0 grid-cols-2 gap-2 sm:flex sm:w-auto sm:flex-wrap">
            <Input aria-label="搜索员工" placeholder="按姓名或账号搜索" maxLength={100}
                   className="w-full sm:w-44" value={employeeQuery} onChange={(event) => setEmployeeQuery(event.target.value)} />
            <Select value={userId === undefined ? 'all' : String(userId)}
                    onValueChange={(value) => {
                      setEmployee(employeeOptions.find((option) => String(option.user_id) === value))
                      setPage(1)
                    }}>
              <SelectTrigger aria-label="筛选员工" className="w-full sm:w-36"><SelectValue placeholder="全部员工" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部员工</SelectItem>
                {employeeOptions.map((row) => (
                  <SelectItem key={row.user_id} value={String(row.user_id)}>{row.display_name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={modelId || 'all'}
                    onValueChange={(value) => { setModelId(value === 'all' ? '' : value); setPage(1) }}>
              <SelectTrigger aria-label="筛选模型" className="w-full sm:w-36"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部模型</SelectItem>
                {modelOptions.map((model) => (
                  <SelectItem key={model.id} value={String(model.id)}>{model.display_name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={status === '' ? 'all' : status}
                    onValueChange={(value) => { setStatus(value === 'all' ? '' : value); setPage(1) }}>
              <SelectTrigger aria-label="筛选状态" className="w-full sm:w-32"><SelectValue placeholder="全部状态" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部状态</SelectItem>
                {Object.entries(callStatuses).map(([key, value]) => (
                  <SelectItem key={key} value={key}>{value.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        {employeesError && <p role="alert" className="m-4 text-sm text-destructive">员工搜索失败：{employeesError}</p>}
        {modelsError && <p role="alert" className="m-4 text-sm text-destructive">模型筛选加载失败：{modelsError}</p>}
        {callsError && <p role="alert" className="m-4 text-sm text-destructive">明细加载失败：{callsError}</p>}

        <div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>时间</TableHead>
                <TableHead>员工</TableHead>
                <TableHead>模型</TableHead>
                <TableHead className="text-right">输入</TableHead>
                <TableHead className="text-right">输出</TableHead>
                <TableHead className="text-right">合计</TableHead>
                <TableHead>状态</TableHead>
                <TableHead className="text-right">延迟 ms</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {calls.map((row) => (
                <TableRow key={row.id}>
                  <TableCell className="whitespace-nowrap text-xs text-muted-foreground">{utcTime(row.created_at)}</TableCell>
                  <TableCell>{row.display_name ?? `#${row.user_id}`}</TableCell>
                  <TableCell>{row.model_code}</TableCell>
                  <TableCell className="text-right">{tokens(row.input_tokens)}</TableCell>
                  <TableCell className="text-right">{tokens(row.output_tokens)}</TableCell>
                  <TableCell className="text-right">{tokens(row.total_tokens)}</TableCell>
                  <TableCell><StatusBadge tone={callStatuses[row.status]?.tone ?? 'neutral'}>
                    {callStatuses[row.status]?.label ?? row.status}
                  </StatusBadge></TableCell>
                  <TableCell className="text-right">{row.latency_ms}</TableCell>
                </TableRow>
              ))}
              {calls.length === 0 && !callsError && (
                <TableState columns={8} loading={loading}>{loading ? '正在加载调用明细…' : '没有匹配的调用'}</TableState>
              )}
            </TableBody>
          </Table>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t p-4 text-xs text-muted-foreground">
          <span>共 {total} 条</span>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="secondary" disabled={loading || page <= 1} onClick={() => setPage(page - 1)}>上一页</Button>
            <span>第 {page} / {pages} 页</span>
            <Button size="sm" variant="secondary" disabled={loading || page >= pages} onClick={() => setPage(page + 1)}>下一页</Button>
          </div>
        </div>
      </div>
    </section>
  )
}

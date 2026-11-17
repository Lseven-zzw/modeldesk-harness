import { useEffect, useState, type FormEvent } from 'react'
import type { ClientRemote, EnterpriseView, ModelDeskUsage } from '@deepseek-ai/dsh-api-remotes/client'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './EnterpriseSection.module.css'

const USAGE_INTERVAL_MS = 30_000
const numberFormat = new Intl.NumberFormat('zh-CN')
const dateFormat = new Intl.DateTimeFormat('zh-CN', {
  dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Shanghai',
})

function dateLabel(value: string): string {
  const date = Date.parse(value)
  return Number.isFinite(date) ? dateFormat.format(date) : '—'
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '企业账号暂时无法访问，请重试。'
}

export function EnterpriseSection({ remote }: { readonly remote: ClientRemote }) {
  const [view, setView] = useState<EnterpriseView>()
  const [addressDraft, setAddressDraft] = useState<string>()
  const [ticket, setTicket] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [streamError, setStreamError] = useState<string>()
  const [usage, setUsage] = useState<ModelDeskUsage>()
  const [usageError, setUsageError] = useState<string>()
  const signedIn = view?.phase === 'signed-in'
  const signingIn = view?.phase === 'signing-in'
  const accountKey = signedIn ? JSON.stringify([view.baseUrl, view.user?.id, view.sessionExpiresAt]) : undefined

  useEffect(() => {
    let active = true
    const stream = remote.$stream<EnterpriseView>({
      name: 'enterprise',
      open: signal => remote.enterprise.watch(signal),
      ended: () => new Error('企业账号连接已关闭'),
    })
    void (async () => {
      try {
        for await (const frame of stream) {
          if (!active) break
          setView(frame.value)
          frame.accept()
          setStreamError(undefined)
        }
      } catch (caught) {
        if (active) setStreamError(errorMessage(caught))
      }
    })()
    return () => {
      active = false
      stream.dispose()
    }
  }, [remote])

  useEffect(() => {
    setUsage(undefined)
    setUsageError(undefined)
    if (accountKey === undefined) return
    let active = true
    let timer: ReturnType<typeof setTimeout> | undefined
    async function poll(): Promise<void> {
      try {
        const result = await remote.enterprise.getUsage()
        if (!active) return
        if (!result.ok) throw result.error
        setUsage(result.value)
        setUsageError(undefined)
      } catch (caught) {
        if (active) setUsageError(errorMessage(caught))
      } finally {
        if (active) timer = setTimeout(() => { void poll() }, USAGE_INTERVAL_MS)
      }
    }
    void poll()
    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [accountKey, remote])

  async function run<T>(action: () => Promise<{ ok: true; value: T } | { ok: false; error: unknown }>,
    onSuccess?: (value: T) => void): Promise<void> {
    if (busy) return
    setBusy(true)
    setError(undefined)
    try {
      const result = await action()
      if (!result.ok) throw result.error
      onSuccess?.(result.value)
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setBusy(false)
    }
  }

  function saveAddress(event: FormEvent): void {
    event.preventDefault()
    if (addressDraft === undefined) return
    void run(() => remote.enterprise.setBaseUrl(addressDraft), next => {
      setView(next)
      setAddressDraft(undefined)
      setTicket('')
    })
  }

  function submitTicket(event: FormEvent): void {
    event.preventDefault()
    void run(() => remote.enterprise.submitTicket(ticket), () => { setTicket('') })
  }

  const message = error ?? view?.error?.message ?? streamError
  const address = addressDraft ?? view?.baseUrl ?? ''
  return (
    <section className={css.section} aria-label="企业账号">
      <h2 className={css.heading}>企业账号</h2>
      <form className={css.card} onSubmit={saveAddress}>
        <label htmlFor="modeldesk-platform-address">平台地址</label>
        <div className={css.row}>
          <input id="modeldesk-platform-address" value={address} onChange={event => setAddressDraft(event.target.value)}
            placeholder="https://modeldesk.example.com" required autoComplete="url" />
          <Button type="submit" variant="outline"
            disabled={busy || view === undefined || addressDraft === undefined || address.trim() === ''}>保存</Button>
        </div>
        {signedIn && <p className={css.secondary}>更换平台地址会退出当前企业账号。</p>}
      </form>

      <div className={css.card}>
        {view === undefined ? <p role="status">正在读取企业账号…</p> : signingIn ? (
          <>
            <p role="status" className={css.pending}>等待浏览器授权…</p>
            {view.login && (
              <p className={css.secondary}>
                授权有效至 {dateLabel(view.login.expiresAt)} ·{' '}
                <a href={view.login.authorizeUrl} target="_blank" rel="noreferrer">重新打开授权页</a>
              </p>
            )}
            <Button variant="outline" disabled={busy}
              onClick={() => { void run(() => remote.enterprise.cancelLogin(), next => { setView(next); setTicket('') }) }}>取消</Button>
            <details>
              <summary>手动粘贴授权票据</summary>
              <form className={css.row} onSubmit={submitTicket}>
                <input aria-label="授权票据" type="password" autoComplete="off" value={ticket}
                  onChange={event => setTicket(event.target.value)} required />
                <Button type="submit" variant="outline" disabled={busy || ticket.trim() === ''}>提交票据</Button>
              </form>
            </details>
          </>
        ) : signedIn ? (
          <>
            <p className={css.signedIn}>已登录</p>
            <dl className={css.details}>
              <div><dt>姓名</dt><dd>{view.user?.displayName ?? '—'}</dd></div>
              <div><dt>部门</dt><dd>{view.user?.department ?? '—'}</dd></div>
              <div><dt>会话有效至</dt><dd>{view.sessionExpiresAt ? dateLabel(view.sessionExpiresAt) : '—'}</dd></div>
            </dl>
            <div className={css.row}>
              <Button variant="outline" disabled={busy} onClick={() => { void run(() => remote.enterprise.refreshModels(), setView) }}>刷新模型</Button>
              <Button variant="outline" disabled={busy} onClick={() => { void run(() => remote.enterprise.logout(), setView) }}>退出登录</Button>
            </div>
          </>
        ) : (
          <>
            <p className={css.secondary}>{view.baseUrl ? '未登录' : '请先保存企业平台地址。'}</p>
            <Button variant="primary" className={css.primary} disabled={busy || !view.baseUrl}
              onClick={() => { void run(() => remote.enterprise.startLogin()) }}>浏览器授权登录</Button>
          </>
        )}
        {message && <p role="alert" className={css.error}>{message}</p>}
      </div>

      {signedIn && (
        <div className={css.card}>
          <h3>本月用量</h3>
          {usage && (
            <dl className={css.details}>
              <div><dt>已用</dt><dd>{numberFormat.format(usage.usedTokens)} token</dd></div>
              <div><dt>剩余</dt><dd>{numberFormat.format(usage.remainingTokens)} token</dd></div>
              <div><dt>重置时间</dt><dd>{dateLabel(usage.resetsAt)}</dd></div>
            </dl>
          )}
          {!usage && !usageError && <p role="status">正在读取用量…</p>}
          {usageError && <p role="alert" className={css.error}>{usageError}</p>}
        </div>
      )}
    </section>
  )
}

import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { MemoryCredentials } from '../../../credentials/credentials/tests/memory.ts'
import { SESSION_KEY } from '../src/credentials.ts'
import { LoginFlow } from '../src/login-flow.ts'
import { ModelDeskSession } from '../src/session.ts'
import type { ModelDeskSignedIn } from '../src/types.ts'

const base = 'http://127.0.0.1:8081'

const tokenBody = {
  token_type: 'Bearer',
  access_token: 'at_1',
  expires_in: 600,
  refresh_token: 'rt_1',
  refresh_expires_in: 2_592_000,
  session_id: 'gsess_01',
  session_expires_at: new Date(Date.now() + 2_592_000_000).toISOString(),
  user: { id: '1001', username: 'zhang.san', display_name: '张三', department: '剪辑部' },
  org: { id: 'modeldesk', name: '山东金东数字传媒' },
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

interface Recorded { readonly body: Record<string, unknown> | undefined }

function fakePlatform(overrides: { authorizations?: (body: Record<string, unknown>) => Response } = {}) {
  const calls: Recorded[] = []
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body)) as Record<string, unknown>
    calls.push({ body })
    if (url.endsWith('/config')) return json({ enabled: true, client_id: 'modeldesk-desktop', contract_version: '0.1.0' })
    if (url.endsWith('/authorizations')) {
      const created = { auth_id: 'gtx_01', authorize_url: 'http://127.0.0.1:8081/desktop-login?auth_id=gtx_01', expires_in: 300 }
      return overrides.authorizations?.(body ?? {}) ?? json(created)
    }
    if (url.endsWith('/token')) return json(tokenBody)
    if (url.endsWith('/models')) return json({ object: 'list', data: [] })
    return json({})
  })
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls }
}

async function harness(fetchImpl: typeof fetch) {
  const ctx = new Context()
  const credentials = new MemoryCredentials(ctx)
  const session = new ModelDeskSession(credentials, { fetchImpl })
  await session.load()
  const opened: string[] = []
  const flow = new LoginFlow(session, { openBrowser: async (url) => { opened.push(url) }, deviceName: () => '金东-测试', clientVersion: '0.0.0-test' })
  return { credentials, session, flow, opened }
}

describe('LoginFlow', () => {
  it('opens the authorize URL and commits the session once when the browser callbacks', async () => {
    const { fetchImpl, calls } = fakePlatform()
    const { credentials, flow, opened, session } = await harness(fetchImpl)
    const started = await flow.start(base)

    expect(opened).toEqual([started.authorizeUrl])
    expect(started.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/modeldesk\/callback$/)
    const authorize = calls.find(call => call.body?.grant_type === undefined && call.body?.redirect_uri !== undefined)?.body
    expect(authorize).toMatchObject({ client_id: 'modeldesk-desktop', code_challenge_method: 'S256', device_name: '金东-测试' })
    expect(String(authorize?.redirect_uri)).toBe(started.redirectUri)

    const callback = `${started.redirectUri}?auth_id=gtx_01&identity_ticket=${'t'.repeat(24)}&state=${String(authorize?.state)}`
    expect((await fetch(callback)).status).toBe(200)
    await vi.waitFor(async () => {
      const stored = await credentials.readRecord(SESSION_KEY)
      expect((stored?.kind === 'grant' ? stored.payload as ModelDeskSignedIn : undefined)?.accessToken).toBe('at_1')
    })
    expect(calls.filter(call => (call.body as Record<string, unknown> | undefined)?.grant_type === 'identity_ticket')).toHaveLength(1)
    expect(await session.signedIn()).toBeDefined()
    expect(flow.current()).toBeUndefined()
  })

  it('accepts a pasted ticket when the browser cannot reach loopback', async () => {
    const { fetchImpl, calls } = fakePlatform()
    const { credentials, flow } = await harness(fetchImpl)
    await flow.start(base)
    flow.submitTicket('p'.repeat(24))
    await vi.waitFor(async () => {
      expect(await credentials.readRecord(SESSION_KEY)).toBeDefined()
    })
    const exchanges = calls.filter(call => (call.body as Record<string, unknown> | undefined)?.grant_type === 'identity_ticket')
    expect(exchanges).toHaveLength(1)
    expect((await flow.current())).toBeUndefined()
  })

  it('reports a denied authorization and exchanges nothing', async () => {
    const { fetchImpl, calls } = fakePlatform()
    const { flow } = await harness(fetchImpl)
    const started = await flow.start(base)
    const authorize = calls.find(call => typeof call.body?.redirect_uri === 'string')?.body
    await fetch(`${started.redirectUri}?auth_id=gtx_01&error=access_denied&state=${String(authorize?.state)}`)
    await vi.waitFor(() => { expect(flow.failure()?.code).toBe('access_denied') })
    expect(calls.filter(call => (call.body as Record<string, unknown> | undefined)?.grant_type === 'identity_ticket')).toHaveLength(0)
  })

  it('refuses a second attempt while one is waiting', async () => {
    const { fetchImpl } = fakePlatform()
    const { flow } = await harness(fetchImpl)
    await flow.start(base)
    await expect(flow.start(base)).rejects.toMatchObject({ code: 'login_in_flight' })
    await flow.cancel()
  })

  it('reserves an attempt before awaiting platform configuration', async () => {
    const { fetchImpl } = fakePlatform()
    const { flow } = await harness(fetchImpl)
    const first = flow.start(base)
    await expect(flow.start(base)).rejects.toMatchObject({ code: 'login_in_flight' })
    await first
    await flow.cancel()
  })

  it('does not store tokens when the exchange returns after cancellation', async () => {
    const { fetchImpl } = fakePlatform()
    let release = () => {}
    const gate = new Promise<void>(resolve => { release = resolve })
    let exchangeStarted = false
    const { credentials, flow } = await harness(async (input, init) => {
      if (String(input).endsWith('/token')) {
        exchangeStarted = true
        await gate
      }
      return fetchImpl(input, init)
    })
    await flow.start(base)
    flow.submitTicket('p'.repeat(24))
    await vi.waitFor(() => { expect(exchangeStarted).toBe(true) })
    await flow.cancel()
    release()
    await new Promise<void>(resolve => { setImmediate(resolve) })
    expect(await credentials.readRecord(SESSION_KEY)).toBeUndefined()
    expect(flow.current()).toBeUndefined()
  })
})

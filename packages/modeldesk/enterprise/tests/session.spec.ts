import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { MemoryCredentials } from '../../../credentials/credentials/tests/memory.ts'
import { SESSION_KEY } from '../src/credentials.ts'
import { ModelDeskSession } from '../src/session.ts'
import type { ModelDeskSignedIn } from '../src/types.ts'

const base = 'https://modeldesk.example.com'

function signedIn(overrides: Partial<ModelDeskSignedIn> = {}): ModelDeskSignedIn {
  return {
    version: 1,
    baseUrl: base,
    sessionId: 'gsess_01',
    accessToken: 'at_old',
    accessExpiresAt: Date.now() + 600_000,
    refreshToken: 'rt_old',
    refreshExpiresAt: Date.now() + 2_592_000_000,
    absoluteExpiresAt: Date.now() + 2_592_000_000,
    user: { id: '1001', username: 'zhang.san', displayName: '张三', department: '剪辑部' },
    org: { id: 'modeldesk', name: '示例组织' },
    models: [],
    modelsFetchedAt: 0,
    ...overrides,
  }
}

function tokenResponse(access: string, refresh: string): Response {
  return new Response(JSON.stringify({
    token_type: 'Bearer',
    access_token: access,
    expires_in: 600,
    refresh_token: refresh,
    refresh_expires_in: 2_592_000,
    session_id: 'gsess_01',
    session_expires_at: new Date(Date.now() + 2_592_000_000).toISOString(),
    user: { id: '1001', username: 'zhang.san', display_name: '张三', department: '剪辑部' },
    org: { id: 'modeldesk', name: '示例组织' },
  }), { status: 200, headers: { 'content-type': 'application/json' } })
}

async function harness(initial: ModelDeskSignedIn, fetchImpl: typeof fetch) {
  const ctx = new Context()
  const credentials = new MemoryCredentials(ctx)
  await credentials.modifyRecord(SESSION_KEY, async () => ({ kind: 'grant', payload: initial }))
  const session = new ModelDeskSession(credentials, { fetchImpl })
  await session.load()
  return { credentials, session }
}

describe('ModelDeskSession', () => {
  it('returns the cached access token while it is fresh', async () => {
    const fetchImpl = vi.fn()
    const { session } = await harness(signedIn(), fetchImpl as unknown as typeof fetch)
    expect(await session.accessToken()).toBe('at_old')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('rotates the refresh token once under concurrency and persists it', async () => {
    const fetchImpl = vi.fn(async () => tokenResponse('at_new', 'rt_new'))
    const expired = signedIn({ accessExpiresAt: Date.now() - 1 })
    const { session, credentials } = await harness(expired, fetchImpl as unknown as typeof fetch)

    const [first, second] = await Promise.all([session.accessToken(), session.accessToken()])

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(first).toBe('at_new')
    expect(second).toBe('at_new')
    const stored = await credentials.readRecord(SESSION_KEY)
    expect((stored?.kind === 'grant' ? stored.payload as ModelDeskSignedIn : undefined)?.refreshToken).toBe('rt_new')
  })

  it('does not refresh twice when another caller already replaced the rejected token', async () => {
    const fetchImpl = vi.fn(async () => tokenResponse('at_new', 'rt_new'))
    const { session } = await harness(signedIn(), fetchImpl as unknown as typeof fetch)
    await session.refresh()
    const token = await session.recover('at_old')
    expect(token).toBe('at_new')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('refuses to refresh an expired absolute session', async () => {
    const fetchImpl = vi.fn()
    const expired = signedIn({ absoluteExpiresAt: Date.now() - 1, accessExpiresAt: Date.now() - 1 })
    const { session } = await harness(expired, fetchImpl as unknown as typeof fetch)
    await expect(session.accessToken()).rejects.toMatchObject({ code: 'session_expired' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('retries one authenticated read after a 401', async () => {
    const modelsCalls: string[] = []
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/api/v1/modeldesk/models')) {
        const authorization = (init?.headers as Record<string, string> | undefined)?.authorization
        modelsCalls.push(String(authorization))
        if (authorization === 'Bearer at_old') {
          return new Response(JSON.stringify({ error: { code: 'invalid_access_token', type: 'authentication_error' } }), { status: 401 })
        }
        return new Response(JSON.stringify({ object: 'list', data: [] }), { status: 200 })
      }
      if (url.endsWith('/token')) return tokenResponse('at_new', 'rt_new')
      return new Response(JSON.stringify({}), { status: 200 })
    })
    const { session } = await harness(signedIn(), fetchImpl as unknown as typeof fetch)
    expect(await session.models(true)).toEqual([])
    expect(modelsCalls).toEqual(['Bearer at_old', 'Bearer at_new'])
  })

  it('keeps the address and clears tokens on logout', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }))
    const { session, credentials } = await harness(signedIn(), fetchImpl as unknown as typeof fetch)
    await session.logout()
    const stored = await credentials.readRecord(SESSION_KEY)
    expect(stored?.kind === 'grant' ? stored.payload : undefined).toEqual({ version: 1, baseUrl: base })
    expect(await session.signedIn()).toBeUndefined()
  })

  it('returns to signed out after the platform revokes a replayed refresh token', async () => {
    const fetchImpl = vi.fn(async () => Response.json({
      error: { code: 'refresh_token_reused', message: '会话已撤销' },
    }, { status: 401 }))
    const { session, credentials } = await harness(signedIn({ accessExpiresAt: Date.now() - 1 }), fetchImpl)
    await expect(session.accessToken()).rejects.toMatchObject({ code: 'refresh_token_reused' })
    expect(await session.signedIn()).toBeUndefined()
    const stored = await credentials.readRecord(SESSION_KEY)
    expect(stored?.kind === 'grant' ? stored.payload : undefined).toEqual({ version: 1, baseUrl: base })
  })

  it('does not use a token from a different session to recover an old request', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ object: 'list', data: [] })))
    const { session } = await harness(signedIn(), fetchImpl as unknown as typeof fetch)
    await session.setBaseUrl('https://other.example.com')
    const wire = await tokenResponse('at_other', 'rt_other').json()
    wire.user.department = null
    wire.session_id = 'gsess_other'
    await session.acceptSignedIn('https://other.example.com', wire)
    await expect(session.recover('at_old')).rejects.toMatchObject({ code: 'signed_out' })
    expect((await session.signedIn())?.user.department).toBeNull()
  })

  it('reload reports no change for a session-owned write and picks up an external sign-out', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }))
    const { session, credentials } = await harness(signedIn(), fetchImpl)
    expect(await session.reload()).toBe(false)
    await credentials.modifyRecord(SESSION_KEY, async () => ({ kind: 'grant', payload: { version: 1, baseUrl: base } }))
    expect(await session.reload()).toBe(true)
    expect(await session.signedIn()).toBeUndefined()
    expect(await session.reload()).toBe(false)
  })
})

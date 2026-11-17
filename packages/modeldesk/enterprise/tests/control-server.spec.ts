import { mkdtemp, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { startControlServer, type ControlAccountPort } from '../src/control-server.ts'
import type { EnterpriseView } from '../src/types.ts'

const emptyView: EnterpriseView = {
  baseUrl: null, phase: 'unconfigured', user: null, org: null, sessionExpiresAt: null, models: [], login: null,
}

function port(overrides: Partial<ControlAccountPort> = {}): ControlAccountPort {
  return {
    state: async () => emptyView,
    saveBaseUrl: async () => emptyView,
    startLogin: async () => ({ authorizeUrl: 'https://modeldesk.example.com/desktop-login?auth_id=gtx_01', expiresAt: new Date(Date.now() + 300_000).toISOString() }),
    ...overrides,
  }
}

async function start(account: ControlAccountPort = port()) {
  const home = await mkdtemp(join(tmpdir(), 'modeldesk-home-'))
  const server = await startControlServer({ account, home })
  const base = `http://127.0.0.1:${server.port}`
  return { home, server, base, file: join(home, 'modeldesk', 'control.json') }
}

describe('control server', () => {
  it('publishes port and token with owner-only permissions', async () => {
    const { server, file } = await start()
    const published = JSON.parse(await readFile(file, 'utf8')) as { version: number; port: number; token: string }
    expect(published).toMatchObject({ version: 1, port: server.port, token: server.token })
    if (process.platform !== 'win32') expect((await stat(file)).mode & 0o777).toBe(0o600)
    await server.close()
    await expect(readFile(file, 'utf8')).rejects.toThrow()
  })

  it('rejects a missing or wrong handshake token', async () => {
    const { server, base } = await start()
    expect((await fetch(`${base}/status`)).status).toBe(401)
    const wrong = await fetch(`${base}/status`, { headers: { 'x-modeldesk-token': 'x'.repeat(server.token.length) } })
    expect(wrong.status).toBe(401)
    await server.close()
  })

  it('serves state and starts a login through the handshake', async () => {
    const calls: string[] = []
    const { server, base } = await start(port({
      saveBaseUrl: async raw => { calls.push(`save:${raw}`); return emptyView },
      startLogin: async () => { calls.push('login'); return { authorizeUrl: 'https://modeldesk.example.com/desktop-login?auth_id=gtx_01', expiresAt: '2026-11-09T10:00:00Z' } },
    }))
    const headers = { 'x-modeldesk-token': server.token, 'content-type': 'application/json' }
    const status = await fetch(`${base}/status`, { headers })
    expect(status.status).toBe(200)
    expect((await status.json() as { state: EnterpriseView }).state.phase).toBe('unconfigured')

    const login = await fetch(`${base}/login`, { method: 'POST', headers, body: JSON.stringify({ server: 'https://modeldesk.example.com' }) })
    expect(login.status).toBe(200)
    expect(calls).toEqual(['save:https://modeldesk.example.com', 'login'])
    await server.close()
  })

  it('requires JSON and refuses other paths', async () => {
    const { server, base } = await start()
    const text = await fetch(`${base}/login`, { method: 'POST', headers: { 'x-modeldesk-token': server.token, 'content-type': 'text/plain' }, body: 'server=x' })
    expect(text.status).toBe(415)
    const missing = await fetch(`${base}/login`, { method: 'POST', headers: { 'x-modeldesk-token': server.token, 'content-type': 'application/json' }, body: '{}' })
    expect(missing.status).toBe(400)
    const unknown = await fetch(`${base}/elsewhere`, { headers: { 'x-modeldesk-token': server.token } })
    expect(unknown.status).toBe(404)
    await server.close()
  })

  it('rejects oversized, null and credential-bearing login payloads', async () => {
    const { server, base } = await start(port({
      saveBaseUrl: async () => { throw new Error('must not update the saved address') },
    }))
    const headers = { 'x-modeldesk-token': server.token, 'content-type': 'application/json' }
    try {
      const login = (body: string) => fetch(`${base}/login`, { method: 'POST', headers, body })
      expect((await login('null')).status).toBe(400)
      expect((await login(JSON.stringify({ server: 'https://u:p@example.com' }))).status).toBe(400)
      expect((await login(JSON.stringify({ server: 'https://example.com', code: 'ticket' }))).status).toBe(400)
      expect((await login(JSON.stringify({ server: 'x'.repeat(5000) }))).status).toBe(413)
    } finally {
      await server.close()
    }
  })

  it('keeps the current handshake when an older instance closes', async () => {
    const { server: older, home, file } = await start()
    const newer = await startControlServer({ account: port(), home })
    try {
      await older.close()
      expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({ token: newer.token })
    } finally {
      await newer.close()
      await older.close()
    }
  })
})

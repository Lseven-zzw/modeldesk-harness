import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemoryCredentials } from '../../../credentials/credentials/tests/memory.ts'
import { SESSION_KEY } from '../src/credentials.ts'
import { ModelDeskAccount } from '../src/index.ts'
import { EnterpriseController } from '../src/remote.ts'
import type { EnterpriseView, ModelDeskSignedIn } from '../src/types.ts'

vi.mock('../src/control-server.ts', () => ({
  startControlServer: async () => ({ close: async () => {} }),
}))

const roots: Context[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(ctx => ctx.fiber.dispose())) })

async function harness(initial?: ModelDeskSignedIn) {
  const ctx = new Context()
  roots.push(ctx)
  await ctx.plugin(MemoryCredentials)
  if (initial !== undefined) {
    await ctx.credentials.modifyRecord(SESSION_KEY, async () => ({ kind: 'grant', payload: initial }))
  }
  await ctx.plugin(ModelDeskAccount)
  const controller = new EnterpriseController(ctx)
  return { ctx, controller }
}

describe('EnterpriseController', () => {
  it('reports unconfigured, then signed-out after the address is saved', async () => {
    const { controller } = await harness()
    expect((await controller.getState()).phase).toBe('unconfigured')
    const saved = await controller.setBaseUrl('https://modeldesk.example.com/')
    expect(saved).toMatchObject({ baseUrl: 'https://modeldesk.example.com', phase: 'signed-out' })
  })

  it('maps a business refusal to modeldesk/rejected with its own code', async () => {
    const { controller } = await harness()
    await expect(controller.startLogin()).rejects.toMatchObject({ code: 'modeldesk/rejected', details: { code: 'unconfigured' } })
    await expect(controller.getUsage()).rejects.toMatchObject({ code: 'modeldesk/rejected', details: { code: 'signed_out' } })
    await expect(controller.setBaseUrl('http://modeldesk.example.com')).rejects.toMatchObject({ details: { code: 'invalid_base_url' } })
  })

  it('streams the current snapshot first and one more after a change', async () => {
    const { controller } = await harness()
    const abort = new AbortController()
    const iterator = controller.watch(abort.signal)[Symbol.asyncIterator]()
    const first = (await iterator.next()).value as EnterpriseView
    expect(first.phase).toBe('unconfigured')
    await controller.setBaseUrl('https://modeldesk.example.com')
    const second = (await iterator.next()).value as EnterpriseView
    expect(second.phase).toBe('signed-out')
    abort.abort()
    expect((await iterator.next()).done).toBe(true)
  })

  it('omits stored credentials from signed-in snapshots and the watch stream', async () => {
    const { controller } = await harness({
      version: 1, baseUrl: 'https://modeldesk.example.com', sessionId: 'gsess_01',
      accessToken: 'private-access-token', accessExpiresAt: Date.now() + 60_000,
      refreshToken: 'private-refresh-token', refreshExpiresAt: Date.now() + 120_000,
      absoluteExpiresAt: Date.now() + 120_000,
      user: { id: '1', username: 'employee', displayName: '员工', department: null },
      org: { id: 'modeldesk', name: 'ModelDesk Harness' }, models: [], modelsFetchedAt: 0,
    })
    const abort = new AbortController()
    const iterator = controller.watch(abort.signal)[Symbol.asyncIterator]()
    const state = await controller.getState()
    expect(state.phase).toBe('signed-in')
    expect((await iterator.next()).value).toEqual(state)
    expect(JSON.stringify(state)).not.toMatch(/private-access-token|private-refresh-token/)
    abort.abort()
    expect((await iterator.next()).done).toBe(true)
  })
})

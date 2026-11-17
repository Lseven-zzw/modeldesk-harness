import { open } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'

export const MODELDESK_SCHEME = 'modeldesk'

/** Parse only the address-only login link; the platform address must be percent encoded. */
export function parseModelDeskLoginLink(raw: string): string | undefined {
  const prefix = 'modeldesk://login?server='
  if (!raw.startsWith(prefix) || raw.length > 2048) return undefined
  const encoded = raw.slice(prefix.length)
  if (!/^[a-z0-9._~%-]+$/iu.test(encoded)) return undefined
  try {
    const decoded = decodeURIComponent(encoded)
    if (!/^https?:\/\/[^/?#@\\\s]+\/?$/iu.test(decoded)) return undefined
    const url = new URL(decoded)
    const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) return undefined
    return url.origin
  } catch {
    return undefined
  }
}

const handshakeSchema = z.object({
  version: z.literal(1),
  port: z.number().int().min(1).max(65535),
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
  pid: z.number().int().positive(),
})

const stateSchema = z.object({
  service: z.literal('modeldesk-control'),
  version: z.literal(1),
  state: z.object({
    baseUrl: z.string().nullable(),
    phase: z.enum(['unconfigured', 'signed-out', 'signing-in', 'signed-in']),
    user: z.object({ displayName: z.string() }).nullable(),
  }),
})

/** Connect only to the current child Host's authenticated loopback endpoint. */
export async function connectModelDeskLogin(home: string, hostPid: number) {
  const file = await open(join(home, 'modeldesk', 'control.json'), 'r')
  let handshake: z.infer<typeof handshakeSchema>
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.size > 4096) throw new Error('ModelDesk Harness登录服务握手文件无效')
    handshake = handshakeSchema.parse(JSON.parse(await file.readFile('utf8')) as unknown)
  } finally {
    await file.close()
  }
  if (handshake.pid !== hostPid) throw new Error('ModelDesk Harness登录服务尚未就绪')
  const send = async (path: string, init: RequestInit = {}) => {
    const response = await fetch('http://127.0.0.1:' + handshake.port + path, {
      ...init,
      headers: { 'x-modeldesk-token': handshake.token, 'content-type': 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(45_000),
    })
    if (!response.ok) {
      const failure = z.object({ error: z.object({ message: z.string() }) })
        .safeParse(await response.json().catch(() => undefined))
      throw new Error(failure.success ? failure.data.error.message : '无法启动ModelDesk Harness登录')
    }
    return response
  }
  const response = await send('/status')
  const { state } = stateSchema.parse(await response.json())
  return {
    state,
    async start(server: string): Promise<void> {
      const response = await send('/login', { method: 'POST', body: JSON.stringify({ server }) })
      await response.body?.cancel()
    },
  }
}

/**
 * The persistent local control endpoint the desktop shell posts deep links to.
 * It is not the OAuth callback: that listener is per-attempt (B2). This one
 * outlives attempts, binds an ephemeral loopback port, publishes its address
 * and a single handshake token to `$DSH_HOME/modeldesk/control.json`, and accepts
 * only requests from this machine carrying that token.
 * @module @modeldesk/dsh-enterprise/control-server
 */
import { timingSafeEqual, randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdir, readFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { ModelDeskApiError, normalizeBaseUrl } from './platform.ts'
import type { EnterpriseView } from './types.ts'

/** The four capabilities the shell needs; `ModelDeskAccount` satisfies it structurally. */
export interface ControlAccountPort {
  state(): Promise<EnterpriseView>
  saveBaseUrl(raw: string): Promise<EnterpriseView>
  startLogin(): Promise<{ readonly authorizeUrl: string; readonly expiresAt: string }>
}

/** Running server. */
export interface ControlServer {
  readonly port: number
  readonly token: string
  readonly file: string
  close(): Promise<void>
}

/** Options for {@link startControlServer}. */
export interface ControlServerOptions {
  readonly account: ControlAccountPort
  /** Explicit harness home; default follows `DSH_HOME`, then `~/.dsh`. */
  readonly home?: string
}

const MAX_BODY_BYTES = 4 * 1024
/**
 * Relative path to the local desktop control handshake.
 */
export const CONTROL_FILE = 'control.json'

/** Handshake payload published for the shell. */
interface ControlFile {
  readonly version: 1
  readonly port: number
  readonly token: string
  readonly pid: number
  readonly startedAt: string
}

/** Whether the peer is this machine. */
function isLoopbackPeer(request: IncomingMessage): boolean {
  const address = request.socket.remoteAddress ?? ''
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

/** Compare two tokens without leaking length-independent timing. */
function sameToken(given: string | undefined, expected: string): boolean {
  if (given === undefined || !/^[A-Za-z0-9_-]{43}$/.test(given)) return false
  return timingSafeEqual(Buffer.from(given), Buffer.from(expected))
}

/** Send one JSON response. */
function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  response.end(JSON.stringify(body))
}

/** Send one typed failure. */
function fail(response: ServerResponse, status: number, code: string, message: string): void {
  json(response, status, { error: { code, message } })
}

/** Read a capped JSON body; `undefined` means rejected (the response is already sent). */
async function readJson(request: IncomingMessage, response: ServerResponse): Promise<unknown> {
  const type = request.headers['content-type'] ?? ''
  if (type.split(';')[0]?.trim().toLowerCase() !== 'application/json') { fail(response, 415, 'unsupported_media_type', '需要 application/json'); return undefined }
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > MAX_BODY_BYTES) {
      response.setHeader('connection', 'close')
      fail(response, 413, 'body_too_large', '请求体过大')
      return undefined
    }
    chunks.push(buffer)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  } catch {
    fail(response, 400, 'invalid_json', '请求体不是合法 JSON')
    return undefined
  }
}

/**
 * Bind the control endpoint and publish `control.json`.
 * @param options - the account port and an optional home override.
 * @returns The bound loopback server and its cleanup handle.
 */
export async function startControlServer(options: ControlServerOptions): Promise<ControlServer> {
  const token = randomBytes(32).toString('base64url')
  const directory = join(resolveDshHome(options.home), 'modeldesk')
  const file = join(directory, CONTROL_FILE)

  let loginStarting = false
  let closing: Promise<void> | undefined
  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    if (!isLoopbackPeer(request)) { fail(response, 403, 'forbidden', '只接受本机请求'); return }
    if (!sameToken(typeof request.headers['x-modeldesk-token'] === 'string' ? request.headers['x-modeldesk-token'] : undefined, token)) {
      fail(response, 401, 'unauthorized', '握手指令缺失或错误')
      return
    }
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (url.pathname === '/status') {
      if (request.method !== 'GET') { fail(response, 405, 'method_not_allowed', '只接受 GET'); return }
      try {
        json(response, 200, { service: 'modeldesk-control', version: 1, state: await options.account.state() })
      } catch {
        fail(response, 500, 'internal_error', '状态读取失败')
      }
      return
    }
    if (url.pathname === '/login') {
      if (request.method !== 'POST') { fail(response, 405, 'method_not_allowed', '只接受 POST'); return }
      const body = await readJson(request, response)
      if (body === undefined) return
      const target = typeof body === 'object' && body !== null && !Array.isArray(body)
        && Object.keys(body).length === 1 && 'server' in body ? body.server : undefined
      if (typeof target !== 'string' || target.length === 0) {
        fail(response, 400, 'invalid_request', '登录请求只能包含 server')
        return
      }
      if (loginStarting) {
        fail(response, 409, 'login_in_flight', '已有登录正在进行')
        return
      }
      loginStarting = true
      try {
        const baseUrl = normalizeBaseUrl(target)
        if ((await options.account.state()).phase === 'signing-in') {
          fail(response, 409, 'login_in_flight', '已有登录正在进行')
          return
        }
        // The desktop shell confirms the target before invoking this endpoint.
        if (closing !== undefined) return
        await options.account.saveBaseUrl(baseUrl)
        if (closing !== undefined) return
        json(response, 200, await options.account.startLogin())
      } catch (error) {
        if (error instanceof ModelDeskApiError) {
          fail(response, error.code === 'login_in_flight' ? 409 : 400, error.code, error.message)
        } else {
          fail(response, 500, 'login_failed', '登录启动失败')
        }
      } finally {
        loginStarting = false
      }
      return
    }
    fail(response, 404, 'not_found', '未知路径')
  }

  const server = createServer({
    headersTimeout: 5_000, requestTimeout: 5_000, connectionsCheckingInterval: 1_000,
  }, (request, response) => {
    void handle(request, response).catch(() => {
      if (!response.headersSent && !response.destroyed) {
        fail(response, 400, 'invalid_request', '请求无法读取')
      }
    })
  })
  server.unref()

  const stop = (): Promise<void> => new Promise((resolve) => {
    server.close(() => { resolve() })
    server.closeAllConnections()
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { resolve() })
  })
  const address = server.address()
  if (address === null || typeof address === 'string') {
    server.close()
    throw new Error('control-server: no port assigned')
  }

  const published: ControlFile = { version: 1, port: address.port, token, pid: process.pid, startedAt: new Date().toISOString() }
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 })
    await withFileLock(file, () => writeFileAtomic(file, JSON.stringify(published) + '\n', { mode: 0o600 }))
  } catch (error) {
    await stop()
    throw error
  }

  async function close(): Promise<void> {
    await stop()
    await withFileLock(file, async () => {
      try {
        const current = JSON.parse(await readFile(file, 'utf8')) as Partial<ControlFile>
        if (current.token === token) await unlink(file)
      } catch {
        // The handshake may have been removed already.
      }
    })
  }
  return {
    port: address.port,
    token,
    file,
    close: () => closing ??= close(),
  }
}

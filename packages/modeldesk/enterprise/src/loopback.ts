/**
 * One-shot loopback listener for the browser callback. It lives for exactly
 * one attempt: bound to 127.0.0.1 on an ephemeral port, serving only
 * `GET /modeldesk/callback`, and closed as soon as the attempt settles.
 * @module @modeldesk/dsh-enterprise/loopback
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'

/** The only browser-side failures the client names; anything else is `authorization_failed`. */
export type LoginErrorCode = 'access_denied' | 'authorization_expired' | 'authorization_failed'

/** What the callback delivered. */
export type LoopbackOutcome =
  | { readonly kind: 'ticket'; readonly ticket: string }
  | { readonly kind: 'error'; readonly error: LoginErrorCode }

/** A live listener. */
export interface Loopback {
  readonly redirectUri: string
  readonly result: Promise<LoopbackOutcome>
  close(): Promise<void>
}

const CALLBACK_PATH = '/modeldesk/callback'
const ALLOWED_PARAMS = new Set(['auth_id', 'state', 'identity_ticket', 'error'])
const KNOWN_ERRORS = new Set<string>(['access_denied', 'authorization_expired', 'authorization_failed'])
const TICKET_PATTERN = /^[A-Za-z0-9._~-]{16,512}$/

/** Read exactly one value for a query parameter, rejecting duplicates. */
function single(params: URLSearchParams, name: string): string | undefined {
  const values = params.getAll(name)
  if (values.length > 1) throw new Error(`duplicate ${name}`)
  return values[0]
}

/** Whether the peer is this machine. */
function isLoopbackPeer(request: IncomingMessage): boolean {
  const address = request.socket.remoteAddress ?? ''
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

/** A page with no dynamic content: nothing from the query is ever echoed. */
function page(response: ServerResponse, status: number, title: string, body: string): void {
  response.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' })
  response.end(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${title}</title></head><body><h1>${title}</h1><p>${body}</p></body></html>`)
}

/**
 * Bind the callback listener.
 * @param expectation - transaction id and state this attempt created. The
 *   object is read at callback time, so the caller fills in `authId` after
 *   `POST /authorizations`; an empty id rejects every callback.
 * @returns The bound callback endpoint and its cleanup handle.
 */
export async function openLoopback(expectation: { authId: string; state: string }): Promise<Loopback> {
  let settle: (outcome: LoopbackOutcome) => void = () => {}
  let fail: (error: Error) => void = () => {}
  const result = new Promise<LoopbackOutcome>((resolve, reject) => { settle = resolve; fail = reject })
  void result.catch(() => {})
  let closed = false
  let closing: Promise<void> | undefined
  const stop = () => closing ??= new Promise<void>((resolve) => { server.close(() => { resolve() }) })

  const server = createServer((request, response) => {
    if (closed) { page(response, 410, '授权已结束', '请回到ModelDesk Harness重试。'); return }
    if (!isLoopbackPeer(request)) { page(response, 403, '拒绝访问', '只接受本机回调。'); return }
    if (request.method !== 'GET') { page(response, 405, '拒绝访问', '只接受 GET。'); return }
    let url: URL
    try {
      url = new URL(request.url ?? '/', 'http://127.0.0.1')
    } catch {
      page(response, 400, '授权未完成', '回调地址不正确。')
      return
    }
    if (url.pathname !== CALLBACK_PATH) { page(response, 404, '未找到', '回调地址不正确。'); return }
    let outcome: LoopbackOutcome
    try {
      for (const key of url.searchParams.keys()) {
        if (!ALLOWED_PARAMS.has(key)) throw new Error(`unexpected ${key}`)
      }
      const authId = single(url.searchParams, 'auth_id')
      const state = single(url.searchParams, 'state')
      const ticket = single(url.searchParams, 'identity_ticket')
      const error = single(url.searchParams, 'error')
      if (expectation.authId.length === 0 || authId !== expectation.authId || state !== expectation.state) {
        throw new Error('state mismatch')
      }
      if (ticket !== undefined && error !== undefined) throw new Error('ticket and error together')
      if (error !== undefined) {
        outcome = { kind: 'error', error: KNOWN_ERRORS.has(error) ? error as LoginErrorCode : 'authorization_failed' }
      } else if (ticket !== undefined && TICKET_PATTERN.test(ticket)) {
        outcome = { kind: 'ticket', ticket }
      } else {
        throw new Error('missing ticket')
      }
    } catch {
      page(response, 400, '授权未完成', '回调参数不正确，请回到ModelDesk Harness重试。')
      return
    }
    closed = true
    page(response, 200, outcome.kind === 'ticket' ? '授权完成' : '授权未完成', '可以关闭此窗口，回到ModelDesk Harness继续。')
    response.once('finish', () => {
      settle(outcome)
      void stop()
    })
  })

  const bound = new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { resolve() })
  })
  await bound
  const address = server.address()
  if (address === null || typeof address === 'string') {
    server.close()
    throw new Error('loopback: no port assigned')
  }

  return {
    redirectUri: `http://127.0.0.1:${address.port}${CALLBACK_PATH}`,
    result,
    async close(): Promise<void> {
      if (!closed) {
        closed = true
        fail(new Error('loopback closed'))
      }
      const done = stop()
      server.closeAllConnections()
      await done
    },
  }
}

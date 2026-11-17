/**
 * One sign-in transaction at a time. The browser callback and a pasted
 * ticket race; whichever arrives first consumes the attempt, and the losing
 * leg is closed so the ticket is exchanged exactly once.
 * @module @modeldesk/dsh-enterprise/login-flow
 */
import { hostname } from 'node:os'
import { CLIENT_ID, CONTRACT_VERSION, ModelDeskApiError, validateAuthorizeUrl } from './platform.ts'
import { challengeFor, createState, createVerifier } from './pkce.ts'
import { openLoopback, type LoginErrorCode, type Loopback, type LoopbackOutcome } from './loopback.ts'
import { openBrowser } from './open-browser.ts'
import type { ModelDeskSession } from './session.ts'

/** How long the listener outlives the transaction, for the ticket TTL. */
const TICKET_GRACE_MS = 60_000
/** Pasted ticket grammar; the same shape the callback enforces. */
const TICKET_PATTERN = /^[A-Za-z0-9._~-]{16,512}$/

/** Visible state while waiting. */
export interface LoginWaiting {
  readonly authorizeUrl: string
  readonly expiresAt: number
}

/** What `start` reports to the caller that will display the URL. */
export interface LoginStarted extends LoginWaiting {
  readonly redirectUri: string
}

/** Callbacks the owning service supplies. */
export interface LoginFlowOptions {
  readonly openBrowser?: (url: string) => Promise<void>
  readonly deviceName?: () => string
  readonly clientVersion?: string
  readonly clock?: () => number
  readonly onChange?: () => void
}

interface Deferred<T> {
  readonly promise: Promise<T>
  resolve(value: T): void
  reject(error: Error): void
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => {}
  let reject: (error: Error) => void = () => {}
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  promise.catch(() => {})
  return { promise, resolve, reject }
}

const LOGIN_ERROR_TEXT: Readonly<Record<LoginErrorCode, string>> = {
  access_denied: '你在浏览器里取消了授权',
  authorization_expired: '授权已过期，请重新发起',
  authorization_failed: '授权未能完成，请重试',
}

function describeLoginError(code: LoginErrorCode): string {
  return LOGIN_ERROR_TEXT[code]
}

function toFailure(error: unknown): ModelDeskApiError {
  if (error instanceof ModelDeskApiError) return error
  return new ModelDeskApiError('登录失败，请重试', 'login_failed')
}

interface Attempt {
  readonly baseUrl: string
  readonly authId: string
  readonly verifier: string
  readonly loopback: Loopback
  readonly paste: Deferred<LoopbackOutcome>
  readonly expiresAt: number
  /** True once a leg has won (or the attempt was cancelled): a second exchange is forbidden. */
  settled: boolean
  /** True once the listener and timer have been released. */
  disposed: boolean
  /** True when the employee cancelled; such an end is not reported as a failure. */
  cancelled: boolean
  timer: ReturnType<typeof setTimeout> | undefined
}

/** Sign-in transaction machine. */
export class LoginFlow {
  private starting: AbortController | undefined
  private attempt: Attempt | undefined
  private waiting: LoginWaiting | undefined
  private lastError: ModelDeskApiError | undefined
  private readonly open: (url: string) => Promise<void>
  private readonly device: () => string
  private readonly version: string
  private readonly clock: () => number
  private readonly onChange: () => void

  constructor(private readonly session: ModelDeskSession, options: LoginFlowOptions = {}) {
    this.open = options.openBrowser ?? openBrowser
    this.device = options.deviceName ?? (() => hostname().slice(0, 64))
    this.version = options.clientVersion ?? '0.2.2'
    this.clock = options.clock ?? (() => Date.now())
    this.onChange = options.onChange ?? (() => {})
  }

  /**
   * Current waiting state, or `undefined` when idle.
   * @returns The pending login attempt, when one is active.
   */
  current(): LoginWaiting | undefined {
    return this.waiting
  }

  /**
   * Why the last attempt failed; cleared by {@link start} and {@link cancel}.
   * @returns The last login error, when available.
   */
  failure(): ModelDeskApiError | undefined {
    return this.lastError
  }

  /**
   * Begin a transaction. The listener binds first so the callback address
   * carries its real ephemeral port; the authorization is created second,
   * and only from then on can a callback validate against the transaction id.
   * @param baseUrl - saved, normalized platform origin.
   * @returns the URL the employee must open, plus the callback address.
   */
  async start(baseUrl: string): Promise<LoginStarted> {
    if (this.attempt !== undefined || this.starting !== undefined) {
      throw new ModelDeskApiError('已有登录正在进行', 'login_in_flight', { status: 409 })
    }
    const startup = new AbortController()
    this.starting = startup
    try {
      return await this.#start(baseUrl, startup.signal)
    } finally {
      if (this.starting === startup) this.starting = undefined
    }
  }

  async #start(baseUrl: string, signal: AbortSignal): Promise<LoginStarted> {
    this.lastError = undefined
    const platform = this.session.platform(baseUrl)
    const config = await platform.config()
    signal.throwIfAborted()
    if (!config.enabled) throw new ModelDeskApiError('本平台未启用ModelDesk Harness接入', 'contract_unsupported')
    if (config.client_id !== CLIENT_ID || config.contract_version !== CONTRACT_VERSION) {
      throw new ModelDeskApiError('平台契约版本与客户端不一致', 'contract_mismatch')
    }

    const verifier = createVerifier()
    // `authId` is filled in after `POST /authorizations`; a callback that
    // arrives before that is rejected because the id is still empty, and no
    // browser has the authorize URL yet.
    const expectation = { authId: '', state: createState() }
    const loopback = await openLoopback(expectation)
    const closeOnCancel = () => { void loopback.close().catch(() => {}) }
    signal.addEventListener('abort', closeOnCancel, { once: true })
    try {
      signal.throwIfAborted()
      const created = await platform.createAuthorization({
        client_id: CLIENT_ID,
        redirect_uri: loopback.redirectUri,
        code_challenge: challengeFor(verifier),
        code_challenge_method: 'S256',
        state: expectation.state,
        device_name: this.device(),
        client_version: this.version,
      })
      signal.throwIfAborted()
      expectation.authId = created.auth_id

      const authorizeUrl = validateAuthorizeUrl(baseUrl, created.authorize_url, created.auth_id)
      const expiresAt = this.clock() + Math.min(created.expires_in, 300) * 1000
      const attempt: Attempt = {
        baseUrl,
        authId: created.auth_id,
        verifier,
        loopback,
        paste: deferred<LoopbackOutcome>(),
        expiresAt,
        settled: false,
        disposed: false,
        cancelled: false,
        timer: undefined,
      }
      attempt.timer = setTimeout(() => {
        attempt.paste.reject(new ModelDeskApiError('授权超时，请重试', 'authorization_expired'))
      }, Math.max(1_000, expiresAt + TICKET_GRACE_MS - this.clock()))
      this.attempt = attempt
      this.waiting = { authorizeUrl, expiresAt }
      this.onChange()
      void this.open(authorizeUrl).catch(() => {})
      void this.#run(attempt)
      return { authorizeUrl, redirectUri: loopback.redirectUri, expiresAt }
    } catch (error) {
      await loopback.close().catch(() => {})
      throw error
    } finally {
      signal.removeEventListener('abort', closeOnCancel)
    }
  }

  /**
   * Paste a ticket when the browser callback cannot reach this machine.
   * @param raw - Unvalidated input supplied by the caller.
   */
  submitTicket(raw: string): void {
    const ticket = raw.trim()
    if (!TICKET_PATTERN.test(ticket)) throw new ModelDeskApiError('票据格式不正确', 'invalid_ticket')
    const attempt = this.attempt
    if (attempt === undefined || attempt.settled) throw new ModelDeskApiError('当前没有进行中的登录', 'login_idle', { status: 409 })
    attempt.paste.resolve({ kind: 'ticket', ticket })
  }

  /** Abort the attempt; a cancellation is not reported as a failure. */
  async cancel(): Promise<void> {
    this.starting?.abort(new ModelDeskApiError('登录已取消', 'login_cancelled'))
    this.starting = undefined
    const attempt = this.attempt
    this.lastError = undefined
    if (attempt === undefined) return
    attempt.cancelled = true
    await this.#release(attempt)
    if (this.attempt === attempt) {
      this.attempt = undefined
      this.waiting = undefined
    }
    this.onChange()
  }

  /** Close anything still open; called when the plugin unloads. */
  async dispose(): Promise<void> {
    await this.cancel()
  }

  /** Race the callback, a pasted ticket, and the transaction deadline. */
  async #run(attempt: Attempt): Promise<void> {
    try {
      const outcome = await Promise.race([attempt.loopback.result, attempt.paste.promise])
      if (attempt.settled) return
      attempt.settled = true
      if (this.clock() >= attempt.expiresAt + TICKET_GRACE_MS) {
        throw new ModelDeskApiError('授权超时，请重试', 'authorization_expired')
      }
      if (outcome.kind === 'error') throw new ModelDeskApiError(describeLoginError(outcome.error), outcome.error)
      const wire = await this.session.platform(attempt.baseUrl).exchangeTicket({
        authId: attempt.authId,
        identityTicket: outcome.ticket,
        codeVerifier: attempt.verifier,
      })
      if (attempt.cancelled) return
      await this.session.acceptSignedIn(attempt.baseUrl, wire, () => !attempt.cancelled)
    } catch (error) {
      if (!attempt.cancelled) this.lastError = toFailure(error)
    } finally {
      await this.#release(attempt)
      if (this.attempt === attempt) {
        this.attempt = undefined
        this.waiting = undefined
      }
      this.onChange()
    }
  }

  /** Release the listener and timer exactly once, rejecting the losing leg. */
  async #release(attempt: Attempt): Promise<void> {
    if (attempt.disposed) return
    attempt.disposed = true
    attempt.settled = true
    if (attempt.timer !== undefined) clearTimeout(attempt.timer)
    attempt.paste.reject(new Error('attempt closed'))
    await attempt.loopback.close().catch(() => {})
  }
}

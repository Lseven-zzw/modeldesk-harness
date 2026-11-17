/**
 * Host half of the enterprise plugin: owns the session and exposes it to the
 * LLM adapter and (from B4 on) to the settings Remote.
 * @module @modeldesk/dsh-enterprise
 */
import { Context, Service } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-credentials'
import { MODELDESK_PROVIDER, ModelDeskAdapter } from './adapter.ts'
import { startControlServer, type ControlServer } from './control-server.ts'
import { SESSION_KEY } from './credentials.ts'
import { ModelDeskApiError, normalizeBaseUrl } from './platform.ts'
import { LoginFlow } from './login-flow.ts'
import { EnterpriseController } from './remote.ts'
import { ModelDeskSession } from './session.ts'
import { EnterpriseSkillSync } from './skill-sync.ts'
import { registerDocumentTools } from './document-tools.ts'
import { registerMcpTools, type EnterpriseMcpToolSync } from './mcp-tools.ts'
import type { EnterpriseView, ModelDeskCapabilities, ModelDeskModel, ModelDeskUsage } from './types.ts'

export type * from './types.ts'
export { ModelDeskApiError, normalizeBaseUrl } from './platform.ts'
export { SESSION_KEY } from './credentials.ts'

/** The enterprise service consumed as `ctx.modeldeskAccount`. */
export class ModelDeskAccount extends Service {
  static inject = ['credentials']
  private control: ControlServer | undefined
  private disposed = false
  private readonly login: LoginFlow
  private readonly session: ModelDeskSession
  private readonly skillSync: EnterpriseSkillSync | undefined
  private mcpSync: EnterpriseMcpToolSync | undefined
  private readonly listeners = new Set<(view: EnterpriseView) => void>()

  constructor(ctx: Context) {
    super(ctx, 'modeldeskAccount')
    this.session = new ModelDeskSession(ctx.credentials, { onChange: () => {
      void this.#publish()
      this.#refreshSkills()
      void this.mcpSync?.refresh()
    } })
    ctx.inject(['tools'], (scope) => {
      registerDocumentTools(scope, this.session)
      this.mcpSync = registerMcpTools(scope, this.session)
    })
    // Sign-in/out committed by another process (or a fixture) must reach the
    // tool catalogs too; session-owned writes already refresh via onChange,
    // and reload() reports no change for them.
    ctx.effect(() => ctx.on('credentials/record-updated', (key) => {
      if (key !== SESSION_KEY) return
      void this.session.reload().then((changed) => {
        if (this.disposed || !changed) return
        void this.#publish()
        this.#refreshSkills()
        void this.mcpSync?.refresh()
      }).catch((error: unknown) => {
        this.ctx.logger.warn('Enterprise session reload failed: %s', error instanceof Error ? error.message : String(error))
      })
    }), 'modeldesk: session record watch')
    const skillDirectory = process.env.MODELDESK_ENTERPRISE_SKILL_DIR
    this.skillSync = skillDirectory ? new EnterpriseSkillSync(
      skillDirectory, () => this.session.skills(), skill => this.session.skillFiles(skill.code, skill.revision),
    ) : undefined
    this.login = new LoginFlow(this.session, { onChange: () => { void this.#publish() } })
    ctx.effect(() => () => {
      this.disposed = true
      void this.control?.close().catch(() => {})
      void this.login.dispose()
      this.listeners.clear()
    }, 'modeldesk: account listeners')
    if (this.skillSync !== undefined) ctx.effect(() => {
      const timer = setInterval(() => { this.#refreshSkills() }, 30_000)
      timer.unref()
      return async () => {
        clearInterval(timer)
        await this.skillSync?.close()
      }
    }, 'modeldesk: enterprise skill synchronization')
  }

  async [Service.init](): Promise<void> {
    await this.session.load()
    if (this.disposed) return
    this.#refreshSkills()
    try {
      const control = await startControlServer({ account: this })
      if (this.disposed) await control.close()
      else this.control = control
    } catch (error) {
      this.ctx.logger?.warn?.('ModelDesk control endpoint failed: %s', error instanceof Error ? error.message : String(error))
    }
  }

  /**
   * Read-only snapshot for the settings page.
   * @returns The current account view without tokens.
   */
  async state(): Promise<EnterpriseView> {
    const record = await this.session.record()
    const signed = await this.session.signedIn()
    const waiting = this.login.current()
    const failed = this.login.failure()
    return {
      baseUrl: record?.baseUrl ?? null,
      phase: waiting !== undefined
        ? 'signing-in'
        : signed !== undefined ? 'signed-in' : record === undefined ? 'unconfigured' : 'signed-out',
      user: signed?.user ?? null,
      org: signed?.org ?? null,
      sessionExpiresAt: signed === undefined ? null : new Date(signed.absoluteExpiresAt).toISOString(),
      models: signed?.models ?? [],
      login: waiting === undefined ? null : { authorizeUrl: waiting.authorizeUrl, expiresAt: new Date(waiting.expiresAt).toISOString() },
      ...(failed === undefined ? {} : { error: { code: failed.code, message: failed.message } }),
    }
  }

  /**
   * Save the platform address. Changing it signs out.
   * @param raw - address typed by the employee.
   * @returns The current account view without tokens.
   */
  async saveBaseUrl(raw: string): Promise<EnterpriseView> {
    const baseUrl = normalizeBaseUrl(raw)
    if (baseUrl !== await this.session.baseUrl()) await this.login.cancel()
    await this.session.setBaseUrl(baseUrl)
    await this.skillSync?.refresh()
    return this.state()
  }

  /**
   * Subscribe to state changes; the returned function unsubscribes.
   * @param listener - Receives account updates while subscribed.
   * @returns A function that removes the listener.
   */
  subscribe(listener: (view: EnterpriseView) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /**
   * A usable access token; throws `signed_out`/`session_expired`.
   * @returns A usable access token for the current session.
   */
  async accessToken(): Promise<string> {
    return this.session.accessToken()
  }

  /**
   * Recover from a 401 on `usedToken`.
   * @param usedToken - Token rejected by the previous upstream request.
   * @returns A usable access token after session recovery.
   */
  async recover(usedToken: string): Promise<string> {
    return this.session.recover(usedToken)
  }

  /**
   * Authorized models, optionally bypassing the cache.
   * @param force - Fetch a fresh catalog even when a cached catalog exists.
   * @returns The authorized model catalog.
   */
  async models(force: boolean = false): Promise<readonly ModelDeskModel[]> {
    return this.session.models(force)
  }

  /**
   * Open a model response using the signed-in employee's session.
   * @param body - Request or response body for the model gateway.
   * @param signal - Cancels the outbound request or stream.
   * @returns The response body received from the model gateway.
   */
  async complete(body: Record<string, unknown>, signal?: AbortSignal): Promise<ReadableStream<Uint8Array<ArrayBuffer>>> {
    return this.session.complete(body, signal)
  }

  /** Library operations backed by the active employee session. */
  get library(): Pick<ModelDeskSession, 'searchDocuments' | 'readDocument' | 'uploadPersonalFile' | 'deletePersonalDocument' | 'downloadDocument'> {
    return this.session
  }

  /**
   * Read the published capabilities for the current enterprise account.
   * @returns Authorized skills and MCP services for the current employee.
   */
  async capabilities(): Promise<ModelDeskCapabilities> {
    const account = await this.session.signedIn()
    if (account === undefined) return { signedIn: false, skills: [], mcp: [] }
    const [skills, mcp] = await Promise.all([this.session.skills(), this.session.mcpServers()])
    const current = await this.session.signedIn()
    if (current?.baseUrl !== account.baseUrl || current.sessionId !== account.sessionId) {
      return { signedIn: false, skills: [], mcp: [] }
    }
    return {
      signedIn: true,
      skills: skills.map(({ code, revision, description }) => ({ code, revision, description: description ?? '' })),
      mcp: mcp.map(({ id, name, description, guide, tools }) => ({
        id, name, description, guide,
        tools: tools.map(({ name, description, access }) => ({ name, description, access })),
      })),
    }
  }

  /**
   * This month's usage.
   * @returns Usage and quota for the current billing month.
   */
  async usage(): Promise<ModelDeskUsage> {
    return this.session.usage()
  }

  /**
   * Begin sign-in against the saved platform address.
   * @returns The browser authorization URL and its expiration.
   */
  async startLogin(): Promise<{ authorizeUrl: string; expiresAt: string }> {
    const baseUrl = await this.session.baseUrl()
    if (baseUrl === undefined || baseUrl.length === 0) throw new ModelDeskApiError('请先保存平台地址', 'unconfigured')
    const started = await this.login.start(baseUrl)
    return { authorizeUrl: started.authorizeUrl, expiresAt: new Date(started.expiresAt).toISOString() }
  }

  /**
   * Paste a ticket delivered out of band.
   * @param ticket - One-time authorization code copied from the browser.
   * @returns The current account view without tokens.
   */
  async submitTicket(ticket: string): Promise<EnterpriseView> {
    this.login.submitTicket(ticket)
    return this.state()
  }

  /**
   * Abort the waiting attempt.
   * @returns The current account view without tokens.
   */
  async cancelLogin(): Promise<EnterpriseView> {
    await this.login.cancel()
    return this.state()
  }

  /**
   * Sign out; keeps the platform address.
   * @returns The current account view without tokens.
   */
  async logout(): Promise<EnterpriseView> {
    await this.login.cancel()
    await this.session.logout()
    await this.skillSync?.refresh()
    return this.state()
  }

  async #publish(): Promise<void> {
    if (this.listeners.size === 0) return
    const view = await this.state()
    for (const listener of this.listeners) listener(view)
  }

  #refreshSkills(): void {
    void this.skillSync?.refresh().catch((error: unknown) => {
      this.ctx.logger.warn('Enterprise skill cache update failed: %s', error instanceof Error ? error.message : String(error))
    })
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    modeldeskAccount: ModelDeskAccount
  }
}

export { EnterpriseController }

/**
 * Package plugin: the account service and its Remote controller. The Loader
 * mounts one entry per package, so both classes are instantiated here; the
 * generated `./typert` manifest is discovered by `typert-loader` from the
 * same package.
 * @param ctx - Host context.
 */
export default function modeldeskEnterprise(ctx: Context): void {
  ctx.plugin(ModelDeskAccount)
  ctx.plugin(EnterpriseController)
  ctx.inject(['modeldeskAccount', 'llm'], (scope) => {
    const account = scope.modeldeskAccount
    scope.llm.registerAdapter([MODELDESK_PROVIDER], new ModelDeskAdapter(account))
    let catalog = ''
    scope.effect(() => account.subscribe((view) => {
      const next = JSON.stringify([view.baseUrl, view.user?.id, view.models])
      if (catalog === next) return
      catalog = next
      scope.emit('llm/models-updated', MODELDESK_PROVIDER)
    }), 'modeldesk: model catalog updates')
  })
}

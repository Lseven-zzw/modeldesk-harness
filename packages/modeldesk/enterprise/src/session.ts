import type { DocumentLibrary, LibraryDocument, LibraryDocumentText, LibraryPage, ModelDeskMcpCallResult } from './types.ts'
/**
 * Session state for the whole plugin: one in-memory copy of the stored
 * record, one single-flight refresh (two concurrent rotations would let the
 * platform revoke the token family), and the catalog/usage reads that the
 * settings page and the LLM adapter share.
 * @module @modeldesk/dsh-enterprise/session
 */
import type { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import { isSignedIn, parseRecord, SESSION_KEY, toRecord, withModels } from './credentials.ts'
import { ModelDeskApiError, ModelDeskPlatform, toSignedIn, type PlatformOptions } from './platform.ts'
import type { ModelDeskMcpServer, ModelDeskModel, ModelDeskRecord, ModelDeskSignedIn, ModelDeskUsage } from './types.ts'

/** Refresh this long before the access token expires. */
const ACCESS_SKEW_MS = 30_000
/** Catalog cache lifetime. */
const CATALOG_TTL_MS = 5 * 60_000
const TERMINAL_REFRESH_ERRORS = new Set([
  'invalid_refresh_token', 'refresh_token_reused', 'session_revoked', 'session_expired', 'user_disabled',
])

/** Callbacks the owning service supplies. */
export interface SessionOptions extends PlatformOptions {
  readonly clock?: () => number
  readonly onChange?: () => void
}

/** One session, owned by `ModelDeskAccount`. */
export class ModelDeskSession {
  private cached: ModelDeskRecord | undefined
  private replacedAccessToken: string | undefined
  private refreshing: Promise<ModelDeskSignedIn> | undefined
  private readonly clock: () => number
  private readonly onChange: () => void

  constructor(private readonly credentials: CredentialProvider, private readonly options: SessionOptions = {}) {
    this.clock = options.clock ?? (() => Date.now())
    this.onChange = options.onChange ?? (() => {})
  }

  /**
   * Read the record once and cache it.
   * @returns The stored account record, if present.
   */
  async load(): Promise<ModelDeskRecord | undefined> {
    this.cached = parseRecord(await this.credentials.readRecord(SESSION_KEY))
    return this.cached
  }

  /**
   * Current record, loading it on first use.
   * @returns The stored account record, if present.
   */
  async record(): Promise<ModelDeskRecord | undefined> {
    return this.cached ?? await this.load()
  }

  /**
   * Re-read the stored record after an external change; true when it changed.
   * @returns Whether the stored account state changed.
   */
  async reload(): Promise<boolean> {
    const previous = this.cached
    const next = await this.load()
    return JSON.stringify(previous) !== JSON.stringify(next)
  }

  /**
   * Signed-in record, or `undefined`.
   * @returns The current authenticated record, if present.
   */
  async signedIn(): Promise<ModelDeskSignedIn | undefined> {
    const record = await this.record()
    return isSignedIn(record) ? record : undefined
  }

  /**
   * Saved platform origin, or `undefined` before the first save.
   * @returns The configured server origin, if present.
   */
  async baseUrl(): Promise<string | undefined> {
    return (await this.record())?.baseUrl
  }

  /**
   * A platform client for one origin, sharing this session's transport options.
   * @param baseUrl - Origin of the ModelDesk server.
   * @returns A client bound to the selected server origin.
   */
  platform(baseUrl: string): ModelDeskPlatform {
    return new ModelDeskPlatform(baseUrl, this.options)
  }

  /**
   * Save a new origin. Changing the origin signs out: the old tokens are
   * meaningless on another platform and must not be replayed there.
   * @param baseUrl - already normalized origin.
   */
  async setBaseUrl(baseUrl: string): Promise<void> {
    const current = await this.record()
    if (current?.baseUrl === baseUrl) return
    await this.#write({ version: 1, baseUrl })
  }

  /**
   * Read the current access token, refreshing when it is close to expiry.
   * @returns a token the caller may use for exactly one request.
   */
  async accessToken(): Promise<string> {
    const signed = await this.#requireSignedIn()
    if (signed.absoluteExpiresAt <= this.clock()) {
      throw new ModelDeskApiError('登录已过期，请重新登录', 'session_expired', { status: 401 })
    }
    if (signed.accessExpiresAt - ACCESS_SKEW_MS > this.clock()) return signed.accessToken
    return (await this.refresh()).accessToken
  }

  /**
   * Recover from a 401. When another caller or process already replaced the
   * rejected token, its replacement is returned without a second refresh.
   * @param usedToken - the token the failed request carried.
   * @returns A usable access token after session recovery.
   */
  async recover(usedToken: string): Promise<string> {
    const signed = await this.signedIn()
    if (signed === undefined) throw new ModelDeskApiError('尚未登录', 'signed_out', { status: 401 })
    if (signed.accessToken !== usedToken) {
      if (usedToken !== this.replacedAccessToken) throw signedOut()
      return signed.accessToken
    }
    return (await this.refresh()).accessToken
  }

  /**
   * Single-flight refresh; concurrent callers share one rotation.
   * @returns The authenticated employee record.
   */
  async refresh(): Promise<ModelDeskSignedIn> {
    if (this.refreshing !== undefined) return this.refreshing
    this.refreshing = this.#refreshOnce().finally(() => { this.refreshing = undefined })
    return this.refreshing
  }

  /**
   * Authorized models, cached for {@link CATALOG_TTL_MS}.
   * @param force - Fetch a fresh catalog even when a cached catalog exists.
   * @returns The authorized model catalog.
   */
  async models(force: boolean = false): Promise<readonly ModelDeskModel[]> {
    const signed = await this.#requireSignedIn()
    if (signed.absoluteExpiresAt <= this.clock()) {
      throw new ModelDeskApiError('登录已过期，请重新登录', 'session_expired', { status: 401 })
    }
    if (!force && signed.modelsFetchedAt > 0 && this.clock() - signed.modelsFetchedAt < CATALOG_TTL_MS) return signed.models
    const list = await this.#withAccess(signed, token => this.platform(signed.baseUrl).fetchModels(token))
    return this.#replaceModels(signed, list)
  }

  /**
   * Authorized Skill snapshot for the currently signed-in account.
   * @returns The ReturnType<ModelDeskPlatform['fetchSkills']> result.
   */
  async skills(): ReturnType<ModelDeskPlatform['fetchSkills']> {
    const signed = await this.signedIn()
    if (signed === undefined) return []
    const skills = await this.#withAccess(signed, token => this.platform(signed.baseUrl).fetchSkills(token))
    await this.#requireCurrent(signed)
    return skills
  }

  /**
   * Read skill attachments under the current employee session.
   * @param code - Stable slug of the published skill.
   * @param revision - Expected document or skill revision.
   * @returns The file bundle for the requested skill revision.
   */
  async skillFiles(code: string, revision: number): ReturnType<ModelDeskPlatform['fetchSkillFiles']> {
    const signed = await this.#requireSignedIn()
    const files = await this.#withAccess(signed, token => this.platform(signed.baseUrl).fetchSkillFiles(token, code, revision))
    await this.#requireCurrent(signed)
    return files
  }

  /**
   * Search the selected library using the employee's current access.
   * @param query - Search terms entered by the employee.
   * @param before - Upper document ID bound for loading the next page.
   * @param signal - Cancels the outbound request or stream.
   * @param library - Selects the personal or enterprise library.
   * @returns One page of matching documents and its pagination cursor.
   */
  async searchDocuments(query: string, before: number | undefined, signal: AbortSignal, library: DocumentLibrary = 'enterprise'): Promise<LibraryPage> {
    const signed = await this.#requireSignedIn()
    const result = await this.#withAccess(signed,
      token => this.platform(signed.baseUrl).searchDocuments(token, query, before, signal, library), signal)
    await this.#requireCurrent(signed)
    signal.throwIfAborted()
    return result
  }

  /**
   * Read the document and check its revision when supplied.
   * @param id - Identifier of the requested resource.
   * @param signal - Cancels the outbound request or stream.
   * @param library - Selects the personal or enterprise library.
   * @param revision - Expected document or skill revision.
   * @returns Document metadata and extracted text.
   */
  async readDocument(id: number, signal: AbortSignal, library: DocumentLibrary = 'enterprise', revision?: number): Promise<LibraryDocumentText> {
    const signed = await this.#requireSignedIn()
    const result = await this.#withAccess(signed,
      token => this.platform(signed.baseUrl).readDocument(token, id, signal, library, revision), signal)
    await this.#requireCurrent(signed)
    signal.throwIfAborted()
    return result
  }

  /**
   * Upload an original to the employee's private library.
   * @param name - Original user-supplied filename.
   * @param data - Bytes of the original file.
   * @returns Metadata for the saved original.
   */
  async uploadPersonalFile(name: string, data: Uint8Array<ArrayBuffer>): Promise<LibraryDocument> {
    const signed = await this.#requireSignedIn()
    const file = await this.#withAccess(signed, token => this.platform(signed.baseUrl).uploadPersonalFile(token, name, data))
    await this.#requireCurrent(signed)
    return file
  }

  /**
   * Remove a document owned by the employee.
   * @param id - Identifier of the requested resource.
   */
  async deletePersonalDocument(id: number): Promise<void> {
    const signed = await this.#requireSignedIn()
    await this.#withAccess(signed, token => this.platform(signed.baseUrl).deletePersonalDocument(token, id))
    await this.#requireCurrent(signed)
  }

  /**
   * Retrieve the original of the authorized document.
   * @param library - Selects the personal or enterprise library.
   * @param id - Identifier of the requested resource.
   * @param revision - Expected document or skill revision.
   * @returns The original file encoded as Base64.
   */
  async downloadDocument(library: DocumentLibrary, id: number, revision: number): Promise<string> {
    const signed = await this.#requireSignedIn()
    const data = await this.#withAccess(signed, token => this.platform(signed.baseUrl).downloadDocument(token, library, id, revision))
    await this.#requireCurrent(signed)
    return data
  }

  /**
   * Enterprise MCP services visible to this employee; empty while signed out.
   * @param signal - Cancels the outbound request or stream.
   * @returns Only the MCP services and tools available to the employee.
   */
  async mcpServers(signal?: AbortSignal): Promise<readonly ModelDeskMcpServer[]> {
    const signed = await this.signedIn()
    if (signed === undefined) return []
    const servers = await this.#withAccess(signed,
      token => this.platform(signed.baseUrl).fetchMcpServers(token, signal), signal)
    await this.#requireCurrent(signed)
    return servers
  }

  /**
   * Call one open enterprise MCP tool through the platform proxy.
   * @param serverId - Identifier of the configured MCP service.
   * @param tool - Name of the selected upstream MCP tool.
   * @param args - Arguments sent to the selected MCP tool.
   * @param signal - Cancels the outbound request or stream.
   * @returns The result returned by the MCP service.
   */
  async callMcpTool(serverId: number, tool: string, args: Record<string, unknown>, signal: AbortSignal): Promise<ModelDeskMcpCallResult> {
    const signed = await this.#requireSignedIn()
    const result = await this.#withAccess(signed,
      token => this.platform(signed.baseUrl).callMcpTool(token, serverId, tool, args, signal), signal)
    await this.#requireCurrent(signed)
    signal.throwIfAborted()
    return result
  }

  /**
   * This month's quota and usage.
   * @returns Usage and quota for the current billing month.
   */
  async usage(): Promise<ModelDeskUsage> {
    const signed = await this.#requireSignedIn()
    return this.#withAccess(signed, token => this.platform(signed.baseUrl).fetchUsage(token))
  }

  /**
   * Send a completion with the employee session, retrying only a rejected access token.
   * @param body - Request or response body for the model gateway.
   * @param signal - Cancels the outbound request or stream.
   * @returns The response body received from the model gateway.
   */
  async complete(body: Record<string, unknown>, signal?: AbortSignal): Promise<ReadableStream<Uint8Array<ArrayBuffer>>> {
    const signed = await this.#requireSignedIn()
    return this.#withAccess(signed, (token) => {
      signal?.throwIfAborted()
      return this.platform(signed.baseUrl).complete(token, body, signal)
    }, signal)
  }

  /** Revoke what the platform still accepts, then keep only the address. */
  async logout(): Promise<void> {
    let revoked: ModelDeskSignedIn | undefined
    const committed = await this.credentials.modifyRecord(SESSION_KEY, async (current) => {
      const existing = parseRecord(current)
      if (!isSignedIn(existing)) return undefined
      revoked = existing
      return toRecord({ version: 1, baseUrl: existing.baseUrl })
    })
    this.replacedAccessToken = undefined
    this.cached = parseRecord(committed)
    this.onChange()
    if (revoked !== undefined) {
      try {
        await this.platform(revoked.baseUrl).logout(revoked.accessToken, revoked.refreshToken)
      } catch {
        // Local sign-out succeeds even when the platform is unreachable.
      }
    }
  }

  /**
   * Commit an exchange result and refresh the catalog best-effort.
   * @param baseUrl - the origin the exchange ran against.
   * @param wire - validated `POST /token` body.
   * @param canCommit - Checks whether the authorization attempt is still current.
   * @returns The authenticated employee record.
   */
  async acceptSignedIn(baseUrl: string, wire: Parameters<typeof toSignedIn>[1], canCommit: () => boolean = () => true): Promise<ModelDeskSignedIn> {
    const next = toSignedIn(baseUrl, wire, undefined, this.clock())
    const committed = await this.#write(next, canCommit)
    if (!isSignedIn(committed)) throw new ModelDeskApiError('会话记录写入异常', 'storage')
    try {
      const models = await this.#withAccess(committed, token => this.platform(baseUrl).fetchModels(token))
      await this.#replaceModels(committed, models)
    } catch {
      // The catalog is a convenience; a signed-in session without it still works.
    }
    return this.#requireCurrent(committed)
  }

  /** Run one authenticated read, refreshing once on a 401. */
  async #withAccess<T>(signed: ModelDeskSignedIn, run: (token: string) => Promise<T>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted()
    const token = await this.accessToken()
    await this.#requireCurrent(signed)
    try {
      return await run(token)
    } catch (error) {
      if (!(error instanceof ModelDeskApiError) || error.details.status !== 401) throw error
      signal?.throwIfAborted()
      await this.#requireCurrent(signed)
      const replacement = await this.recover(token)
      await this.#requireCurrent(signed)
      return run(replacement)
    }
  }

  async #refreshOnce(): Promise<ModelDeskSignedIn> {
    const signed = await this.#requireSignedIn()
    let failure: ModelDeskApiError | undefined
    const committed = await this.credentials.modifyRecord(SESSION_KEY, async (current) => {
      const existing = parseRecord(current)
      if (!sameSession(existing, signed) || existing.refreshToken !== signed.refreshToken) return undefined
      const now = this.clock()
      let wire
      try {
        if (existing.refreshExpiresAt <= now || existing.absoluteExpiresAt <= now) {
          throw new ModelDeskApiError('登录已过期，请重新登录', 'session_expired', { status: 401 })
        }
        // The local provider holds the document lock across this mutation.
        wire = await this.platform(existing.baseUrl).exchangeRefreshToken(existing.refreshToken)
      } catch (error) {
        if (!(error instanceof ModelDeskApiError) || !TERMINAL_REFRESH_ERRORS.has(error.code)) throw error
        failure = error
        return toRecord({ version: 1, baseUrl: existing.baseUrl })
      }
      const candidate = toSignedIn(existing.baseUrl, wire, existing, now)
      if (candidate.sessionId !== existing.sessionId) {
        throw new ModelDeskApiError('平台返回了不同的会话', 'invalid_response')
      }
      return toRecord(candidate)
    })
    const effective = parseRecord(committed)
    this.cached = effective
    if (failure !== undefined) this.replacedAccessToken = undefined
    this.onChange()
    if (failure !== undefined) throw failure
    if (!sameSession(effective, signed)) throw signedOut()
    if (effective.accessToken !== signed.accessToken) this.replacedAccessToken = signed.accessToken
    return effective
  }

  async #replaceModels(signed: ModelDeskSignedIn, models: readonly ModelDeskModel[]): Promise<readonly ModelDeskModel[]> {
    const at = this.clock()
    const committed = await this.credentials.modifyRecord(SESSION_KEY, async (current) => {
      const existing = parseRecord(current)
      if (!sameSession(existing, signed)) return undefined
      return toRecord(withModels(existing, models, at))
    })
    const effective = parseRecord(committed)
    this.cached = effective
    if (!sameSession(effective, signed)) throw signedOut()
    this.onChange()
    return models
  }

  async #write(value: ModelDeskRecord, canCommit: () => boolean = () => true): Promise<ModelDeskRecord> {
    const committed = await this.credentials.modifyRecord(SESSION_KEY, async () => {
      if (!canCommit()) throw new ModelDeskApiError('登录已取消', 'login_cancelled')
      return toRecord(value)
    })
    const parsed = parseRecord(committed)
    if (parsed === undefined) throw new ModelDeskApiError('会话记录写入异常', 'storage')
    this.replacedAccessToken = undefined
    this.cached = parsed
    this.onChange()
    return parsed
  }

  async #requireSignedIn(): Promise<ModelDeskSignedIn> {
    const signed = await this.signedIn()
    if (!isSignedIn(signed)) throw signedOut()
    return signed
  }

  async #requireCurrent(expected: ModelDeskSignedIn): Promise<ModelDeskSignedIn> {
    const current = await this.signedIn()
    if (!sameSession(current, expected)) throw signedOut()
    return current
  }
}

function signedOut(): ModelDeskApiError {
  return new ModelDeskApiError('尚未登录', 'signed_out', { status: 401 })
}

function sameSession(current: ModelDeskRecord | undefined, expected: ModelDeskSignedIn): current is ModelDeskSignedIn {
  return isSignedIn(current) && current.baseUrl === expected.baseUrl && current.sessionId === expected.sessionId
}

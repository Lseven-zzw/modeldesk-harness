import type { DocumentLibrary, LibraryPage, LibraryDocument, LibraryDocumentText } from './types.ts'
/**
 * HTTPS calls to one ModelDesk platform origin. Every endpoint validates the
 * wire shape before returning, and every failure becomes a {@link ModelDeskApiError}
 * carrying the platform's own `code` so the settings page can name the cause.
 * @module @modeldesk/dsh-enterprise/platform
 */
import { z } from 'zod'
import { attributionHeaders } from '@deepseek-ai/dsh-llm'
import type {
  AuthorizationRequest, AuthorizationWire, ConfigWire, ModelDeskMcpCallResult, ModelDeskMcpServer,
  ModelDeskModel, ModelDeskUsage, ModelDeskSignedIn, TokenRequest, TokenWire,
} from './types.ts'

/** The one client identity this build speaks. */
export const CLIENT_ID = 'modeldesk-desktop'
/** The contract this build is compiled against. */
export const CONTRACT_VERSION = '0.1.0'
/** Default per-request deadline. */
export const DEFAULT_TIMEOUT_MS = 20_000

/** A platform call that failed, with the platform's own error code when it sent one. */
export class ModelDeskApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly details: { readonly status?: number; readonly requestId?: string | undefined } = {},
  ) {
    super(message)
    this.name = 'ModelDeskApiError'
  }
}

/** Whether a hostname names the local machine. */
function isLoopbackHost(hostname: string): boolean {
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]'
}

/**
 * Reduce user input to an origin. `https` is required except on loopback,
 * where the development server is reachable over plain HTTP.
 * @param raw - address typed by the employee.
 * @returns the origin, without a trailing slash.
 * @throws ModelDeskApiError `invalid_base_url` when the input is not a bare origin.
 */
export function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.trim()
  if (trimmed.length === 0) throw new ModelDeskApiError('请填写平台地址', 'invalid_base_url')
  let url: URL
  try {
    url = new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`)
  } catch {
    throw new ModelDeskApiError('平台地址格式不正确', 'invalid_base_url')
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new ModelDeskApiError('平台地址必须以 http 或 https 开头', 'invalid_base_url')
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw new ModelDeskApiError('平台地址不要包含用户名或密码', 'invalid_base_url')
  }
  if (url.pathname !== '/' || url.search.length > 0 || url.hash.length > 0) {
    throw new ModelDeskApiError('平台地址只填域名，不要带路径、参数或锚点', 'invalid_base_url')
  }
  if (url.protocol === 'http:' && !isLoopbackHost(url.hostname)) {
    throw new ModelDeskApiError('只有本机地址允许使用 http', 'invalid_base_url')
  }
  return url.origin
}

/** Zod schemas are the only place a wire field name appears. */
const configSchema = z.object({
  enabled: z.boolean(),
  client_id: z.string().optional(),
  contract_version: z.string().optional(),
})

const authorizationSchema = z.object({
  auth_id: z.string().min(1),
  authorize_url: z.string().min(1),
  expires_in: z.number().int().positive(),
})

const tokenSchema = z.object({
  token_type: z.literal('Bearer'),
  access_token: z.string().min(1),
  expires_in: z.number().int().positive(),
  refresh_token: z.string().min(1),
  refresh_expires_in: z.number().int().positive(),
  session_id: z.string().min(1),
  session_expires_at: z.string().min(1),
  user: z.object({ id: z.string(), username: z.string(), display_name: z.string(), department: z.string().nullable() }),
  org: z.object({ id: z.string(), name: z.string() }),
})

const modelSchema = z.object({
  id: z.string().min(1),
  object: z.literal('model'),
  created: z.number(),
  owned_by: z.string(),
  display_name: z.string(),
  context_window: z.number().int().positive(),
  capabilities: z.object({ streaming: z.boolean(), tools: z.boolean(), reasoning_content: z.boolean() }),
})

const modelsSchema = z.object({ object: z.literal('list'), data: z.array(modelSchema) })

const documentSource = z.object({
  id: z.int().positive(),
  title: z.string().min(1).max(400),
  revision: z.int().positive(),
  filename: z.string().nullable().default(null),
  media_type: z.string().nullable().default(null),
  parse_status: z.string().nullable().default(null),
})
const documentSearch = z.object({
  items: z.array(documentSource.extend({ excerpt: z.string().max(650) })).max(8),
  next_before: z.int().positive().nullable(),
})
const documentBody = documentSource.extend({
  format: z.enum(['markdown', 'text']),
  content: z.string().max(48_000),
})

const mcpServerSchema = z.object({
  id: z.int().positive(),
  name: z.string().min(1).max(100),
  description: z.string().max(4_000),
  guide: z.string().max(20_000),
  revision: z.int().positive(),
  tools: z.array(z.object({
    name: z.string().min(1).max(128),
    description: z.string().max(2_000),
    input_schema: z.record(z.string(), z.unknown()),
    access: z.enum(['read', 'write']),
  })).max(200),
})
const mcpServersSchema = z.object({ items: z.array(mcpServerSchema).max(100) })
const mcpCallSchema = z.object({
  content: z.array(z.record(z.string(), z.unknown())).max(1_000),
  is_error: z.boolean(),
  structured_content: z.unknown().optional(),
})

const usageSchema = z.object({
  billing_month: z.string().min(1),
  billing_timezone: z.string().min(1),
  limit_tokens: z.number().int().nonnegative(),
  used_tokens: z.number().int().nonnegative(),
  remaining_tokens: z.number().int().nonnegative(),
  resets_at: z.string().min(1),
})

const errorSchema = z.object({
  error: z.object({ message: z.string().optional(), code: z.string().optional(), type: z.string().optional() }).optional(),
  request_id: z.string().optional(),
})

/**
 * Map one token response to the stored record, keeping catalog from `previous`.
 * @param baseUrl - Origin of the ModelDesk server.
 * @param wire - Value returned by the ModelDesk API.
 * @param previous - Credential record observed before the update.
 * @param now - Current time used to evaluate session expiry.
 * @returns The authenticated employee record.
 */
export function toSignedIn(baseUrl: string, wire: TokenWire, previous?: ModelDeskSignedIn, now = Date.now()): ModelDeskSignedIn {
  const absolute = Date.parse(wire.session_expires_at)
  if (!Number.isFinite(absolute)) throw new ModelDeskApiError('平台返回的会话有效期无法解析', 'invalid_response')
  return {
    version: 1,
    baseUrl,
    sessionId: wire.session_id,
    accessToken: wire.access_token,
    accessExpiresAt: Math.min(now + wire.expires_in * 1000, absolute),
    refreshToken: wire.refresh_token,
    refreshExpiresAt: Math.min(now + wire.refresh_expires_in * 1000, absolute),
    absoluteExpiresAt: absolute,
    user: {
      id: wire.user.id, username: wire.user.username,
      displayName: wire.user.display_name, department: wire.user.department,
    },
    org: { id: wire.org.id, name: wire.org.name },
    models: previous?.models ?? [],
    modelsFetchedAt: previous?.modelsFetchedAt ?? 0,
  }
}

/** Options shared by every call; tests inject both. */
export interface PlatformOptions {
  readonly fetchImpl?: typeof fetch
  readonly timeoutMs?: number
}

/** HTTP surface of one platform origin. */
export class ModelDeskPlatform {
  private readonly fetchImpl: typeof fetch
  private readonly timeoutMs: number

  /**
   * Normalized origin for outbound ModelDesk requests.
   */
  readonly baseUrl: string

  constructor(baseUrl: string, options: PlatformOptions = {}) {
    this.baseUrl = normalizeBaseUrl(baseUrl)
    this.fetchImpl = options.fetchImpl ?? fetch
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  /**
   * `GET /config`.
   * @returns The ConfigWire result.
   */
  async config(): Promise<ConfigWire> {
    return this.json('/api/v1/modeldesk/config', {}, configSchema)
  }

  /**
   * `POST /authorizations`.
   * @param body - Request or response body for the model gateway.
   * @returns The AuthorizationWire result.
   */
  async createAuthorization(body: AuthorizationRequest): Promise<AuthorizationWire> {
    const response = await this.json('/api/v1/modeldesk/authorizations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }, authorizationSchema)
    return response
  }

  /**
   * `POST /token` with an identity ticket.
   * @param input - Inputs for the selected operation.
   * @returns The TokenWire result.
   */
  async exchangeTicket(input: { authId: string; identityTicket: string; codeVerifier: string }): Promise<TokenWire> {
    const body: TokenRequest = {
      grant_type: 'identity_ticket',
      identity_ticket: input.identityTicket,
      auth_id: input.authId,
      code_verifier: input.codeVerifier,
    }
    return this.json('/api/v1/modeldesk/token', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }, tokenSchema)
  }

  /**
   * `POST /token` with a refresh token.
   * @param refreshToken - Current refresh token for the session.
   * @returns The TokenWire result.
   */
  async exchangeRefreshToken(refreshToken: string): Promise<TokenWire> {
    const body: TokenRequest = { grant_type: 'refresh_token', refresh_token: refreshToken }
    return this.json('/api/v1/modeldesk/token', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }, tokenSchema)
  }

  /**
   * `GET /models`.
   * @param accessToken - Access token for the active employee session.
   * @returns The authorized model catalog.
   */
  async fetchModels(accessToken: string): Promise<readonly ModelDeskModel[]> {
    const wire = await this.json('/api/v1/modeldesk/models', { headers: { authorization: `Bearer ${accessToken}` } }, modelsSchema)
    return wire.data.map(model => ({
      id: model.id,
      displayName: model.display_name,
      contextWindow: model.context_window,
      capabilities: {
        streaming: model.capabilities.streaming,
        tools: model.capabilities.tools,
        reasoningContent: model.capabilities.reasoning_content,
      },
    }))
  }

  /**
   * List the published skills visible to the employee.
   * @param accessToken - Access token for the active employee session.
   * @returns The skills available to the authenticated employee.
   */
  async fetchSkills(accessToken: string): Promise<{ code: string; revision: number; markdown: string; description?: string | undefined; has_files?: boolean | undefined }[]> {
    const wire = await this.json('/api/v1/modeldesk/skills', {
      headers: { authorization: `Bearer ${accessToken}` },
    }, z.object({ items: z.array(z.object({
      code: z.string().max(64).regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/),
      revision: z.number().int().positive(),
      markdown: z.string().min(1).max(130000),
      description: z.string().optional(),
      has_files: z.boolean().optional(),
    })).max(100) }))
    return wire.items
  }

  /**
   * Read the authorized attachment bundle for a published skill.
   * @param accessToken - Access token for the active employee session.
   * @param code - Stable slug of the published skill.
   * @param revision - Expected document or skill revision.
   * @returns The file bundle for the requested skill revision.
   */
  async fetchSkillFiles(accessToken: string, code: string, revision: number): Promise<{ path: string; data: string }[]> {
    const wire = await this.json(`/api/v1/modeldesk/skills/${encodeURIComponent(code)}/bundle?revision=${revision}`, {
      headers: { authorization: `Bearer ${accessToken}` },
    }, z.object({ files: z.array(z.object({
      path: z.string().min(1).max(220),
      data: z.string().max(2_796_204),
    })).max(100) }))
    return wire.files
  }

  /**
   * Search the selected library using the employee's current access.
   * @param accessToken - Access token for the active employee session.
   * @param query - Search terms entered by the employee.
   * @param before - Upper document ID bound for loading the next page.
   * @param signal - Cancels the outbound request or stream.
   * @param library - Selects the personal or enterprise library.
   * @returns One page of matching documents and its pagination cursor.
   */
  async searchDocuments(accessToken: string, query: string, before: number | undefined, signal: AbortSignal, library: DocumentLibrary = 'enterprise'): Promise<LibraryPage> {
    const params = new URLSearchParams({ q: query, limit: '8', library })
    if (before !== undefined) params.set('before', String(before))
    return this.json(`/api/v1/modeldesk/documents?${params}`, {
      headers: { authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]),
    }, documentSearch)
  }

  /**
   * Read the document and check its revision when supplied.
   * @param accessToken - Access token for the active employee session.
   * @param id - Identifier of the requested resource.
   * @param signal - Cancels the outbound request or stream.
   * @param library - Selects the personal or enterprise library.
   * @param revision - Expected document or skill revision.
   * @returns Document metadata and extracted text.
   */
  async readDocument(accessToken: string, id: number, signal: AbortSignal, library: DocumentLibrary = 'enterprise', revision?: number): Promise<LibraryDocumentText> {
    const params = new URLSearchParams({ library })
    if (revision !== undefined) params.set('revision', String(revision))
    return this.json(`/api/v1/modeldesk/documents/${id}?${params}`, {
      headers: { authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]),
    }, documentBody)
  }

  /**
   * Upload an original to the employee's private library.
   * @param accessToken - Access token for the active employee session.
   * @param name - Original user-supplied filename.
   * @param data - Bytes of the original file.
   * @returns Metadata for the saved original.
   */
  async uploadPersonalFile(accessToken: string, name: string, data: Uint8Array<ArrayBuffer>): Promise<LibraryDocument> {
    const body = new FormData()
    body.append('file', new Blob([data]), name)
    return this.json('/api/v1/modeldesk/documents/personal/files', {
      method: 'POST', headers: { authorization: `Bearer ${accessToken}` }, body,
      signal: AbortSignal.timeout(210_000),
    }, documentSource)
  }

  /**
   * Remove a document owned by the employee.
   * @param accessToken - Access token for the active employee session.
   * @param id - Identifier of the requested resource.
   */
  async deletePersonalDocument(accessToken: string, id: number): Promise<void> {
    await this.json(`/api/v1/modeldesk/documents/${id}`, {
      method: 'DELETE', headers: { authorization: `Bearer ${accessToken}` },
    }, z.undefined())
  }

  /**
   * Retrieve the original of the authorized document.
   * @param accessToken - Access token for the active employee session.
   * @param library - Selects the personal or enterprise library.
   * @param id - Identifier of the requested resource.
   * @param revision - Expected document or skill revision.
   * @returns The original file encoded as Base64.
   */
  async downloadDocument(accessToken: string, library: DocumentLibrary, id: number, revision: number): Promise<string> {
    const params = new URLSearchParams({ library, revision: String(revision) })
    const response = await this.send(`/api/v1/modeldesk/documents/${id}/file?${params}`, {
      headers: { authorization: `Bearer ${accessToken}` },
    })
    if (!response.ok) throw this.errorFrom(response, await this.consume(response))
    return Buffer.from(await response.arrayBuffer()).toString('base64')
  }

  /**
   * `GET /mcp/servers`: services and open tools authorized for this employee.
   * @param accessToken - Access token for the active employee session.
   * @param signal - Cancels the outbound request or stream.
   * @returns Only the MCP services and tools available to the employee.
   */
  async fetchMcpServers(accessToken: string, signal?: AbortSignal): Promise<readonly ModelDeskMcpServer[]> {
    const init: RequestInit = { headers: { authorization: `Bearer ${accessToken}` } }
    if (signal !== undefined) init.signal = AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)])
    const wire = await this.json('/api/v1/modeldesk/mcp/servers', init, mcpServersSchema)
    return wire.items
  }

  /**
   * `POST /mcp/servers/{id}/call`: the platform holds the upstream credential.
   * @param accessToken - Access token for the active employee session.
   * @param serverId - Identifier of the configured MCP service.
   * @param tool - Name of the selected upstream MCP tool.
   * @param args - Arguments sent to the selected MCP tool.
   * @param signal - Cancels the outbound request or stream.
   * @returns The result returned by the MCP service.
   */
  async callMcpTool(
    accessToken: string, serverId: number, tool: string, args: Record<string, unknown>, signal: AbortSignal,
  ): Promise<ModelDeskMcpCallResult> {
    return this.json(`/api/v1/modeldesk/mcp/servers/${serverId}/call`, {
      method: 'POST',
      headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ tool, arguments: args }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(310_000)]),
    }, mcpCallSchema)
  }

  /**
   * `GET /usage`.
   * @param accessToken - Access token for the active employee session.
   * @returns Usage and quota for the current billing month.
   */
  async fetchUsage(accessToken: string): Promise<ModelDeskUsage> {
    const wire = await this.json('/api/v1/modeldesk/usage', { headers: { authorization: `Bearer ${accessToken}` } }, usageSchema)
    return {
      billingMonth: wire.billing_month,
      billingTimezone: wire.billing_timezone,
      limitTokens: wire.limit_tokens,
      usedTokens: wire.used_tokens,
      remainingTokens: wire.remaining_tokens,
      resetsAt: wire.resets_at,
    }
  }

  /**
   * Open one completion response, preserving cancellation through body consumption.
   * @param accessToken - Access token for the active employee session.
   * @param body - Request or response body for the model gateway.
   * @param signal - Cancels the outbound request or stream.
   * @returns The response body received from the model gateway.
   */
  async complete(
    accessToken: string, body: Record<string, unknown>, signal?: AbortSignal,
  ): Promise<ReadableStream<Uint8Array<ArrayBuffer>>> {
    const timeout = AbortSignal.timeout(310_000)
    const response = await this.send('/api/v1/modeldesk/chat/completions', {
      method: 'POST',
      signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
      headers: {
        ...attributionHeaders(),
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json',
        accept: body.stream === true ? 'text/event-stream' : 'application/json',
      },
      body: JSON.stringify(body),
    })
    if (!response.ok) {
      const error = await this.consume(response).catch(() => undefined)
      throw this.errorFrom(response, error)
    }
    if (response.body === null) throw new ModelDeskApiError('平台未返回模型回复', 'invalid_response')
    return response.body
  }

  /**
   * `POST /logout`; a rejected revocation is still a successful local sign-out.
   * @param accessToken - Access token for the active employee session.
   * @param refreshToken - Current refresh token for the session.
   */
  async logout(accessToken: string, refreshToken?: string): Promise<void> {
    const response = await this.send('/api/v1/modeldesk/logout', {
      method: 'POST',
      headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ refresh_token: refreshToken }),
    })
    if (response.status === 204) return
    const body = await this.consume(response)
    if (!response.ok) throw this.errorFrom(response, body)
  }

  /** One JSON request; non-2xx becomes a {@link ModelDeskApiError}. */
  private async json<T>(path: string, init: RequestInit, schema: z.ZodType<T>): Promise<T> {
    const response = await this.send(path, init)
    const body = await this.consume(response)
    if (!response.ok) throw this.errorFrom(response, body)
    const parsed = schema.safeParse(body)
    if (!parsed.success) {
      throw new ModelDeskApiError('平台返回的数据结构不符合契约', 'invalid_response', {
        status: response.status, requestId: response.headers.get('x-request-id') ?? undefined,
      })
    }
    return parsed.data
  }

  /** Send with a hard deadline; transport failures are reported as network failures. */
  private async send(path: string, init: RequestInit): Promise<Response> {
    try {
      return await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...init, redirect: 'error', signal: init.signal ?? AbortSignal.timeout(this.timeoutMs),
      })
    } catch (error) {
      throw this.transportError(error)
    }
  }

  private transportError(error: unknown): ModelDeskApiError {
    const aborted = error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')
    return new ModelDeskApiError(aborted ? '平台响应超时' : '无法连接平台，请检查地址与网络', 'network_failure')
  }
  /** Read the body once; an empty body reads as `undefined`. */
  private async consume(response: Response): Promise<unknown> {
    const text = await response.text().catch((error: unknown) => { throw this.transportError(error) })
    if (text.length === 0) return undefined
    try {
      return JSON.parse(text) as unknown
    } catch {
      throw new ModelDeskApiError('平台返回了非 JSON 响应', 'invalid_response', {
        status: response.status, requestId: response.headers.get('x-request-id') ?? undefined,
      })
    }
  }

  /** Prefer the platform's code and message; fall back to the status line. */
  private errorFrom(response: Response, body: unknown): ModelDeskApiError {
    const requestId = response.headers.get('x-request-id') ?? undefined
    const parsed = errorSchema.safeParse(body)
    if (parsed.success && parsed.data.error !== undefined) {
      const { code, message } = parsed.data.error
      if (typeof code === 'string' && code.length > 0) {
        return new ModelDeskApiError(
          typeof message === 'string' && message.length > 0 ? message : `平台拒绝了请求（${code}）`,
          code,
          { status: response.status, requestId },
        )
      }
    }
    return new ModelDeskApiError(`平台返回 HTTP ${response.status}`, response.status === 401 ? 'invalid_access_token' : 'http_error', {
      status: response.status, requestId,
    })
  }
}

/**
 * Reject an `authorize_url` that does not belong to the saved platform.
 * A second origin here would leak the PKCE challenge to a third party.
 * @param baseUrl - saved origin.
 * @param authorizeUrl - value from `POST /authorizations`.
 * @param authId - transaction id that must appear exactly once as `auth_id`.
 * @returns the validated URL.
 */
export function validateAuthorizeUrl(baseUrl: string, authorizeUrl: string, authId: string): string {
  let url: URL
  try {
    url = new URL(authorizeUrl)
  } catch {
    throw new ModelDeskApiError('平台返回的授权地址无法解析', 'invalid_response')
  }
  const base = new URL(baseUrl)
  if (url.origin !== base.origin) throw new ModelDeskApiError('授权地址与平台地址不一致', 'invalid_response')
  if (url.pathname !== '/desktop-login') throw new ModelDeskApiError('授权地址路径不是 /desktop-login', 'invalid_response')
  if (url.username.length > 0 || url.password.length > 0 || url.hash.length > 0) {
    throw new ModelDeskApiError('授权地址包含不允许的部分', 'invalid_response')
  }
  const ids = url.searchParams.getAll('auth_id')
  if (ids.length !== 1 || ids[0] !== authId) throw new ModelDeskApiError('授权地址缺少匹配的 auth_id', 'invalid_response')
  return url.href
}

import type {} from '@deepseek-ai/dsh-typert-protocol'

/**
 * Wire and stored shapes shared by the Host half, the LLM adapter, and the
 * browser half. Types only plus two narrow runtime guards.
 * @module @modeldesk/dsh-enterprise/types
 */

/** Signed-in employee as the platform reports it. */
export interface ModelDeskUser {
  readonly id: string
  readonly username: string
  readonly displayName: string
  readonly department: string | null
}

/** Organisation the employee belongs to. */
export interface ModelDeskOrg {
  readonly id: string
  readonly name: string
}

/** Capability flags the platform advertises per model. */
export interface ModelDeskModelCapabilities {
  readonly streaming: boolean
  readonly tools: boolean
  readonly reasoningContent: boolean
}

/** One authorized model, already mapped to camelCase. */
export interface ModelDeskModel {
  readonly id: string
  readonly displayName: string
  readonly contextWindow: number
  readonly capabilities: ModelDeskModelCapabilities
}

/** Persisted before any sign-in: only the platform address is known. */
export interface ModelDeskStored {
  readonly version: 1
  readonly baseUrl: string
}

/** Persisted after sign-in; tokens never leave the Host. */
export interface ModelDeskSignedIn {
  readonly version: 1
  readonly baseUrl: string
  readonly sessionId: string
  readonly accessToken: string
  readonly accessExpiresAt: number
  readonly refreshToken: string
  readonly refreshExpiresAt: number
  readonly absoluteExpiresAt: number
  readonly user: ModelDeskUser
  readonly org: ModelDeskOrg
  readonly models: readonly ModelDeskModel[]
  readonly modelsFetchedAt: number
}

/** Either form of the single stored record. */
export type ModelDeskRecord = ModelDeskStored | ModelDeskSignedIn

/** Monthly quota snapshot from `GET /usage`. */
export interface ModelDeskUsage {
  readonly billingMonth: string
  readonly billingTimezone: string
  readonly limitTokens: number
  readonly usedTokens: number
  readonly remainingTokens: number
  readonly resetsAt: string
}

/** One open tool of an enterprise MCP service, as the platform exposes it. */
export interface ModelDeskMcpTool {
  readonly name: string
  readonly description: string
  readonly input_schema: Record<string, unknown>
  readonly access: 'read' | 'write'
}

/** One enterprise MCP service visible to the signed-in employee. */
export interface ModelDeskMcpServer {
  readonly id: number
  readonly name: string
  readonly description: string
  readonly guide: string
  readonly revision: number
  readonly tools: readonly ModelDeskMcpTool[]
}

/** One proxied MCP tool call result; upstream credentials never reach the client. */
export interface ModelDeskMcpCallResult {
  readonly content: readonly Record<string, unknown>[]
  readonly is_error: boolean
  readonly structured_content?: unknown
}

/** Read-only view crossing the Remote wire into the settings section. */
export interface EnterpriseView {
  readonly baseUrl: string | null
  readonly phase: 'unconfigured' | 'signed-out' | 'signing-in' | 'signed-in'
  readonly user: ModelDeskUser | null
  readonly org: ModelDeskOrg | null
  /** Absolute session expiry, ISO 8601; null while signed out. */
  readonly sessionExpiresAt: string | null
  readonly models: readonly ModelDeskModel[]
  /** Last sign-in failure, cleared when a new attempt starts. */
  readonly error?: { readonly code: string; readonly message: string }
  /** Present while a login attempt waits for the browser. */
  readonly login: { readonly authorizeUrl: string; readonly expiresAt: string } | null
}

/** Request body for `POST /authorizations`. */
export interface AuthorizationRequest {
  readonly client_id: string
  readonly redirect_uri: string
  readonly code_challenge: string
  readonly code_challenge_method: 'S256'
  readonly state: string
  readonly device_name: string
  readonly client_version: string
}

/** Ticket or refresh exchange body for `POST /token`. */
export type TokenRequest =
  | { readonly grant_type: 'identity_ticket'; readonly identity_ticket: string; readonly auth_id: string; readonly code_verifier: string }
  | { readonly grant_type: 'refresh_token'; readonly refresh_token: string }

/** `POST /token` success body. */
export interface TokenWire {
  readonly token_type: 'Bearer'
  readonly access_token: string
  readonly expires_in: number
  readonly refresh_token: string
  readonly refresh_expires_in: number
  readonly session_id: string
  readonly session_expires_at: string
  readonly user: { readonly id: string; readonly username: string; readonly display_name: string; readonly department: string | null }
  readonly org: { readonly id: string; readonly name: string }
}

/** `GET /config` success body. */
export interface ConfigWire {
  readonly enabled: boolean
  readonly client_id?: string | undefined
  readonly contract_version?: string | undefined
}

/** `POST /authorizations` success body. */
export interface AuthorizationWire {
  readonly auth_id: string
  readonly authorize_url: string
  readonly expires_in: number
}

/** `startLogin` 的返回：客户端据此显示「正在浏览器中打开」，不再自己拼地址。 */
export interface LoginStartView {
  readonly authorizeUrl: string
  readonly expiresAt: string
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** 企业账号动作被拒绝；`code` 是平台错误码或本插件自己的稳定码。 */
    'modeldesk/rejected': { readonly code: string }
  }
}


/** Storage and authorization scope for a library document. */
export type DocumentLibrary = 'personal' | 'enterprise'

/** File identity and searchable metadata without the original bytes. */
export interface LibraryDocument {
  readonly id: number
  readonly title: string
  readonly revision: number
  readonly filename?: string | null
  readonly media_type?: string | null
  readonly parse_status?: string | null
  readonly excerpt?: string
}

/** A page of authorized documents. */
export interface LibraryPage {
  readonly items: readonly LibraryDocument[]
  readonly next_before: number | null
}

/** Current authorized document text. */
export interface LibraryDocumentText extends LibraryDocument {
  readonly format: 'markdown' | 'text'
  readonly content: string
}

/** Employee-facing metadata for a published enterprise skill. */
export interface ModelDeskSkillSummary {
  readonly code: string
  readonly revision: number
  readonly description: string
}

/** Capabilities visible to the active enterprise account. */
export interface ModelDeskCapabilities {
  readonly signedIn: boolean
  readonly skills: readonly ModelDeskSkillSummary[]
  readonly mcp: readonly ModelDeskMcpSummary[]
}

/** Employee-facing MCP catalog without invocation schemas or credentials. */
export interface ModelDeskMcpSummary {
  readonly id: number
  readonly name: string
  readonly description: string
  readonly guide: string
  readonly tools: readonly ModelDeskMcpToolSummary[]
}

/** Name and access mode for an authorized MCP tool. */
export interface ModelDeskMcpToolSummary {
  readonly name: string
  readonly description: string
  readonly access: 'read' | 'write'
}

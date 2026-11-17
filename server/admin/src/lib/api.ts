export interface Employee {
  id: number
  username: string
  display_name: string
  department: string | null
  role: 'EMPLOYEE' | 'ADMIN'
  status: 0 | 1
  created_at: string
}

export interface SessionInfo {
  user: Employee
  csrf_token: string
  org_name: string
  permissions: string[]
  model_permissions?: Record<string, string[]>
}

export type EmployeeOption = Pick<Employee, 'id' | 'username' | 'display_name' | 'department'>
export interface ModelOption { id: number; display_name: string }
export interface EmployeeCapability {
  id: number | string
  name: string
  sources: { type: 'EVERYONE' | 'DEPARTMENT' | 'USER' | 'GROUP' | 'ADMIN'; name: string }[]
}
export interface EmployeeCapabilities {
  models: (EmployeeCapability & { limit: number; used: number; month: string })[]
  skills: EmployeeCapability[]
  documents: EmployeeCapability[]
  mcp: (EmployeeCapability & { tools: { name: string; access: 'read' | 'write' }[] })[]
}
export interface AdminRole { code: string; name: string; permissions: string[]; member_count?: number }
export interface EffectivePermission { permission: string; name: string; department: string | null; department_name: string | null; role: string | null; role_name: string | null; granted_permission: string; group_id: number | null; group_name: string | null; scope_root: string | null; scope_root_name: string | null }
export interface AuthorizationAudit { id: number; actor_id: number; action: string; target: string; details: { before: unknown; after: unknown }; created_at: string }
export interface UserGroup { id: number; name: string; member_ids: number[]; assignments: AdminAssignment[] }
export type SkillAudienceType = 'EVERYONE' | 'USER' | 'DEPARTMENT' | 'GROUP'
export type SkillCategory = 'productivity' | 'content' | 'data-analysis' | 'business' | 'collaboration'
  | 'knowledge' | 'development' | 'finance' | 'lifestyle'
export interface SkillAudience { subject_type: SkillAudienceType; subject_id: number }
export interface EnterpriseDocumentSummary {
  filename?: string
  parse_status?: string
  id: number
  title: string
  format: 'markdown' | 'text'
  enabled: boolean
  revision: number
  updated_at: string
}
export type EnterpriseDocumentBody = Pick<EnterpriseDocumentSummary, 'title' | 'format' | 'enabled'> & {
  content: string
  grants: SkillAudience[]
}
export type EnterpriseDocument = EnterpriseDocumentSummary & EnterpriseDocumentBody
export interface McpTool {
  name: string
  description: string
  input_schema: Record<string, unknown>
  access: 'read' | 'write'
  enabled: boolean
}
export interface McpServer {
  id: number
  name: string
  endpoint: string
  description: string
  guide: string
  token_masked: string | null
  enabled: boolean
  revision: number
  grants: SkillAudience[]
  tools: McpTool[]
  discovered_at: string | null
}
export type McpServerBody = Pick<McpServer, 'name' | 'endpoint' | 'description' | 'guide' | 'enabled' | 'grants'> & { token?: string }
export type McpToolPolicy = Pick<McpTool, 'name' | 'access' | 'enabled'>
export interface SkillBundleView {
  files: string[]
  source: { kind: 'markdown' | 'zip' | 'git'; repository?: string; ref?: string; skill_path?: string | null } | null
}
export interface EnterpriseSkill extends SkillBundleView {
  code: string
  revision: number
  enabled: boolean
  description: string
  remarks: string | null
  category: SkillCategory | null
  instructions: string
  grants: SkillAudience[]
  published_by: number | null
  published_at: string | null
  draft: SkillDraft | null
}
export interface SkillVersion extends SkillBundleView {
  revision: number
  description: string
  remarks: string | null
  category: SkillCategory | null
  instructions: string
  published_by: number | null
  published_at: string
}
export interface SkillDraft extends SkillBundleView {
  revision: string
  description: string
  remarks: string | null
  category: SkillCategory | null
  instructions: string
  enabled: boolean
  grants: SkillAudience[]
  updated_by: number
  updated_at: string
}
export interface SkillImportTarget { code?: string; revision?: number; draft_revision?: string }
export type ModelDelegationSubjectType = 'USER' | 'DEPARTMENT' | 'GROUP'
export interface ModelDelegationSubject { subject_type: ModelDelegationSubjectType; subject_id: number }
export interface ModelDelegation extends ModelDelegationSubject { permissions: string[]; include_descendants: boolean }
export interface EffectiveModelPermission extends ModelDelegationSubject {
  model_id: number; model_name: string; permission: string; name: string
  subject_name: string | null; granted_permission: string; include_descendants: boolean
}
export interface AdminPermission { code: string; name: string; department_scoped: boolean; implies: string | null }
export interface AdminAssignment { role: string; department: string | null; include_descendants?: boolean }
export interface Department { id: number; code: string; name: string; parent_id: number | null; members: number; archived: boolean }

export interface ModelView {
  id: number
  channel_id: number | null
  code: string
  display_name: string
  provider_name: string | null
  upstream_kind: string
  upstream_model: string
  upstream_base: string
  api_key_masked: string
  extra_config: Record<string, unknown> | null
  capabilities: string
  enabled: boolean
  created_at: string
}

export interface Grant { subject_type: 'EVERYONE' | 'DEPARTMENT' | 'USER'; subject_id: string }
export interface CreditRule {
  id: number
  subject_type: 'USER' | 'DEPARTMENT' | 'DEFAULT'
  subject_id: string
  model_id: number
  monthly_token_limit: number
}
export interface CallRow {
  id: number
  request_id: string
  user_id: number
  display_name: string | null
  model_id: number
  model_code: string
  input_tokens: number | null
  output_tokens: number | null
  total_tokens: number | null
  status: string
  http_status: number
  latency_ms: number
  created_at: string
}
export interface SummaryRow {
  user_id: number
  display_name: string
  department: string | null
  limit_tokens: number
  used_tokens: number
  call_count: number
  unknown_usage_calls: number
  tokens_in_window: number | null
}

export type ModelPayload = Omit<ModelView, 'id' | 'channel_id' | 'created_at' | 'api_key_masked'>

export interface ModelChannel {
  id: number
  name: string
  upstream_base: string
  upstream_kind: string
  api_key_masked: string
}

type ChannelPayload = Pick<ModelChannel, 'name' | 'upstream_base'>

export interface CreditRulePayload {
  subject_type: 'USER' | 'DEPARTMENT' | 'DEFAULT'
  subject_id: string
  model_id: number
  monthly_token_limit: number
}

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message)
    this.name = 'ApiError'
  }
}

let csrfToken = ''
let onUnauthorized: (() => void) | undefined

export function setUnauthorizedHandler(handler: () => void): void {
  onUnauthorized = handler
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers)
  headers.set('Accept', 'application/json')
  if (init.body !== undefined && !(init.body instanceof FormData) && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
  if (init.method !== undefined && init.method !== 'GET') headers.set('X-CSRF-Token', csrfToken)
  const response = await fetch(`/api/admin${path}`, { ...init, headers, credentials: 'same-origin' })
  if (response.status === 401) {
    csrfToken = ''
    onUnauthorized?.()
    throw new ApiError(401, 'unauthenticated', '请先登录管理台')
  }
  if (response.status === 204) return undefined as T
  const body = await response.json().catch(() => ({})) as { error?: { message?: string; code?: string } }
  if (!response.ok) {
    throw new ApiError(response.status, body.error?.code ?? 'invalid_request', body.error?.message ?? '请求失败')
  }
  return body as T
}

function json(method: string, payload: unknown): RequestInit {
  return { method, body: JSON.stringify(payload) }
}

export const api = {
  documents: {
    list: (query: string, before?: number) => {
      const params = new URLSearchParams({ q: query })
      if (before !== undefined) params.set('before', String(before))
      return request<{ items: EnterpriseDocumentSummary[]; next_before: number | null }>(`/documents?${params}`)
    },
    upload: (file: File, grants: EnterpriseDocumentBody['grants']) => {
      const body = new FormData()
      body.append('file', file)
      body.append('grants', JSON.stringify(grants))
      return request<EnterpriseDocumentSummary>('/documents/files', { method: 'POST', body })
    },
    read: (id: number) => request<EnterpriseDocument>(`/documents/${id}`),
    retryParse: (id: number) => request<EnterpriseDocumentSummary>(`/documents/${id}/retry-parse`, { method: 'POST' }),
    options: () => request<Record<Exclude<SkillAudienceType, 'EVERYONE'>, { id: number; name: string }[]>>('/documents/audience-options'),
    create: (body: EnterpriseDocumentBody) => request<EnterpriseDocument>('/documents', json('POST', body)),
    update: (id: number, revision: number, body: EnterpriseDocumentBody) =>
      request<EnterpriseDocument>(`/documents/${id}`, json('PUT', { ...body, revision })),
  },
  mcp: {
    list: () => request<{ items: McpServer[] }>('/mcp'),
    read: (id: number) => request<McpServer>(`/mcp/${id}`),
    options: () => request<Record<Exclude<SkillAudienceType, 'EVERYONE'>, { id: number; name: string }[]>>('/mcp/audience-options'),
    create: (body: McpServerBody) => request<McpServer>('/mcp', json('POST', body)),
    update: (id: number, revision: number, body: McpServerBody & { tools?: McpToolPolicy[] }) =>
      request<McpServer>(`/mcp/${id}`, json('PUT', { ...body, revision })),
    discover: (id: number) => request<McpServer>(`/mcp/${id}/discover`, { method: 'POST' }),
  },
  skills: {
    list: () => request<{ items: EnterpriseSkill[] }>('/skills'),
    options: () => request<Record<Exclude<SkillAudienceType, 'EVERYONE'>, { id: number; name: string }[]>>('/skills/audience-options'),
    saveDraft: (code: string, body: Pick<SkillDraft, 'description' | 'remarks' | 'category' | 'instructions' | 'enabled' | 'grants'> &
      { revision: number; draft_revision: string | null; source_revision?: number }) =>
      request<EnterpriseSkill>(`/skills/${encodeURIComponent(code)}/draft`, json('PUT', body)),
    publishDraft: (code: string, revision: number, draft_revision: string) =>
      request<EnterpriseSkill>(`/skills/${encodeURIComponent(code)}/publish`, json('POST', { revision, draft_revision })),
    discardDraft: (code: string, revision: number, draft_revision: string) =>
      request<{ item: EnterpriseSkill | null }>(`/skills/${encodeURIComponent(code)}/draft`, json('DELETE', { revision, draft_revision })),
    unpublish: (code: string, revision: number) =>
      request<EnterpriseSkill>(`/skills/${encodeURIComponent(code)}/unpublish`, json('POST', { revision })),
    versions: (code: string, before?: number) =>
      request<{ items: SkillVersion[]; next_before: number | null }>(
        `/skills/${encodeURIComponent(code)}/versions${before === undefined ? '' : `?before=${before}`}`,
      ),
    importFile: (file: File, kind: 'markdown' | 'zip', target: SkillImportTarget, skillPath: string) => {
      const query = new URLSearchParams({ kind })
      if (target.code) query.set('code', target.code)
      if (target.revision !== undefined) query.set('revision', String(target.revision))
      if (target.draft_revision) query.set('draft_revision', target.draft_revision)
      if (skillPath) query.set('skill_path', skillPath)
      return request<EnterpriseSkill>(`/skills/import/file?${query}`, {
        method: 'POST', body: file, headers: { 'Content-Type': 'application/octet-stream' },
      })
    },
    importGit: (repository: string, ref: string, skill_path: string, target: SkillImportTarget) =>
      request<EnterpriseSkill>('/skills/import/git', json('POST', {
        ...target, repository, ref: ref || 'HEAD', skill_path: skill_path || null,
      })),
    uploadAttachment: (code: string, path: string, file: File, revision: number, draft_revision: string) => {
      const query = new URLSearchParams({ path, revision: String(revision), draft_revision })
      return request<EnterpriseSkill>(`/skills/${encodeURIComponent(code)}/draft/files?${query}`, {
        method: 'PUT', body: file, headers: { 'Content-Type': 'application/octet-stream' },
      })
    },
    removeAttachment: (code: string, path: string, revision: number, draft_revision: string) =>
      request<EnterpriseSkill>(`/skills/${encodeURIComponent(code)}/draft/files?${new URLSearchParams({ path })}`,
        json('DELETE', { revision, draft_revision })),
    attachmentUrl: (code: string, path: string, revision?: number) => {
      const query = new URLSearchParams({ path })
      if (revision !== undefined) query.set('revision', String(revision))
      return `/api/admin/skills/${encodeURIComponent(code)}/files?${query}`
    },
  },
  async session(): Promise<SessionInfo> {
    const info = await request<SessionInfo>('/session')
    csrfToken = info.csrf_token
    return info
  },
  accessOptions: () => request<{ models: ModelOption[]; employees: EmployeeOption[]; departments: Pick<Department, 'code' | 'name'>[] }>('/access-options'),
  departments: {
    list: () => request<{ items: Department[] }>('/departments'),
    create: (code: string, name: string, parent_id: number | null) =>
      request<Department>('/departments', json('POST', { code, name, parent_id })),
    update: (id: number, name: string, parent_id: number | null) => request<Omit<Department, 'members'>>(
      `/departments/${id}`, json('PATCH', { name, parent_id }),
    ),
    setArchived: (id: number, archived: boolean) =>
      request<{ archived: boolean }>(`/departments/${id}/status`, json('PUT', { archived })),
  },
  roles: {
    list: () => request<{ items: AdminRole[]; permissions: AdminPermission[]; departments: string[]; department_names: Record<string, string> }>('/roles'),
    save: (code: string, name: string, permissions: string[]) =>
      request<AdminRole>(`/roles/${encodeURIComponent(code)}`, json('PUT', { name, permissions })),
    remove: (code: string) => request<void>(`/roles/${encodeURIComponent(code)}`, { method: 'DELETE' }),
    assignments: (id: number) => request<{ items: AdminAssignment[] }>(`/employees/${id}/roles`),
    effective: (id: number) => request<{ active: boolean; capabilities: EmployeeCapabilities; items: EffectivePermission[]; model_items: EffectiveModelPermission[] }>(`/employees/${id}/effective-permissions`),
    audit: (before?: number) => request<{ items: AuthorizationAudit[]; next_before: number | null }>(
      before === undefined ? '/authorization-audit' : `/authorization-audit?before=${before}`,
    ),
    assign: (id: number, items: AdminAssignment[]) =>
      request<{ items: AdminAssignment[] }>(`/employees/${id}/roles`, json('PUT', { items })),
  },
  groups: {
    list: () => request<{ items: UserGroup[] }>('/user-groups'),
    save: ({ id, ...body }: UserGroup) => id
      ? request<UserGroup>(`/user-groups/${id}`, json('PUT', body))
      : request<UserGroup>('/user-groups', json('POST', body)),
    remove: (id: number) => request<void>(`/user-groups/${id}`, { method: 'DELETE' }),
  },
  employees: {
    list: (q: string, page = 1, pageSize = 50) => request<{ items: Employee[]; total: number }>(`/employees?q=${encodeURIComponent(q)}&page=${page}&page_size=${pageSize}`),
    create: (payload: { username: string; display_name: string; department?: string | null; role?: Employee['role']; password: string; assignments?: AdminAssignment[] }) =>
      request<Employee>('/employees', json('POST', payload)),
    patch: (id: number, payload: { display_name?: string; department?: string | null; role?: Employee['role']; assignments?: AdminAssignment[] }) =>
      request<Employee>(`/employees/${id}`, json('PATCH', payload)),
    setStatus: (id: number, status: 0 | 1) => request<Employee>(`/employees/${id}/status`, json('POST', { status })),
    resetPassword: (id: number, password: string) =>
      request<void>(`/employees/${id}/password`, json('POST', { password })),
  },
  channels: {
    list: () => request<{ items: ModelChannel[] }>('/channels'),
    create: (body: ChannelPayload & { api_key: string }) => request<ModelChannel>('/channels', json('POST', body)),
    patch: (id: number, body: ChannelPayload & { api_key?: string }) =>
      request<ModelChannel>(`/channels/${id}`, json('PATCH', body)),
    discover: (id: number) => request<{ supported: boolean; items: string[] }>(`/channels/${id}/discover`, { method: 'POST' }),
    importModels: (id: number, models: string[]) =>
      request<{ items: ModelView[]; skipped: string[] }>(`/channels/${id}/models`, json('POST', { models })),
  },
  models: {
    delegations: (id: number) => request<{ revision: number; items: ModelDelegation[]; operations: { code: string; name: string }[] }>(`/models/${id}/delegations`),
    saveDelegations: (id: number, revision: number, upsert: ModelDelegation[], remove: ModelDelegationSubject[]) =>
      request<{ revision: number; items: ModelDelegation[] }>(`/models/${id}/delegations`, json('PATCH', { revision, upsert, remove })),
    list: () => request<{ items: ModelView[]; upstream_kinds: string[] }>('/models'),
    patch: (id: number, payload: Partial<ModelPayload> & { api_key?: string }) =>
      request<ModelView>(`/models/${id}`, json('PATCH', payload)),
    setStatus: (id: number, status: 0 | 1) =>
      request<ModelView>(`/models/${id}/status`, json('POST', { status })),
    grants: (id: number) =>
      request<{ model_id: number; grants: Grant[] }>(`/models/${id}/grants`),
    replaceGrants: (id: number, grants: Grant[]) =>
      request<{ model_id: number; grants: Grant[] }>(`/models/${id}/grants`, json('PUT', { grants })),
  },
  creditRules: {
    list: () => request<{ items: CreditRule[] }>('/credit-rules'),
    create: (payload: CreditRulePayload) => request<CreditRule>('/credit-rules', json('POST', payload)),
    remove: (id: number) => request<void>(`/credit-rules/${id}`, { method: 'DELETE' }),
  },
  usage: {
    summary: (month: string, page: number, pageSize: number) => {
      const params = new URLSearchParams({ month, page: String(page), page_size: String(pageSize) })
      return request<{ month: string; items: SummaryRow[]; totals: { people: number; used: number; unknown: number } }>(`/usage/summary?${params}`)
    },
    employees: (month: string, query: string) => {
      const params = new URLSearchParams({ month, q: query })
      return request<{ items: Pick<SummaryRow, 'user_id' | 'display_name'>[] }>(`/usage/employees?${params}`)
    },
    calls: (params: {
      month: string
      page?: number
      page_size?: number
      user_id?: number
      model_id?: number
      status?: string
    }) => {
      const search = new URLSearchParams({ month: params.month })
      if (params.page !== undefined) search.set('page', String(params.page))
      if (params.page_size !== undefined) search.set('page_size', String(params.page_size))
      if (params.user_id !== undefined) search.set('user_id', String(params.user_id))
      if (params.model_id !== undefined) search.set('model_id', String(params.model_id))
      if (params.status !== undefined && params.status !== '') search.set('status', params.status)
      return request<{ month: string; total: number; items: CallRow[] }>(`/usage/calls?${search.toString()}`)
    },
  },
}

export async function listAllEmployees(): Promise<Employee[]> {
  const pageSize = 200
  const first = await api.employees.list('', 1, pageSize)
  const items = [...first.items]
  for (let page = 2; page <= Math.ceil(first.total / pageSize); page += 1) {
    items.push(...(await api.employees.list('', page, pageSize)).items)
  }
  return items
}

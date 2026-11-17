import { describe, expect, it } from 'vitest'
import { ModelDeskApiError, ModelDeskPlatform, normalizeBaseUrl, toSignedIn, validateAuthorizeUrl } from '../src/platform.ts'

const tokenWire = {
  token_type: 'Bearer' as const,
  access_token: 'at_1',
  expires_in: 600,
  refresh_token: 'rt_1',
  refresh_expires_in: 2_592_000,
  session_id: 'gsess_01',
  session_expires_at: '2026-12-09T02:00:00Z',
  user: { id: '1001', username: 'zhang.san', display_name: '张三', department: '剪辑部' },
  org: { id: 'modeldesk', name: '示例组织' },
}

describe('normalizeBaseUrl', () => {
  it('accepts https origins and drops the trailing slash', () => {
    expect(normalizeBaseUrl('https://modeldesk.example.com/')).toBe('https://modeldesk.example.com')
  })

  it('defaults a bare host to https', () => {
    expect(normalizeBaseUrl('modeldesk.example.com')).toBe('https://modeldesk.example.com')
  })

  it('rejects http on a public host', () => {
    expect(() => normalizeBaseUrl('http://modeldesk.example.com')).toThrow(ModelDeskApiError)
  })

  it('allows http on loopback for development', () => {
    expect(normalizeBaseUrl('http://127.0.0.1:8080')).toBe('http://127.0.0.1:8080')
  })

  it('rejects paths, credentials, queries and fragments', () => {
    for (const bad of [
      'https://modeldesk.example.com/api',
      'https://user:pass@modeldesk.example.com',
      'https://modeldesk.example.com/?x=1',
      'https://modeldesk.example.com/#login',
    ]) {
      expect(() => normalizeBaseUrl(bad)).toThrow(ModelDeskApiError)
    }
  })
})

describe('toSignedIn', () => {
  it('maps wire fields and computes expiry instants', () => {
    const before = Date.now()
    const signed = toSignedIn('https://modeldesk.example.com', tokenWire)
    expect(signed.user.displayName).toBe('张三')
    expect(signed.user.department).toBe('剪辑部')
    expect(signed.accessExpiresAt).toBeGreaterThanOrEqual(before + 600_000)
    expect(signed.absoluteExpiresAt).toBe(Date.parse('2026-12-09T02:00:00Z'))
    expect(signed.models).toEqual([])
  })

  it('keeps a previous catalog across a refresh', () => {
    const first = toSignedIn('https://modeldesk.example.com', tokenWire)
    const withCatalog = {
      ...first,
      models: [{ id: 'modeldesk:7', displayName: 'qwen-max', contextWindow: 131072, capabilities: { streaming: true, tools: true, reasoningContent: false } }],
      modelsFetchedAt: 1,
    }
    const second = toSignedIn('https://modeldesk.example.com', tokenWire, withCatalog)
    expect(second.models).toHaveLength(1)
    expect(second.modelsFetchedAt).toBe(1)
  })

  it('rejects an unparseable session expiry', () => {
    expect(() => toSignedIn('https://modeldesk.example.com', { ...tokenWire, session_expires_at: 'not-a-date' })).toThrow(ModelDeskApiError)
  })
})

describe('validateAuthorizeUrl', () => {
  it('accepts the platform login page with the matching transaction', () => {
    expect(validateAuthorizeUrl('https://modeldesk.example.com', 'https://modeldesk.example.com/desktop-login?auth_id=gtx_01', 'gtx_01'))
      .toBe('https://modeldesk.example.com/desktop-login?auth_id=gtx_01')
  })

  it('rejects another origin, another path, and a missing auth_id', () => {
    expect(() => validateAuthorizeUrl('https://modeldesk.example.com', 'https://evil.example/desktop-login?auth_id=gtx_01', 'gtx_01')).toThrow(ModelDeskApiError)
    expect(() => validateAuthorizeUrl('https://modeldesk.example.com', 'https://modeldesk.example.com/elsewhere?auth_id=gtx_01', 'gtx_01')).toThrow(ModelDeskApiError)
    expect(() => validateAuthorizeUrl('https://modeldesk.example.com', 'https://modeldesk.example.com/desktop-login', 'gtx_01')).toThrow(ModelDeskApiError)
  })
})

describe('enterprise MCP wire contract', () => {
  const catalog = { items: [{
    id: 1, name: 'Ticket desk', description: '内部工单系统', guide: '先查询再创建。', revision: 2,
    tools: [{ name: 'search_tickets', description: 'Search', input_schema: { type: 'object' }, access: 'read' }],
  }] }

  function platformResponding(body: unknown, requests: { url: string; init: RequestInit }[] = []) {
    const fetchImpl: typeof fetch = async (input, init) => {
      requests.push({ url: input instanceof Request ? input.url : String(input), init: init ?? {} })
      return Response.json(body)
    }
    return { platform: new ModelDeskPlatform('https://modeldesk.example.com', { fetchImpl }), requests }
  }

  it('fetches the authorized catalog with the bearer token', async () => {
    const { platform, requests } = platformResponding(catalog)
    const servers = await platform.fetchMcpServers('at_1')
    expect(servers).toEqual(catalog.items)
    expect(requests[0]?.url).toBe('https://modeldesk.example.com/api/v1/modeldesk/mcp/servers')
    expect((requests[0]?.init.headers as Record<string, string>).authorization).toBe('Bearer at_1')
  })

  it('accepts a call result without structured_content', async () => {
    const { platform, requests } = platformResponding({ content: [{ type: 'text', text: 'TICKET-42' }], is_error: false })
    const result = await platform.callMcpTool('at_1', 1, 'search_tickets', { q: '发票' }, new AbortController().signal)
    expect(result).toEqual({ content: [{ type: 'text', text: 'TICKET-42' }], is_error: false })
    expect(requests[0]?.url).toBe('https://modeldesk.example.com/api/v1/modeldesk/mcp/servers/1/call')
    expect(requests[0]?.init.method).toBe('POST')
    expect(JSON.parse(requests[0]?.init.body as string)).toEqual({ tool: 'search_tickets', arguments: { q: '发票' } })
  })

  it('keeps structured_content when the upstream tool returns it', async () => {
    const { platform } = platformResponding({ content: [], is_error: false, structured_content: { ok: true } })
    const result = await platform.callMcpTool('at_1', 1, 'create_ticket', {}, new AbortController().signal)
    expect(result.structured_content).toEqual({ ok: true })
  })

  it('rejects a call result that violates the contract', async () => {
    const { platform } = platformResponding({ content: 'not-an-array', is_error: false })
    await expect(platform.callMcpTool('at_1', 1, 'search_tickets', {}, new AbortController().signal))
      .rejects.toMatchObject({ code: 'invalid_response' })
  })
})

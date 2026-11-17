import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { PreToolDecision, ToolExecution, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { EnterpriseMcpToolSync, publicToolName, registerMcpTools } from '../src/mcp-tools.ts'
import type { ModelDeskMcpServer } from '../src/types.ts'

describe('publicToolName', () => {
  it('keeps clean names verbatim and hashes lossy normalization', () => {
    expect(publicToolName('modeldesk-1', 'search_tickets')).toBe('mcp__modeldesk-1__search_tickets')
    const lossy = publicToolName('modeldesk-1', '搜索工单')
    expect(lossy.startsWith('mcp__modeldesk-1__')).toBe(true)
    expect(lossy).toMatch(/_[a-f0-9]{12}$/)
    expect(lossy.length).toBeLessThanOrEqual(64)
    expect(publicToolName('modeldesk-1', '搜索工单')).toBe(lossy)
    expect(publicToolName('modeldesk-2', '搜索工单')).not.toBe(lossy)
    const long = publicToolName('modeldesk-1', 'x'.repeat(120))
    expect(long.length).toBeLessThanOrEqual(64)
    expect(long).not.toBe(publicToolName('modeldesk-1', `${'x'.repeat(119)}y`))
  })
})

const server: ModelDeskMcpServer = {
  id: 1, name: '工单系统', description: '内部工单', guide: '先搜索再查看。', revision: 3,
  tools: [
    { name: 'search_tickets', description: 'Search tickets', input_schema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] }, access: 'read' },
    { name: 'create_ticket', description: 'Create a ticket', input_schema: { type: 'object', properties: { title: { type: 'string' } } }, access: 'write' },
  ],
}

function execution(name: string): ToolExecution {
  return {
    callId: 'call-1', rootCallId: 'call-1', name, arguments: {},
    signal: new AbortController().signal, token: Symbol('exec'),
  } as unknown as ToolExecution
}

describe('enterprise MCP tool sync', () => {
  it('registers open tools, gates writes, proxies calls, and revokes on catalog changes', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    let catalog: readonly ModelDeskMcpServer[] = [server]
    let failure: Error | undefined
    const calls: { serverId: number; tool: string; args: Record<string, unknown> }[] = []
    const session = {
      mcpServers: async () => {
        if (failure !== undefined) throw failure
        return catalog
      },
      callMcpTool: async (serverId: number, tool: string, args: Record<string, unknown>) => {
        calls.push({ serverId, tool, args })
        return tool === 'boom'
          ? { content: [{ type: 'text', text: 'upstream exploded' }], is_error: true }
          : { content: [{ type: 'text', text: `result of ${tool}` }], is_error: false, structured_content: { ok: true } }
      },
    }
    const sync = registerMcpTools(ctx, session)
    const names = () => ctx.tools.schemas().map(schema => schema.name).sort()
    const gate = (name: string) => sync.gate(execution(name), () => Promise.resolve<PreToolDecision>({ kind: 'allow' }))
    try {
      await sync.refresh()
      expect(names()).toEqual([
        'list_enterprise_mcp_services', 'mcp__modeldesk-1__create_ticket', 'mcp__modeldesk-1__search_tickets',
      ])
      expect((await gate('mcp__modeldesk-1__search_tickets')).kind).toBe('allow')
      const ask = await gate('mcp__modeldesk-1__create_ticket')
      expect(ask.kind).toBe('ask')
      expect(ask.kind === 'ask' && ask.displayReason?.zh).toContain('create_ticket')
      expect((await gate('unknown_tool')).kind).toBe('allow')

      const definitions = new Map(ctx.tools.definitions().map(definition => [definition.name, definition]))
      const read = definitions.get('mcp__modeldesk-1__search_tickets')
      expect(read?.parameters).toEqual(server.tools[0]!.input_schema)
      const value = await read!.execute({ q: '发票' }, { signal: new AbortController().signal } as ToolRunContext)
      expect(value).toEqual({ content: [{ type: 'text', text: 'result of search_tickets' }], structured_content: { ok: true } })
      expect(read!.output.render({}, z.json().parse(value))).toEqual([{ type: 'text', text: 'result of search_tickets' }])
      expect(calls).toEqual([{ serverId: 1, tool: 'search_tickets', args: { q: '发票' } }])

      const list = definitions.get('list_enterprise_mcp_services')
      const listing = await list!.execute({}, { signal: new AbortController().signal } as ToolRunContext) as {
        items: { guide: string; tools: { tool_name: string; access: string }[] }[]
      }
      expect(listing.items[0]!.guide).toBe('先搜索再查看。')
      expect(listing.items[0]!.tools.map(tool => tool.tool_name)).toEqual([
        'mcp__modeldesk-1__search_tickets', 'mcp__modeldesk-1__create_ticket',
      ])

      // A failed catalog read keeps the last confirmed generation.
      failure = new Error('network down')
      await sync.refresh()
      expect(names()).toHaveLength(3)
      failure = undefined

      // Revocation: the write tool disappears and its gate entry with it.
      catalog = [{ ...server, revision: 4, tools: [server.tools[0]!] }]
      await sync.refresh()
      expect(names()).toEqual(['list_enterprise_mcp_services', 'mcp__modeldesk-1__search_tickets'])
      expect((await gate('mcp__modeldesk-1__create_ticket')).kind).toBe('allow')

      // Signing out yields an empty catalog and removes every proxied tool.
      catalog = []
      await sync.refresh()
      expect(names()).toEqual(['list_enterprise_mcp_services'])
    } finally {
      await sync.close()
      await ctx.fiber.dispose()
    }
  })

  it('surfaces upstream isError results as tool failures', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    const boom: ModelDeskMcpServer = {
      ...server,
      tools: [{ name: 'boom', description: '', input_schema: { type: 'object' }, access: 'read' }],
    }
    const sync = new EnterpriseMcpToolSync(ctx, {
      mcpServers: async () => [boom],
      callMcpTool: async () => ({ content: [{ type: 'text', text: 'upstream exploded' }], is_error: true }),
    })
    try {
      await sync.refresh()
      const definition = ctx.tools.definitions().find(item => item.name === 'mcp__modeldesk-1__boom')
      await expect(definition!.execute({}, { signal: new AbortController().signal } as ToolRunContext))
        .rejects.toThrow('upstream exploded')
    } finally {
      await sync.close()
      await ctx.fiber.dispose()
    }
  })
})

/**
 * Enterprise MCP tools: discovers the employee's authorized services through
 * the platform proxy and registers each open tool under a stable public name.
 * The platform holds every upstream credential and re-authorizes each call;
 * write tools additionally require interactive approval and fail closed when
 * no approval channel is composed.
 * @module @modeldesk/dsh-enterprise/mcp-tools
 */
import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { PreToolDecision, ToolDefinition, ToolExecution } from '@deepseek-ai/dsh-tools'
import type { ModelDeskSession } from './session.ts'
import type { ModelDeskMcpServer, ModelDeskMcpTool } from './types.ts'

type McpSession = Pick<ModelDeskSession, 'mcpServers' | 'callMcpTool'>

/** DeepSeek function-name contract, identical to the local MCP bridge. */
const MAX_PUBLIC_NAME_LENGTH = 64
const INVALID_NAME_CHARS = /[^A-Za-z0-9_-]/g
const HASH_LENGTH = 12

/**
 * Model-facing name for one enterprise MCP tool: `mcp__modeldesk-<id>__<rawName>`,
 * normalized to the function-name contract with an identity hash on lossy
 * normalization so distinct tools never collapse into one name.
 * @param serverName - Identifier or name used to scope the public tool.
 * @param rawName - Name exposed by the upstream MCP service.
 * @returns A provider-compatible, namespaced tool name.
 */
export function publicToolName(serverName: string, rawName: string): string {
  const joined = `mcp__${serverName}__${rawName}`
  const normalized = joined.replace(INVALID_NAME_CHARS, '_')
  if (normalized === joined && normalized.length <= MAX_PUBLIC_NAME_LENGTH) return normalized
  const hash = createHash('sha256').update(`${serverName}\0${rawName}`).digest('hex').slice(0, HASH_LENGTH)
  return `${normalized.slice(0, MAX_PUBLIC_NAME_LENGTH - HASH_LENGTH - 1)}_${hash}`
}

/** Project proxied MCP content blocks into model-visible text. */
function resultText(content: readonly Record<string, unknown>[], toolName: string): string {
  const parts: string[] = []
  for (const block of content) {
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    else if (typeof block.type === 'string') parts.push(`[unsupported MCP content type: ${block.type}]`)
  }
  return parts.length > 0 ? parts.join('\n') : `(${toolName} returned no model-visible content)`
}

function mcpToolDefinition(server: ModelDeskMcpServer, tool: ModelDeskMcpTool, name: string, session: McpSession): ToolDefinition {
  const description = [
    tool.description,
    `Enterprise MCP service "${server.name}" (id ${server.id}), called through the company platform.`,
    ...tool.access === 'write' ? ['This tool may modify enterprise data and requires user approval before it runs.'] : [],
  ].filter(part => part.length > 0).join('\n')
  return {
    name,
    description,
    parameters: tool.input_schema,
    output: {
      schema: {
        type: 'object',
        properties: { content: { type: 'array', items: {} }, structured_content: {} },
        required: ['content'],
        additionalProperties: false,
      },
      render: (_args: unknown, value: unknown) => [{
        type: 'text',
        text: resultText((value as { content: readonly Record<string, unknown>[] }).content, tool.name),
      }],
    },
    execute: async (args: unknown, exec) => {
      const argsObject = typeof args === 'object' && args !== null && !Array.isArray(args)
        ? args as Record<string, unknown>
        : {}
      const result = await session.callMcpTool(server.id, tool.name, argsObject, exec.signal)
      if (result.is_error) throw new Error(resultText(result.content, tool.name))
      return {
        content: result.content,
        ...result.structured_content === undefined ? {} : { structured_content: result.structured_content },
      }
    },
  }
}

/**
 * Keeps the registered tool generation in sync with the platform catalog.
 * A failed catalog read keeps the last confirmed generation: every call is
 * re-authorized by the platform anyway, and signing out yields an empty
 * catalog, which removes all tools.
 */
export class EnterpriseMcpToolSync {
  private readonly disposers = new Map<string, () => void>()
  private writeTools = new Map<string, { server: string; tool: string }>()
  private fingerprint = ''
  private running: Promise<void> | undefined
  private pending: boolean = false
  private closed: boolean = false

  constructor(private readonly ctx: Context, private readonly session: McpSession) {}

  /**
   * Reconcile the registered tools with the employee's current MCP catalog.
   */
  refresh(): Promise<void> {
    if (this.closed) return Promise.resolve()
    this.pending = true
    return this.running ??= this.drain().finally(() => { this.running = undefined })
  }

  /**
   * Stop synchronization and unregister the managed MCP tools.
   */
  async close(): Promise<void> {
    this.closed = true
    try { await this.running } finally { this.clear() }
  }

  /**
   * Pre-execute gate: write tools ask for approval, everything else passes.
   * @param exec - Executes the confirmed tool request.
   * @param next - Replacement credential record.
   * @returns The PreToolDecision result.
   */
  async gate(exec: ToolExecution, next: () => Promise<PreToolDecision>): Promise<PreToolDecision> {
    const write = this.writeTools.get(exec.name)
    if (write === undefined) return next()
    return {
      kind: 'ask',
      reason: `Enterprise MCP write tool "${write.tool}" on service "${write.server}"`,
      displayReason: {
        en: `Run enterprise MCP tool "${write.tool}" (service: ${write.server})? It may modify enterprise data.`,
        zh: `是否运行企业 MCP 工具「${write.tool}」（服务：${write.server}）？该工具可能修改企业数据。`,
      },
    }
  }

  private async drain(): Promise<void> {
    while (this.pending && !this.closed) {
      this.pending = false
      try {
        const servers = await this.session.mcpServers()
        // oxlint-disable-next-line typescript/no-unnecessary-condition -- refresh()/close() mutate these flags on other call paths
        if (!this.closed && !this.pending) this.apply(servers)
      } catch (error) {
        this.ctx.logger.warn('Enterprise MCP catalog update failed: %s', error instanceof Error ? error.message : String(error))
      }
    }
  }

  private apply(servers: readonly ModelDeskMcpServer[]): void {
    const fingerprint = JSON.stringify(servers)
    if (fingerprint === this.fingerprint) return
    const definitions = new Map<string, ToolDefinition>()
    const writes = new Map<string, { server: string; tool: string }>()
    for (const server of servers) {
      const serverName = `modeldesk-${server.id}`
      for (const tool of server.tools) {
        const name = publicToolName(serverName, tool.name)
        if (definitions.has(name)) continue
        definitions.set(name, mcpToolDefinition(server, tool, name, this.session))
        if (tool.access === 'write') writes.set(name, { server: server.name, tool: tool.name })
      }
    }
    for (const dispose of this.disposers.values()) dispose()
    this.disposers.clear()
    try {
      for (const [name, definition] of definitions) this.disposers.set(name, this.ctx.tools.register(definition))
    } catch (error) {
      for (const dispose of this.disposers.values()) dispose()
      this.disposers.clear()
      this.writeTools = new Map()
      this.fingerprint = ''
      throw error
    }
    this.writeTools = writes
    this.fingerprint = fingerprint
  }

  private clear(): void {
    for (const dispose of this.disposers.values()) dispose()
    this.disposers.clear()
    this.writeTools = new Map()
    this.fingerprint = ''
  }
}

const listOutput = {
  schema: { type: 'json' } as const,
  render: (_args: unknown, value: unknown): [{ type: 'text'; text: string }] =>
    [{ type: 'text', text: JSON.stringify(value) }],
}

/**
 * Register the catalog tool, the approval gate, and the periodic sync.
 * @param ctx - Host context that owns the registered tools.
 * @param session - Session used to authenticate requests to the server.
 * @returns The EnterpriseMcpToolSync result.
 */
export function registerMcpTools(ctx: Context, session: McpSession): EnterpriseMcpToolSync {
  const sync = new EnterpriseMcpToolSync(ctx, session)
  ctx.effect(() => {
    const disposeGate = ctx.on('tools/pre-execute', (exec, next) => sync.gate(exec, next))
    const disposeList = ctx.tools.register(defineTool({
      name: 'list_enterprise_mcp_services',
      description: 'List the enterprise MCP services available to the signed-in employee, each with its usage guide and open tools (public tool names included). Call this when unsure which service or tool fits a task, and follow the returned guide. Tools named mcp__modeldesk-* are already callable directly.',
      parameters: {},
      output: listOutput,
      execute: async (_args, { signal }) => {
        const servers = await session.mcpServers(signal)
        return {
          items: servers.map(server => ({
            id: server.id, name: server.name, description: server.description, guide: server.guide,
            tools: server.tools.map(tool => ({
              name: tool.name,
              tool_name: publicToolName(`modeldesk-${server.id}`, tool.name),
              description: tool.description,
              access: tool.access,
            })),
          })),
        }
      },
    }))
    void sync.refresh()
    const timer = setInterval(() => { void sync.refresh() }, 30_000)
    timer.unref()
    return async () => {
      clearInterval(timer)
      disposeGate()
      disposeList()
      await sync.close()
    }
  }, 'modeldesk: enterprise MCP tools')
  return sync
}

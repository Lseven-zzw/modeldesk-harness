import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-credentials'
import { LlmAdapter, ToolCallId, type GenerateOptions, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SESSION_KEY } from '../../src/credentials.ts'

export const name = 'modeldesk-document-fixture'
export const inject = ['credentials', 'llm']

const tools = [
  ['search_enterprise_documents', { query: 'travel' }],
  ['read_enterprise_document', { id: 7, revision: 2 }],
  ['read_enterprise_document', { id: 7, revision: 2, offset: 4_000 }],
  ['read_enterprise_document', { id: 7, revision: 2 }],
] as const

class FixtureAdapter extends LlmAdapter {
  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return { provider, id: model, name: model }
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const results = options.messages.filter(message => message.role === 'tool')
    const call = tools[results.length]
    if (call) {
      const [name, args] = call
      const id = ToolCallId(`document-call-${results.length}`)
      const input = JSON.stringify(args)
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: input }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: input } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    const text = results.flatMap(result => result.content)
      .filter(block => block.type === 'text').map(block => block.text).join('\n')
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

export async function apply(ctx: Context) {
  const expires = Date.now() + 600_000
  await ctx.credentials.modifyRecord(SESSION_KEY, async () => ({
    kind: 'grant',
    payload: {
      version: 1, baseUrl: process.env.MODELDESK_TEST_PLATFORM, sessionId: 'document-fixture',
      accessToken: 'employee-fixture-token', refreshToken: 'refresh-fixture-token',
      accessExpiresAt: expires, refreshExpiresAt: expires, absoluteExpiresAt: expires,
      user: { id: '1', username: 'employee', displayName: 'Employee', department: 'finance' },
      org: { id: 'example', name: 'Example' }, models: [], modelsFetchedAt: 0,
    },
  }))
  ctx.llm.registerAdapter(['modeldesk-document-fixture'], new FixtureAdapter())
}

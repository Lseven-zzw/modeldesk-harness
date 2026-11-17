import { expect, it } from 'vitest'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { ModelDeskAdapter } from '../src/adapter.ts'

it('lists the employee model and preserves streamed tool arguments and trailing usage', async () => {
  const model = {
    id: 'modeldesk:model:42', displayName: '企业模型', contextWindow: 65536,
    capabilities: { streaming: true, tools: true, reasoningContent: true },
  }
  const adapter = new ModelDeskAdapter({
    models: async () => [model],
    complete: async (body) => {
      expect(body).toMatchObject({ model: model.id, stream: true, stream_options: { include_usage: true } })
      const frames = [
        { choices: [{ delta: { reasoning_content: '思考' } }] },
        { choices: [{ delta: { content: '你好', tool_calls: [{ index: 0, id: 'call_1', function: { name: 'lookup', arguments: '{"q":' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"x"}' } }] }, finish_reason: 'tool_calls' }] },
        { choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, prompt_tokens_details: { cached_tokens: 3 } } },
      ]
      return new Response(frames.map(frame => 'data: ' + JSON.stringify(frame) + '\n\n').join('') + 'data: [DONE]\n\n').body!
    },
  })
  expect(await adapter.listModels('modeldesk')).toEqual([{
    provider: 'modeldesk', id: model.id, name: model.displayName, inputModalities: ['text'],
  }])
  const chunks: StreamChunk[] = []
  for await (const chunk of adapter.stream({
    provider: 'modeldesk', model: model.id, messages: [{ role: 'user', content: [{ type: 'text', text: '查一下' }] }],
    tools: [{ name: 'lookup', description: 'Search', parameters: { type: 'object' } }],
  })) chunks.push(chunk)
  expect(chunks).toContainEqual({ type: 'tool-call-delta', index: 2, id: 'call_1', argumentsDelta: '"x"}' })
  expect(chunks).toContainEqual({ type: 'block-end', index: 2, block: {
    type: 'tool-call', id: 'call_1', name: 'lookup', arguments: '{"q":"x"}',
  } })
  expect(chunks.slice(-2)).toEqual([
    { type: 'usage', usage: { inputTokens: 7, outputTokens: 5, totalTokens: 15, cacheReadTokens: 3 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ])
})

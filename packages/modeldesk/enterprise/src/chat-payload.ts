import { LlmError } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, RequestMessage } from '@deepseek-ai/dsh-llm'
import type { ModelDeskModel } from './types.ts'

/**
 * Serialize the Harness request into the gateway's Chat Completions contract.
 * @param options - Conversation input and invocation options.
 * @param model - Authorized model selected for the request.
 * @returns The gateway-compatible Chat Completions payload.
 */
export function chatPayload(options: GenerateOptions<string>, model: ModelDeskModel): Record<string, unknown> {
  if (options.reasoningEffort !== undefined) throw new LlmError('企业模型由平台控制推理模式', 'UNSUPPORTED_OPTION')
  const tools = model.capabilities.tools ? options.tools : undefined
  const messages = options.messages.map(message => chatMessage(message, model))
  if (options.system !== undefined) messages.unshift({ role: 'system', content: options.system })
  return {
    model: model.id,
    messages,
    stream: model.capabilities.streaming,
    ...(model.capabilities.streaming ? { stream_options: { include_usage: true } } : {}),
    ...(tools?.length ? { tools: tools.map(({ name, description, parameters }) => ({
      type: 'function', function: { name, description, parameters },
    })) } : {}),
    ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
    ...(options.maxTokens === undefined ? {} : { max_tokens: options.maxTokens }),
    ...(options.stop === undefined ? {} : { stop: options.stop }),
  }
}

function chatMessage(message: RequestMessage, model: ModelDeskModel): Record<string, unknown> {
  const text: string[] = []
  const reasoning: string[] = []
  const calls = []
  for (const block of message.content) {
    switch (block.type) {
      case 'text': text.push(block.text); break
      case 'reasoning': reasoning.push(block.text); break
      case 'tool-call': calls.push({
        id: block.id, type: 'function', function: { name: block.name, arguments: block.arguments },
      }); break
      default: throw new LlmError('企业模型暂不支持此消息内容', 'UNSUPPORTED_OPTION')
    }
  }
  if (message.role === 'tool') return { role: 'tool', tool_call_id: message.toolCallId, content: text.join('') }
  if (message.role !== 'assistant') return { role: message.role, content: text.join('') }
  return {
    role: 'assistant',
    content: text.length === 0 && calls.length > 0 ? null : text.join(''),
    ...(calls.length > 0 ? { tool_calls: calls } : {}),
    ...(reasoning.length > 0 && model.capabilities.reasoningContent && message.source.provider === 'modeldesk'
      && message.source.model === model.id ? { reasoning_content: reasoning.join('') } : {}),
  }
}

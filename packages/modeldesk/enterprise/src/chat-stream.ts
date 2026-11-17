import { LlmError, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { FinishReason, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import { EventSourceParserStream } from 'eventsource-parser/stream'
import { z } from 'zod'
import { ModelDeskApiError } from './platform.ts'

const tokens = z.number().int().nonnegative()
const frameSchema = z.object({
  error: z.object({ code: z.string(), message: z.string() }).optional(),
  choices: z.array(z.object({
    delta: z.object({
      content: z.string().nullish(),
      reasoning_content: z.string().nullish(),
      refusal: z.string().nullish(),
      tool_calls: z.array(z.object({
        index: tokens.optional(),
        id: z.string().min(1).nullish(),
        function: z.object({ name: z.string().nullish(), arguments: z.string().nullish() }).optional(),
      })).nullish(),
    }).optional(),
    finish_reason: z.string().nullish(),
  })).optional(),
  usage: z.object({
    prompt_tokens: tokens, completion_tokens: tokens, total_tokens: tokens.optional(),
    prompt_tokens_details: z.object({ cached_tokens: tokens.optional() }).nullish(),
    completion_tokens_details: z.object({ reasoning_tokens: tokens.optional() }).nullish(),
  }).nullish(),
  request_id: z.string().optional(),
})

type Block =
  | { type: 'text' | 'reasoning'; text: string }
  | { type: 'tool-call'; id: ToolCallId; name: string; arguments: string }

/**
 * Translate both gateway response modes into the Harness streaming protocol.
 * @param body - Request or response body for the model gateway.
 * @param streaming - Whether the response uses event-stream framing.
 * @returns The response parsed into Harness stream events.
 */
export async function* translateChat(body: ReadableStream<BufferSource>, streaming = true): AsyncGenerator<StreamChunk> {
  const blocks: Block[] = []
  const textIndices = new Map<'text' | 'reasoning', number>()
  const toolIndices = new Map<number, number>()
  let finish: FinishReason | undefined
  let usage: TokenUsage | undefined
  let complete = !streaming
  for await (const raw of chatFrames(body, streaming)) {
    if (raw === '[DONE]') {
      complete = true
      break
    }
    const parsed = frameSchema.safeParse(raw)
    if (!parsed.success) throw malformed()
    const frame = parsed.data
    if (frame.error !== undefined) throw new ModelDeskApiError(frame.error.message, frame.error.code, { requestId: frame.request_id })
    if (frame.usage != null) usage = toUsage(frame.usage)
    for (const choice of frame.choices ?? []) {
      if (choice.finish_reason != null) finish = finishReason(choice.finish_reason)
      const delta = choice.delta
      const textParts = [
        ['reasoning', delta?.reasoning_content],
        ['text', (delta?.content ?? '') + (delta?.refusal ?? '')],
      ] as const
      for (const [type, text] of textParts) {
        if (!text) continue
        let index = textIndices.get(type)
        if (index === undefined) {
          index = blocks.length
          textIndices.set(type, index)
          blocks.push({ type, text: '' })
          yield { type: 'block-start', index, blockType: type }
        }
        const block = blocks[index]
        if (block === undefined || block.type === 'tool-call') throw malformed()
        block.text += text
        yield type === 'text' ? { type: 'text-delta', index, text } : { type: 'reasoning-delta', index, text }
      }
      for (const [position, tool] of (delta?.tool_calls ?? []).entries()) {
        if (streaming && tool.index === undefined) throw malformed()
        const slot = tool.index ?? position
        let index = toolIndices.get(slot)
        if (index === undefined) {
          if (tool.id == null) throw malformed()
          index = blocks.length
          toolIndices.set(slot, index)
          blocks.push({ type: 'tool-call', id: ToolCallId(tool.id), name: '', arguments: '' })
          yield { type: 'block-start', index, blockType: 'tool-call' }
        }
        const block = blocks[index]
        if (block?.type !== 'tool-call' || (tool.id != null && tool.id !== block.id)) throw malformed()
        const name = tool.function?.name ?? undefined
        const args = tool.function?.arguments ?? ''
        block.name += name ?? ''
        block.arguments += args
        yield { type: 'tool-call-delta', index, id: block.id, ...(name === undefined ? {} : { name }), argumentsDelta: args }
      }
    }
  }
  if (!complete || finish === undefined) throw malformed()
  for (const [index, block] of blocks.entries()) {
    if (block.type === 'tool-call' && block.name.length === 0) throw malformed()
    yield { type: 'block-end', index, block }
  }
  if (usage !== undefined) yield { type: 'usage', usage }
  yield { type: 'finish', reason: finish }
}

async function* chatFrames(body: ReadableStream<BufferSource>, streaming: boolean): AsyncGenerator {
  if (!streaming) {
    const raw: unknown = await new Response(body).json().catch(() => { throw malformed() })
    const parsed = z.object({
      choices: z.array(z.object({ message: z.unknown(), finish_reason: z.string() })),
      usage: z.unknown(),
    }).safeParse(raw)
    if (!parsed.success) throw malformed()
    yield {
      choices: parsed.data.choices.map(choice => ({ delta: choice.message, finish_reason: choice.finish_reason })),
      usage: parsed.data.usage,
    }
    return
  }
  const events = body.pipeThrough(new TextDecoderStream()).pipeThrough(new EventSourceParserStream({ maxBufferSize: 1024 * 1024 }))
  for await (const { data } of events) {
    if (data === '[DONE]') yield data
    else {
      try { yield JSON.parse(data) as unknown } catch (error) {
        if (error instanceof SyntaxError) throw malformed()
        throw error
      }
    }
  }
}

function finishReason(reason: string): FinishReason {
  switch (reason) {
    case 'stop': return { kind: 'stop' }
    case 'tool_calls': return { kind: 'tool-calls' }
    case 'length': return { kind: 'max-tokens' }
    case 'content_filter': throw new LlmError('企业模型的回复被内容过滤器拦截', 'CONTENT_FILTER')
    default: throw malformed()
  }
}

function toUsage(usage: NonNullable<z.infer<typeof frameSchema>['usage']>): TokenUsage {
  const cached = Math.min(usage.prompt_tokens, usage.prompt_tokens_details?.cached_tokens ?? 0)
  const reasoning = usage.completion_tokens_details?.reasoning_tokens
  return {
    inputTokens: usage.prompt_tokens - cached,
    outputTokens: usage.completion_tokens,
    totalTokens: usage.total_tokens ?? usage.prompt_tokens + usage.completion_tokens,
    ...(cached === 0 ? {} : { cacheReadTokens: cached }),
    ...(reasoning === undefined ? {} : { reasoningTokens: reasoning }),
  }
}

function malformed(): LlmError {
  return new LlmError('企业模型返回了不完整或无效的回复', 'MALFORMED_RESPONSE')
}

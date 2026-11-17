import { LlmAdapter, LlmError, ProviderRequestId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmModelInfo, PreparedAdapterCall, StreamChunk } from '@deepseek-ai/dsh-llm'
import { ModelDeskApiError } from './platform.ts'
import { chatPayload } from './chat-payload.ts'
import { translateChat } from './chat-stream.ts'
import { resolveLibraryReferences } from './library-reference.ts'
import type { ModelDeskModel } from './types.ts'

/**
 * Identifier for the ModelDesk model provider.
 */
export const MODELDESK_PROVIDER = 'modeldesk'

interface Account {
  library?: { readDocument: Parameters<typeof resolveLibraryReferences>[1] }
  models(): Promise<readonly ModelDeskModel[]>
  complete(body: Record<string, unknown>, signal?: AbortSignal): Promise<ReadableStream<Uint8Array<ArrayBuffer>>>
}

/** Routes authorized model calls through the signed-in employee's platform. */
export class ModelDeskAdapter extends LlmAdapter {
  constructor(private readonly account: Account) { super() }

  override providerInfo(provider: string) { return { id: provider, name: 'ModelDesk Harness' } }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    try {
      return (await this.account.models()).map(model => this.describe(provider, model))
    } catch (error) {
      if (error instanceof ModelDeskApiError && ['signed_out', 'session_expired'].includes(error.code)) return []
      throw error
    }
  }

  /**
   * Resolve a model and its context window from the employee's authorized catalog.
   * @param id - Identifier of the requested resource.
   */
  override async resolveModel(provider: string, id: string, signal?: AbortSignal) {
    const model = await this.findModel(id, signal)
    return { ...this.describe(provider, model), context: { contextWindow: model.contextWindow } }
  }

  /**
   * Prepare an invocation for a model authorized by the employee's current session.
   * @param id - Identifier of the requested resource.
   */
  override async prepareCall(provider: string, id: string, signal?: AbortSignal): Promise<PreparedAdapterCall> {
    const model = await this.findModel(id, signal)
    return {
      model: { ...this.describe(provider, model), context: { contextWindow: model.contextWindow } },
      stream: options => this.generate(options, model),
    }
  }

  override async * stream(options: GenerateOptions<string>): AsyncGenerator<StreamChunk> {
    yield* this.generate(options, await this.findModel(options.model, options.signal))
  }

  private describe(provider: string, model: ModelDeskModel): LlmModelInfo {
    return { provider, id: model.id, name: model.displayName, inputModalities: ['text'] }
  }

  private async findModel(id: string, signal?: AbortSignal): Promise<ModelDeskModel> {
    signal?.throwIfAborted()
    try {
      const models = await this.account.models()
      signal?.throwIfAborted()
      const model = models.find(entry => entry.id === id)
      if (model === undefined) throw new LlmError('该企业模型不可用，请检查账号授权', 'UNKNOWN_MODEL')
      return model
    } catch (error) {
      throw mapError(error, signal)
    }
  }

  private async * generate(options: GenerateOptions<string>, model: ModelDeskModel): AsyncGenerator<StreamChunk> {
    const consumer = new AbortController()
    const signal = options.signal === undefined ? consumer.signal : AbortSignal.any([consumer.signal, options.signal])
    try {
      const library = this.account.library
      const messages = library === undefined ? options.messages : await Promise.all(options.messages.map(async message => {
        if (message.role !== 'user') return message
        return { ...message, content: await Promise.all(message.content.map(async block => {
          if (block.type !== 'text') return block
          try {
            return { ...block, text: await resolveLibraryReferences(block.text, library.readDocument.bind(library), signal) }
          } catch (error) {
            throw new LlmError(error instanceof Error ? error.message : '无法读取选中的资料', 'LIBRARY_REFERENCE_UNAVAILABLE')
          }
        })) }
      }))
      const response = await this.account.complete(chatPayload({ ...options, messages }, model), signal)
      yield* translateChat(response, model.capabilities.streaming)
    } catch (error) {
      throw mapError(error, signal)
    } finally {
      consumer.abort()
    }
  }
}

function mapError(error: unknown, signal?: AbortSignal): LlmError {
  if (signal?.aborted) return new LlmError('企业模型请求已取消', 'ABORTED')
  if (error instanceof LlmError) return error
  if (error instanceof ModelDeskApiError) {
    const { status, requestId } = error.details
    return new LlmError(error.message, error.code, {
      ...(status === undefined ? {} : { status }),
      ...(requestId ? { requestId: ProviderRequestId(requestId) } : {}),
    })
  }
  return new LlmError('企业模型连接中断', 'TRANSPORT')
}

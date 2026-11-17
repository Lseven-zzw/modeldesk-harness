/**
 * Remote surface of the enterprise account: reads and the five actions the
 * settings section needs. Every business failure is re-thrown as
 * `modeldesk/rejected` so the browser half reads one stable code instead of an
 * Error subclass it cannot import.
 * @module @modeldesk/dsh-enterprise/remote
 */
import type { Context } from '@deepseek-ai/cordis'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { ModelDeskApiError } from './platform.ts'
import type { DocumentLibrary, LibraryDocument, LibraryDocumentText, LibraryPage, ModelDeskCapabilities, EnterpriseView, ModelDeskUsage, LoginStartView } from './types.ts'

/** Re-throw one account failure as the wire failure. */
function rejected(error: unknown): never {
  if (error instanceof ModelDeskApiError) {
    throw new RemoteError('modeldesk/rejected', error.message, { code: error.code })
  }
  throw new RemoteError('gateway/internal', '企业账号操作失败', {})
}

/** Enterprise account commands and a reconnect-safe state stream. */
export class EnterpriseController extends TypertRemoteService {
  static inject = ['modeldeskAccount']

  constructor(ctx: Context) {
    super(ctx, 'enterpriseController', { namespace: 'enterprise' })
  }

  /**
   * Current read-only state.
   * @returns The current account view without tokens.
   */
  @Remote
  async getState(): Promise<EnterpriseView> {
    try {
      return await this.ctx.modeldeskAccount.state()
    } catch (error) {
      rejected(error)
    }
  }

  /**
   * Save the platform address; changing it signs out.
   * @param baseUrl - Origin of the ModelDesk server.
   * @returns The current account view without tokens.
   */
  @Remote
  async setBaseUrl(baseUrl: string): Promise<EnterpriseView> {
    try {
      return await this.ctx.modeldeskAccount.saveBaseUrl(baseUrl)
    } catch (error) {
      rejected(error)
    }
  }

  /**
   * Begin sign-in and return the URL the employee must open.
   * @returns The LoginStartView result.
   */
  @Remote
  async startLogin(): Promise<LoginStartView> {
    try {
      return await this.ctx.modeldeskAccount.startLogin()
    } catch (error) {
      rejected(error)
    }
  }

  /**
   * Paste a ticket delivered out of band.
   * @param ticket - One-time authorization code copied from the browser.
   * @returns The current account view without tokens.
   */
  @Remote
  async submitTicket(ticket: string): Promise<EnterpriseView> {
    try {
      return await this.ctx.modeldeskAccount.submitTicket(ticket)
    } catch (error) {
      rejected(error)
    }
  }

  /**
   * Abort the waiting attempt.
   * @returns The current account view without tokens.
   */
  @Remote
  async cancelLogin(): Promise<EnterpriseView> {
    try {
      return await this.ctx.modeldeskAccount.cancelLogin()
    } catch (error) {
      rejected(error)
    }
  }

  /**
   * Search the selected library through the active employee session.
   * @param library - Selects the personal or enterprise library.
   * @param query - Search terms entered by the employee.
   * @param before - Upper document ID bound for loading the next page.
   * @returns The LibraryPage result.
   */
  @Remote
  async listLibrary(library: DocumentLibrary, query: string, before: number | null): Promise<LibraryPage> {
    try {
      return await this.ctx.modeldeskAccount.library.searchDocuments(query, before ?? undefined, AbortSignal.timeout(20_000), library)
    } catch (error) {
      rejected(error)
    }
  }

  /**
   * Read a selected version, or the latest version when the document is still processing.
   * @param library - Selects the personal or enterprise library.
   * @param id - Identifier of the requested resource.
   * @param revision - Expected document or skill revision.
   * @returns The LibraryDocumentText result.
   */
  @Remote
  async readLibrary(library: DocumentLibrary, id: number, revision: number | null): Promise<LibraryDocumentText> {
    try {
      return await this.ctx.modeldeskAccount.library.readDocument(id, AbortSignal.timeout(20_000), library, revision ?? undefined)
    } catch (error) {
      rejected(error)
    }
  }

  /**
   * Import an original into the signed-in employee's private library.
   * @param name - Original user-supplied filename.
   * @param base64 - Base64-encoded contents of the original file.
   * @returns The LibraryDocument result.
   */
  @Remote
  async uploadLibraryFile(name: string, base64: string): Promise<LibraryDocument> {
    if (base64.length > 22_369_624) rejected(new ModelDeskApiError('文件不能超过 16 MiB', 'invalid_request'))
    try {
      return await this.ctx.modeldeskAccount.library.uploadPersonalFile(name, Buffer.from(base64, 'base64'))
    } catch (error) {
      rejected(error)
    }
  }

  /**
   * Remove a file owned by the active employee.
   * @param id - Identifier of the requested resource.
   */
  @Remote
  async deleteLibraryFile(id: number): Promise<void> {
    try {
      await this.ctx.modeldeskAccount.library.deletePersonalDocument(id)
    } catch (error) {
      rejected(error)
    }
  }

  /**
   * Download an original after checking the selected version and current access.
   * @param library - Selects the personal or enterprise library.
   * @param id - Identifier of the requested resource.
   * @param revision - Expected document or skill revision.
   * @returns The original file encoded as Base64.
   */
  @Remote
  async downloadLibraryFile(library: DocumentLibrary, id: number, revision: number): Promise<string> {
    try {
      return await this.ctx.modeldeskAccount.library.downloadDocument(library, id, revision)
    } catch (error) {
      rejected(error)
    }
  }

  /**
   * List the currently authorized enterprise skills and MCP tools.
   * @returns Authorized skills and MCP services for the current employee.
   */
  @Remote
  async listCapabilities(): Promise<ModelDeskCapabilities> {
    try {
      return await this.ctx.modeldeskAccount.capabilities()
    } catch (error) {
      rejected(error)
    }
  }

  /**
   * This month's quota and usage.
   * @returns Usage and quota for the current billing month.
   */
  @Remote
  async getUsage(): Promise<ModelDeskUsage> {
    try {
      return await this.ctx.modeldeskAccount.usage()
    } catch (error) {
      rejected(error)
    }
  }

  /**
   * Re-read the authorized model list.
   * @returns The current account view without tokens.
   */
  @Remote
  async refreshModels(): Promise<EnterpriseView> {
    try {
      await this.ctx.modeldeskAccount.models(true)
      return await this.ctx.modeldeskAccount.state()
    } catch (error) {
      rejected(error)
    }
  }

  /**
   * Sign out, keeping the platform address.
   * @returns The current account view without tokens.
   */
  @Remote
  async logout(): Promise<EnterpriseView> {
    try {
      return await this.ctx.modeldeskAccount.logout()
    } catch (error) {
      rejected(error)
    }
  }

  /**
   * Stream the state: one snapshot on subscribe, then one per change.
   * @param signal - stream lifetime.
   * @returns A stream of account views without credentials.
   */
  @Remote({ mode: 'stream' })
  async *watch(signal: AbortSignal): AsyncIterable<EnterpriseView> {
    let pending = false
    let wake: (() => void) | undefined
    const stop = this.ctx.modeldeskAccount.subscribe(() => { pending = true; wake?.() })
    const abort = (): void => { wake?.() }
    signal.addEventListener('abort', abort, { once: true })
    try {
      if (signal.aborted) return
      yield await this.ctx.modeldeskAccount.state()
      while (!signal.aborted) {
        if (pending) {
          pending = false
          yield await this.ctx.modeldeskAccount.state()
          continue
        }
        await new Promise<void>((resolve) => { wake = resolve })
        wake = undefined
      }
    } finally {
      stop()
      signal.removeEventListener('abort', abort)
    }
  }
}

export default EnterpriseController

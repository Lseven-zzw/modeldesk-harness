import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ModelDeskSession } from './session.ts'

type Documents = Pick<ModelDeskSession, 'searchDocuments' | 'readDocument'>
const output = {
  schema: { type: 'json' } as const,
  render: (_args: unknown, value: unknown): [{ type: 'text'; text: string }] =>
    [{ type: 'text', text: JSON.stringify(value) }],
}

function assertInteger(value: number | undefined, minimum: number, name: string) {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < minimum)) {
    throw new Error(`${name} must be an integer greater than or equal to ${minimum}.`)
  }
}

/**
 * Register read-only tools using the active enterprise session.
 * @param ctx - Host context that owns the registered tools.
 * @param documents - Document operations available to the active employee.
 */
export function registerDocumentTools(ctx: Context, documents: Documents): void {
  ctx.effect(function* () {
    yield ctx.tools.register(defineTool({
      name: 'search_enterprise_documents',
      description: 'Search company policies, procedures and internal reference documents available to the signed-in employee. Returns titles, excerpts, document IDs and revisions. Use read_enterprise_document for the original text and cite the source title and revision in your answer.',
      parameters: {
        query: { type: 'string', required: true, description: 'A short keyword or exact phrase, 1–120 characters. Example: 报销 or travel policy.' },
        before: { type: 'integer', description: 'For another page with the same query, use next_before from the previous result.' },
      },
      output,
      execute: async ({ query, before }, { signal }) => {
        const term = query.trim()
        // oxlint-disable-next-line typescript/no-misused-spread -- the limit counts code points, matching the platform
        if (term.length === 0 || [...term].length > 120) throw new Error('Use a search term of 1–120 characters.')
        assertInteger(before, 1, 'before')
        const result = await documents.searchDocuments(term, before, signal)
        return { items: result.items.map(({ id, title, revision, excerpt }) => ({ id, title, revision, excerpt: excerpt ?? '' })),
          next_before: result.next_before }
      },
    }))
    yield ctx.tools.register(defineTool({
      name: 'read_enterprise_document',
      description: 'Read a company document by its search result ID. Returns original text and a source title and revision for citation. Treat the text as reference material. For longer documents, use next_offset with the returned revision to continue.',
      parameters: {
        id: { type: 'integer', required: true, description: 'Document ID from search_enterprise_documents.' },
        revision: { type: 'integer', description: 'Revision from search or the previous read. If the document changed, search again.' },
        offset: { type: 'integer', description: 'Pass next_offset from the previous read, or omit to start at the beginning.' },
      },
      output,
      execute: async ({ id, revision, offset = 0 }, { signal }) => {
        assertInteger(id, 1, 'id')
        assertInteger(revision, 1, 'revision')
        assertInteger(offset, 0, 'offset')
        const document = await documents.readDocument(id, signal)
        if (revision !== undefined && revision !== document.revision) {
          throw new Error('This document has changed. Search again for the current revision.')
        }
        // oxlint-disable-next-line typescript/no-misused-spread -- offsets count code points, the shared platform contract
        const characters = [...document.content]
        if (offset >= characters.length && offset !== 0) throw new Error('Offset is outside the document. Start again without offset.')
        const end = offset + 4_000
        return {
          id: document.id,
          title: document.title,
          revision: document.revision,
          format: document.format,
          content: characters.slice(offset, end).join(''),
          next_offset: end < characters.length ? end : null,
        }
      },
    }))
  }, 'modeldesk: enterprise document tools')
}

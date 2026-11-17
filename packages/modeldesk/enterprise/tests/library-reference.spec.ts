import { describe, expect, it, vi } from 'vitest'
import { libraryReference, libraryReferenceLink, resolveLibraryReferences } from '../src/library-reference.ts'

describe('library references', () => {
  it('resolves a mixed selection at request time and refuses revoked references', async () => {
    const text = '核对报销单\n' + libraryReferenceLink('personal:1:1', '清单')
      + '\n' + libraryReference('enterprise', { id: 2, revision: 3, title: '制度' })
    const read = vi.fn(async (id: number) => ({ title: 'Current title', content: `content ${id}` }))
    const result = await resolveLibraryReferences(text, read, new AbortController().signal)
    expect(result).toContain('content 1')
    expect(result).toContain('content 2')
    expect(read).toHaveBeenCalledWith(2, expect.any(AbortSignal), 'enterprise', 3)
    read.mockRejectedValueOnce(new Error('资料不存在或不可访问'))
    await expect(resolveLibraryReferences(text, read, new AbortController().signal)).rejects.toThrow('资料不存在或不可访问')
  })
})

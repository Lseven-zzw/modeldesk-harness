import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { expect, it, vi } from 'vitest'
import SkillRegistry from '../../../skill/skill/src/index.ts'
import * as SkillFileSystem from '../../../skill/skill-filesystem/src/index.ts'
import { EnterpriseSkillSync, type CloudSkill } from '../src/skill-sync.ts'

it('updates and revokes cloud skills while preserving separate local skills', async () => {
  const home = await mkdtemp(join(tmpdir(), 'enterprise-skill-test-'))
  const cache = join(home, 'enterprise')
  const personal = join(home, 'personal.md')
  const path = join(cache, 'enterprise-review', 'SKILL.md')
  let remote: CloudSkill[] | Error = []
  const sync = new EnterpriseSkillSync(cache, async () => {
    if (remote instanceof Error) throw remote
    return remote
  })
  try {
    await writeFile(personal, 'local')
    remote = [{ code: 'review', revision: 1, markdown: 'v1' }]
    await sync.refresh()
    expect(await readFile(path, 'utf8')).toBe('v1')
    remote = [{ code: 'review', revision: 2, markdown: 'v2' }]
    await sync.refresh()
    expect(await readFile(path, 'utf8')).toBe('v2')
    remote = []
    await sync.refresh()
    await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' })
    remote = [{ code: 'review', revision: 3, markdown: 'v3' }]
    await sync.refresh()
    remote = new Error('Access cannot be confirmed')
    await sync.refresh()
    await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(personal, 'utf8')).toBe('local')
  } finally {
    await sync.close()
    await rm(home, { recursive: true, force: true })
  }
})

it('makes published skills discoverable by Harness and invalidates the catalog on revocation', async () => {
  const home = await mkdtemp(join(tmpdir(), 'enterprise-skill-harness-'))
  const cache = join(home, 'enterprise')
  const ctx = new Context()
  await ctx.plugin(SkillRegistry)
  const provider = await ctx.plugin(SkillFileSystem, {
    providerName: 'enterprise-filesystem', includeDefaultRoots: false, bundledSkillDir: cache,
  })
  let remote: CloudSkill[] = [{
    code: 'review', revision: 1,
    markdown: '---\nname: review\ndescription: Review copy\n---\n\nReview the draft.\n',
  }]
  const sync = new EnterpriseSkillSync(cache, async () => remote)
  try {
    await sync.refresh()
    expect((await ctx.skills.list()).map(skill => skill.name)).toEqual(['review'])
    remote = []
    await sync.refresh()
    await vi.waitFor(async () => {
      expect(await ctx.skills.list()).toEqual([])
    }, { timeout: 5000 })
  } finally {
    await provider.dispose()
    await sync.close()
    await rm(home, { recursive: true, force: true })
  }
})

it('installs attachments with their revision and removes stale or unsafe paths', async () => {
  const home = await mkdtemp(join(tmpdir(), 'enterprise-skill-bundle-'))
  const cache = join(home, 'enterprise')
  const bundle = join(cache, 'enterprise-review')
  let remote: CloudSkill[] = [{ code: 'review', revision: 1, markdown: 'v1', has_files: true }]
  let files = [{ path: 'references/example.md', data: Buffer.from('example').toString('base64') }]
  const sync = new EnterpriseSkillSync(cache, async () => remote, async () => files)
  try {
    await sync.refresh()
    expect(await readFile(join(bundle, 'references', 'example.md'), 'utf8')).toBe('example')
    remote = [{ code: 'review', revision: 2, markdown: 'v2' }]
    await sync.refresh()
    expect(await readFile(join(bundle, 'SKILL.md'), 'utf8')).toBe('v2')
    await expect(readFile(join(bundle, 'references', 'example.md'))).rejects.toMatchObject({ code: 'ENOENT' })
    remote = [{ code: 'review', revision: 3, markdown: 'v3', has_files: true }]
    files = [{ path: '../outside', data: 'YQ==' }]
    await sync.refresh()
    await expect(readFile(join(bundle, 'SKILL.md'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(join(home, 'outside'))).rejects.toMatchObject({ code: 'ENOENT' })
  } finally {
    await sync.close()
    await rm(home, { recursive: true, force: true })
  }
})

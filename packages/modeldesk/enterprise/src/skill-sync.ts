import { mkdir, mkdtemp, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'

/**
 * Published enterprise skill metadata received from the server.
 */
export interface CloudSkill {
  readonly code: string
  readonly revision: number
  readonly markdown: string
  readonly has_files?: boolean | undefined
}

/**
 * One attachment in an authorized skill revision.
 */
export interface CloudSkillFile { readonly path: string; readonly data: string }

function attachmentPath(path: string): string[] {
  const parts = path.split('/')
  if (path.length > 220 || parts.length > 12 || parts.some(part =>
    !part || part.length > 100 || part === '.' || part === '..' || /^[ ]|[ .]$/.test(part) ||
    /[\u0000-\u001f\\:<>"|?*]/.test(part) ||
    /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\..*)?$/i.test(part),
  ) || path.toLowerCase() === 'skill.md') throw new Error('Invalid enterprise Skill attachment path')
  return parts
}

/** Reconciles only the dedicated, server-managed skill directory. */
export class EnterpriseSkillSync {
  private readonly installed = new Map<string, CloudSkill>()
  private running: Promise<void> | undefined
  private pending: boolean = false
  private closed: boolean = false

  constructor(
    private readonly directory: string,
    private readonly fetchSkills: () => Promise<readonly CloudSkill[]>,
    private readonly fetchFiles?: (skill: CloudSkill) => Promise<readonly CloudSkillFile[]>,
  ) {}

  /**
   * Refresh locally available skills from the server.
   */
  refresh(): Promise<void> {
    if (this.closed) return Promise.resolve()
    this.pending = true
    return this.running ??= this.drain().finally(() => { this.running = undefined })
  }

  /**
   * Stop synchronization and release the watched resources.
   */
  async close(): Promise<void> {
    this.closed = true
    try { await this.running } finally { await this.clear() }
  }

  private async drain(): Promise<void> {
    while (this.pending && !this.closed) {
      this.pending = false
      try {
        const entries = await this.fetchSkills()
        // oxlint-disable-next-line typescript/no-unnecessary-condition -- refresh()/close() mutate these flags on other call paths
        if (!this.closed && !this.pending) await this.apply(entries)
      } catch {
        // A failed access check or an unavailable catalog cannot confirm old permissions.
        await this.clear()
      }
    }
  }

  private async clear(): Promise<void> {
    await rm(this.directory, { recursive: true, force: true })
    this.installed.clear()
  }

  private async apply(entries: readonly CloudSkill[]): Promise<void> {
    const desired = new Map<string, CloudSkill>()
    for (const entry of entries) {
      if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(entry.code) || entry.code.length > 64 || desired.has(entry.code)) {
        throw new Error('Invalid enterprise skill identifier')
      }
      desired.set(entry.code, entry)
    }
    for (const code of this.installed.keys()) {
      if (desired.has(code)) continue
      await rm(join(this.directory, `enterprise-${code}`), { recursive: true, force: true })
      this.installed.delete(code)
    }
    for (const [code, entry] of desired) {
      if (this.closed || this.pending) return
      const previous = this.installed.get(code)
      if (previous?.revision === entry.revision && previous.markdown === entry.markdown) continue
      await this.install(entry)
    }
  }

  private async install(entry: CloudSkill): Promise<void> {
    const files = entry.has_files ? await this.fetchFiles?.(entry) : []
    if (!files || files.length > 100) throw new Error('Invalid enterprise Skill bundle')
    if (this.closed || this.pending) return
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    const staging = await mkdtemp(join(dirname(this.directory), '.enterprise-skill-'))
    try {
      const seen = new Set<string>()
      let total = 0
      for (const file of files) {
        const parts = attachmentPath(file.path)
        const key = file.path.toLowerCase()
        const contents = Buffer.from(file.data, 'base64')
        total += contents.length
        if (seen.has(key) || total > 2 * 1024 * 1024 || contents.toString('base64') !== file.data) {
          throw new Error('Invalid enterprise Skill attachment')
        }
        seen.add(key)
        const target = join(staging, ...parts)
        await mkdir(dirname(target), { recursive: true, mode: 0o700 })
        await writeFileAtomic(target, contents, { mode: 0o600 })
      }
      await writeFileAtomic(join(staging, 'SKILL.md'), entry.markdown, { mode: 0o600 })
      // oxlint-disable-next-line typescript/no-unnecessary-condition -- refresh()/close() mutate these flags on other call paths
      if (this.closed || this.pending) return
      const bundle = join(this.directory, `enterprise-${entry.code}`)
      await rm(bundle, { recursive: true, force: true })
      await rename(staging, bundle)
      this.installed.set(entry.code, entry)
    } finally {
      await rm(staging, { recursive: true, force: true })
    }
  }
}

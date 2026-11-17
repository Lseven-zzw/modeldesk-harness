import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '../../../test-support/loader-smoke/src/index.ts'

const repoFile = (path: string) => fileURLToPath(new URL(`../../../../${path}`, import.meta.url))

it('reads enterprise documents through the real headless tool pipeline and rechecks access', async () => {
  const requests: string[] = []
  let reads = 0
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    requests.push(`${url.pathname}:${request.headers.authorization}`)
    const source = { id: 7, revision: 2, title: 'Travel policy' }
    response.setHeader('content-type', 'application/json')
    if (request.headers.authorization !== 'Bearer employee-fixture-token') {
      response.writeHead(401).end('{}')
    } else if (url.pathname === '/api/v1/modeldesk/mcp/servers') {
      response.end(JSON.stringify({ items: [] }))
    } else if (url.pathname === '/api/v1/modeldesk/documents' && url.searchParams.get('q') === 'travel') {
      response.end(JSON.stringify({ items: [{ ...source, excerpt: 'Travel receipts' }], next_before: null }))
    } else if (url.pathname === '/api/v1/modeldesk/documents/7' && ++reads <= 2) {
      response.end(JSON.stringify({ ...source, format: 'markdown', content: '# Keep receipts'.padEnd(4_000, ' ') + '📄' }))
    } else {
      response.writeHead(404).end(JSON.stringify({ error: { code: 'invalid_request', message: 'Document access revoked' } }))
    }
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const scratch = await mkdtemp(join(tmpdir(), 'modeldesk-documents-'))
  try {
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('Fixture has no port')
    const configPath = join(scratch, 'documents.patch.yml')
    const plugin = process.env.DSH_EXAMPLE_MODE === 'lib' ? 'lib/index.js' : 'src/index.ts'
    await writeFile(configPath, JSON.stringify([
      { id: 'credentials', disabled: false },
      { id: 'agent-default-model', config: { provider: 'modeldesk-document-fixture', model: 'fixture' } },
      { insert: [
        { id: 'modeldesk-enterprise', name: repoFile(`packages/modeldesk/enterprise/${plugin}`), inject: ['credentials'] },
        { id: 'modeldesk-document-fixture', name: repoFile('packages/modeldesk/enterprise/tests/fixtures/document-turn.ts') },
      ] },
    ]))
    const result = await runLoaderSmoke({
      label: 'Enterprise document tools', tempDirPrefix: 'modeldesk-document-turn-',
      binScript: repoFile('apps/cli/src/bin.ts'), libBinScript: repoFile('apps/cli/lib/bin.js'),
      tsconfigPath: repoFile('tsconfig.json'), configPath,
      binArgs: ['--profile', 'headless', '--patch', configPath, 'Find and read the company travel policy.'],
      env: {
        MODELDESK_TEST_PLATFORM: `http://127.0.0.1:${address.port}`,
        DSH_PERMISSION_MODE: 'danger-full-access', DSH_TELEMETRY_DISABLED: '1',
      },
    })
    expect(result.stdout).toContain('"title":"Travel policy"')
    expect(result.stdout).toContain('"revision":2')
    expect(result.stdout).toContain('# Keep receipts')
    expect(result.stdout).toContain('"next_offset":4000')
    expect(result.stdout).toContain('"content":"📄","next_offset":null')
    expect(result.stdout).toContain('Document access revoked')
    expect(requests.filter(path => path.startsWith('/api/v1/modeldesk/documents'))).toEqual([
      '/api/v1/modeldesk/documents:Bearer employee-fixture-token',
      '/api/v1/modeldesk/documents/7:Bearer employee-fixture-token',
      '/api/v1/modeldesk/documents/7:Bearer employee-fixture-token',
      '/api/v1/modeldesk/documents/7:Bearer employee-fixture-token',
    ])
  } finally {
    await new Promise<void>(resolve => server.close(() => { resolve() }))
    await rm(scratch, { recursive: true, force: true })
  }
}, LOADER_SMOKE_TEST_TIMEOUT_MS)

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '../../../test-support/loader-smoke/src/index.ts'

const repoFile = (path: string) => fileURLToPath(new URL(`../../../../${path}`, import.meta.url))

it('calls enterprise MCP tools through the proxy and fails write tools closed without approval', async () => {
  const proxied: { tool: string; arguments: unknown }[] = []
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    response.setHeader('content-type', 'application/json')
    if (request.headers.authorization !== 'Bearer employee-fixture-token') {
      response.writeHead(401).end('{}')
      return
    }
    if (url.pathname === '/api/v1/modeldesk/mcp/servers') {
      response.end(JSON.stringify({ items: [{
        id: 1, name: 'Ticket desk', description: '内部工单系统', guide: '先用 search_tickets 查询，再决定是否创建。', revision: 2,
        tools: [
          { name: 'search_tickets', description: 'Search tickets', input_schema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] }, access: 'read' },
          { name: 'create_ticket', description: 'Create a ticket', input_schema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] }, access: 'write' },
        ],
      }] }))
      return
    }
    if (url.pathname === '/api/v1/modeldesk/mcp/servers/1/call' && request.method === 'POST') {
      let body = ''
      request.on('data', (chunk: Buffer) => { body += chunk.toString('utf8') })
      request.on('end', () => {
        const call = JSON.parse(body) as { tool: string; arguments: unknown }
        proxied.push(call)
        response.end(JSON.stringify(call.tool === 'search_tickets'
          ? { content: [{ type: 'text', text: 'TICKET-42 发票报销' }], is_error: false }
          : { content: [{ type: 'text', text: 'created TICKET-43' }], is_error: false }))
      })
      return
    }
    response.writeHead(404).end(JSON.stringify({ error: { code: 'invalid_request', message: 'Not found' } }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const scratch = await mkdtemp(join(tmpdir(), 'modeldesk-mcp-'))
  try {
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('Fixture has no port')
    const configPath = join(scratch, 'mcp.patch.yml')
    const plugin = process.env.DSH_EXAMPLE_MODE === 'lib' ? 'lib/index.js' : 'src/index.ts'
    await writeFile(configPath, JSON.stringify([
      { id: 'credentials', disabled: false },
      { id: 'agent-default-model', config: { provider: 'modeldesk-mcp-fixture', model: 'fixture' } },
      { insert: [
        { id: 'modeldesk-mcp-fixture', name: repoFile('packages/modeldesk/enterprise/tests/fixtures/mcp-turn.ts') },
        { id: 'modeldesk-enterprise', name: repoFile(`packages/modeldesk/enterprise/${plugin}`), inject: ['credentials'] },
      ] },
    ]))
    const result = await runLoaderSmoke({
      label: 'Enterprise MCP tools', tempDirPrefix: 'modeldesk-mcp-turn-',
      binScript: repoFile('apps/cli/src/bin.ts'), libBinScript: repoFile('apps/cli/lib/bin.js'),
      tsconfigPath: repoFile('tsconfig.json'), configPath,
      binArgs: ['--profile', 'headless', '--patch', configPath, 'Search tickets and try to create one.'],
      env: {
        MODELDESK_TEST_PLATFORM: `http://127.0.0.1:${address.port}`,
        DSH_PERMISSION_MODE: 'danger-full-access', DSH_TELEMETRY_DISABLED: '1',
      },
    })
    expect(result.stdout).toContain('先用 search_tickets 查询，再决定是否创建。')
    expect(result.stdout).toContain('TICKET-42 发票报销')
    expect(result.stdout).toContain('the user rejected tool "mcp__modeldesk-1__create_ticket"')
    expect(proxied).toEqual([{ tool: 'search_tickets', arguments: { q: '发票' } }])
  } finally {
    await new Promise<void>(resolve => server.close(() => { resolve() }))
    await rm(scratch, { recursive: true, force: true })
  }
}, LOADER_SMOKE_TEST_TIMEOUT_MS)

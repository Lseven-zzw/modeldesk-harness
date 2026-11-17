import { describe, expect, it } from 'vitest'
import { parseModelDeskLoginLink } from '../src/modeldesk-login.ts'

describe('ModelDesk desktop links', () => {
  it('accepts an encoded platform origin', () => {
    expect(parseModelDeskLoginLink('modeldesk://login?server=https%3A%2F%2Fmodeldesk.example.com')).toBe('https://modeldesk.example.com')
    expect(parseModelDeskLoginLink('modeldesk://login?server=http%3A%2F%2F127.0.0.1%3A18082')).toBe('http://127.0.0.1:18082')
  })

  it.each([
    'modeldesk://login/?server=https%3A%2F%2Fmodeldesk.example.com',
    'modeldesk://login?server=https://modeldesk.example.com',
    'modeldesk://login?server=https%3A%2F%2Fmodeldesk.example.com&server=https%3A%2F%2Fother.example',
    'modeldesk://login?server=https%3A%2F%2Fmodeldesk.example.com&code=ticket',
    'modeldesk://login?server=https%3A%2F%2Fname%40modeldesk.example.com',
    'modeldesk://login?server=https%3A%2F%2Fmodeldesk.example.com%2Fadmin',
    'modeldesk://login?server=https%3A%2F%2Fmodeldesk.example.com#',
    'modeldesk://login?server=ftp%3A%2F%2Fmodeldesk.example.com',
    'modeldesk://login?server=http%3A%2F%2Fmodeldesk.example.com',
  ])('rejects %s', (link) => {
    expect(parseModelDeskLoginLink(link)).toBeUndefined()
  })
})

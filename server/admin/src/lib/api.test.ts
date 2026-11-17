import { afterEach, describe, expect, it, vi } from 'vitest'

import { ApiError, api } from './api'

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('admin api client', () => {
  it('attaches the csrf token to writes after reading the session', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({ url, init })
      if (url.endsWith('/session')) {
        return jsonResponse(200, {
          user: { id: 1, username: 'admin', display_name: '管理员', department: null, role: 'ADMIN', status: 1, created_at: '2026-11-09T00:00:00' },
          csrf_token: 'csrf-123', org_name: '示例组织',
        })
      }
      return jsonResponse(201, { id: 2, username: 'zhang.san', display_name: '张三', department: '剪辑部', role: 'EMPLOYEE', status: 1, created_at: '2026-11-09T00:00:00' })
    }))

    await api.session()
    await api.employees.create({ username: 'zhang.san', display_name: '张三', department: '剪辑部', role: 'EMPLOYEE', password: 'employee-pass-1' })

    const write = calls[1]
    expect(write.url).toBe('/api/admin/employees')
    expect(new Headers(write.init.headers).get('X-CSRF-Token')).toBe('csrf-123')
  })

  it('maps the error body to ApiError', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(400, {
      error: { message: '用户名已存在', type: 'invalid_request_error', code: 'invalid_request' },
      request_id: 'req_1',
    })))
    await expect(api.employees.create({ username: 'x'.repeat(3), display_name: 'x', password: 'employee-pass-1' }))
      .rejects.toMatchObject({ status: 400, code: 'invalid_request', message: '用户名已存在' })
    expect(ApiError).toBeTypeOf('function')
  })

  it('replaces grants with PUT and treats 204 as empty', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({ url, init })
      if (url.endsWith('/session')) {
        return jsonResponse(200, {
          user: { id: 1, username: 'admin', display_name: '管理员', department: null, role: 'ADMIN', status: 1, created_at: '2026-11-09T00:00:00' },
          csrf_token: 'csrf-123', org_name: '示例组织',
        })
      }
      if (url.endsWith('/models/7/grants')) {
        return jsonResponse(200, { model_id: 7, grants: [{ subject_type: 'EVERYONE', subject_id: '*' }] })
      }
      return new Response(null, { status: 204 })
    }))

    await api.session()
    await api.models.replaceGrants(7, [{ subject_type: 'EVERYONE', subject_id: '*' }])
    await api.creditRules.remove(3)

    expect(calls[1].url).toBe('/api/admin/models/7/grants')
    expect(calls[1].init.method).toBe('PUT')
    expect(new Headers(calls[1].init.headers).get('X-CSRF-Token')).toBe('csrf-123')
    expect(calls[2].url).toBe('/api/admin/credit-rules/3')
    expect(calls[2].init.method).toBe('DELETE')
  })

  it('builds usage queries with month, page and filters', async () => {
    const urls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      urls.push(url)
      if (url.endsWith('/session')) {
        return jsonResponse(200, {
          user: { id: 1, username: 'admin', display_name: '管理员', department: null, role: 'ADMIN', status: 1, created_at: '2026-11-09T00:00:00' },
          csrf_token: 'csrf-123', org_name: '示例组织',
        })
      }
      return jsonResponse(200, { month: '2026-11', total: 0, items: [] })
    }))

    await api.session()
    await api.usage.calls({ month: '2026-11', page: 2, page_size: 50, user_id: 9, status: 'SUCCESS' })

    expect(urls[1]).toBe('/api/admin/usage/calls?month=2026-11&page=2&page_size=50&user_id=9&status=SUCCESS')
  })
})

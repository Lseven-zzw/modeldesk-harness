// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ClientRemote, EnterpriseView } from '@deepseek-ai/dsh-api-remotes/client'
import { afterEach, expect, it, vi } from 'vitest'
import { EnterpriseSection } from '../src/client/EnterpriseSection.tsx'

const signedIn: EnterpriseView = {
  baseUrl: 'https://modeldesk.example.com', phase: 'signed-in',
  user: { id: '1', username: 'staff', displayName: '员工甲', department: '研发' },
  org: { id: 'modeldesk', name: 'ModelDesk Harness' }, sessionExpiresAt: '2026-11-11T00:00:00Z',
  models: [], login: null,
}

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

it('renders the account, polls usage every 30 seconds, and disposes on unmount', async () => {
  vi.useFakeTimers()
  const accept = vi.fn()
  const dispose = vi.fn()
  const getUsage = vi.fn(async () => ({ ok: true, value: {
    billingMonth: '2026-11', billingTimezone: 'Asia/Shanghai', limitTokens: 1000,
    usedTokens: 250, remainingTokens: 750, resetsAt: '2026-12-01T00:00:00+08:00',
  } }))
  const remote = {
    enterprise: { getUsage },
    $stream: () => ({ dispose, async *[Symbol.asyncIterator]() { yield { value: signedIn, accept } } }),
  } as unknown as ClientRemote
  const view = render(<EnterpriseSection remote={remote} />)
  await act(async () => {})
  expect(screen.getByText('员工甲')).toBeTruthy()
  expect(screen.getByText('750 token')).toBeTruthy()
  expect(accept).toHaveBeenCalledOnce()
  expect(getUsage).toHaveBeenCalledOnce()
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
  expect(getUsage).toHaveBeenCalledTimes(2)
  view.unmount()
  await vi.advanceTimersByTimeAsync(30_000)
  expect(getUsage).toHaveBeenCalledTimes(2)
  expect(dispose).toHaveBeenCalledOnce()
})

it('offers a collapsed manual ticket form during browser authorization', async () => {
  const submitTicket = vi.fn(async () => ({ ok: true, value: signedIn }))
  const waiting = { ...signedIn, phase: 'signing-in', user: null,
    login: { authorizeUrl: 'https://modeldesk.example.com/desktop-login', expiresAt: '2026-11-11T00:00:00Z' } }
  const remote = {
    enterprise: { submitTicket },
    $stream: () => ({
      dispose() {},
      async *[Symbol.asyncIterator]() { yield { value: waiting, accept() {} } },
    }),
  } as unknown as ClientRemote
  render(<EnterpriseSection remote={remote} />)
  await screen.findByText('等待浏览器授权…')
  const details = screen.getByText('手动粘贴授权票据').closest('details')
  expect(details?.open).toBe(false)
  fireEvent.click(screen.getByText('手动粘贴授权票据'))
  const field = screen.getByLabelText('授权票据')
  fireEvent.change(field, { target: { value: 'one-time-ticket-0001' } })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '提交票据' })) })
  expect(submitTicket).toHaveBeenCalledWith('one-time-ticket-0001')
  expect((field as HTMLInputElement).value).toBe('')
})

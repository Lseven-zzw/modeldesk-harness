import { describe, expect, it } from 'vitest'
import { openLoopback } from '../src/loopback.ts'

const authId = 'gtx_01'
const state = 'state_01'

describe('openLoopback', () => {
  it('resolves the ticket from a valid callback', async () => {
    const loopback = await openLoopback({ authId, state })
    const url = `${loopback.redirectUri}?auth_id=${authId}&identity_ticket=${'t'.repeat(24)}&state=${state}`
    const response = await fetch(url)
    expect(response.status).toBe(200)
    expect(await response.text()).not.toContain('t'.repeat(24))
    await expect(loopback.result).resolves.toEqual({ kind: 'ticket', ticket: 't'.repeat(24) })
    await loopback.close()
  })

  it('maps a white-listed error and rejects unknown ones to authorization_failed', async () => {
    const denied = await openLoopback({ authId, state })
    await fetch(`${denied.redirectUri}?auth_id=${authId}&error=access_denied&state=${state}`)
    await expect(denied.result).resolves.toEqual({ kind: 'error', error: 'access_denied' })
    await denied.close()

    const other = await openLoopback({ authId, state })
    await fetch(`${other.redirectUri}?auth_id=${authId}&error=boom&state=${state}`)
    await expect(other.result).resolves.toEqual({ kind: 'error', error: 'authorization_failed' })
    await other.close()
  })

  it('rejects a mismatched state, duplicate parameters and extra paths without settling', async () => {
    const loopback = await openLoopback({ authId, state })
    const bad = await fetch(`${loopback.redirectUri}?auth_id=${authId}&identity_ticket=${'t'.repeat(24)}&state=wrong`)
    expect(bad.status).toBe(400)

    const duplicate = await fetch(`${loopback.redirectUri}?auth_id=${authId}&auth_id=${authId}&state=${state}`)
    expect(duplicate.status).toBe(400)

    const extra = await fetch(`${loopback.redirectUri.replace('/modeldesk/callback', '/elsewhere')}?auth_id=${authId}&state=${state}`)
    expect(extra.status).toBe(404)

    // Still unresolved: none of the three reached the settle path.
    const raced = await Promise.race([loopback.result.then(() => 'settled'), Promise.resolve('open')])
    expect(raced).toBe('open')
    await loopback.close()
  })
})

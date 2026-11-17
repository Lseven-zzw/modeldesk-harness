import { describe, expect, it } from 'vitest'
import { challengeFor, createState, createVerifier } from '../src/pkce.ts'

// RFC 7636 Appendix B test vector.
const VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'
const CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'

describe('PKCE', () => {
  it('matches the RFC 7636 Appendix B vector', () => {
    expect(challengeFor(VERIFIER)).toBe(CHALLENGE)
  })

  it('emits a verifier inside the allowed grammar and length', () => {
    const verifier = createVerifier()
    expect(verifier).toMatch(/^[A-Za-z0-9\-._~]{43,128}$/)
    expect(verifier).not.toBe(createVerifier())
  })

  it('emits 43-character base64url state', () => {
    expect(createState()).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })
})

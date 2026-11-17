/**
 * PKCE S256 only. The verifier is 64 random bytes in base64url; the
 * challenge is the unpadded base64url of its SHA-256 digest.
 * @module @modeldesk/dsh-enterprise/pkce
 */
import { createHash, randomBytes } from 'node:crypto'

/**
 * New code verifier: 86 characters, inside RFC 7636's 43–128 range.
 * @returns The string result.
 */
export function createVerifier(): string {
  return randomBytes(64).toString('base64url')
}

/**
 * New opaque `state`: 256 bits, base64url.
 * @returns The string result.
 */
export function createState(): string {
  return randomBytes(32).toString('base64url')
}

/**
 * S256 challenge for a verifier.
 * @param verifier - the code verifier.
 * @returns unpadded base64url digest.
 */
export function challengeFor(verifier: string): string {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url')
}

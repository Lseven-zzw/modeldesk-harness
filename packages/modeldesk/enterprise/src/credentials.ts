/**
 * The single stored record: either a platform address alone, or a signed-in
 * session. Written only through `CredentialProvider.modifyRecord`.
 * @module @modeldesk/dsh-enterprise/credentials
 */
import { credentialKey, type CredentialKey, type CredentialRecord } from '@deepseek-ai/dsh-credentials'
import { z } from 'zod'
import type { ModelDeskModel, ModelDeskRecord } from './types.ts'

/** Storage address of the one record this plugin owns. */
export const SESSION_KEY: CredentialKey = credentialKey('modeldesk-enterprise', 'session')

const modelSchema = z.object({
  id: z.string().min(1),
  displayName: z.string(),
  contextWindow: z.number().int().positive(),
  capabilities: z.object({ streaming: z.boolean(), tools: z.boolean(), reasoningContent: z.boolean() }),
})

const storedSchema = z.object({ version: z.literal(1), baseUrl: z.string().min(1) })

const signedInSchema = z.object({
  version: z.literal(1),
  baseUrl: z.string().min(1),
  sessionId: z.string().min(1),
  accessToken: z.string().min(1),
  accessExpiresAt: z.number(),
  refreshToken: z.string().min(1),
  refreshExpiresAt: z.number(),
  absoluteExpiresAt: z.number(),
  user: z.object({ id: z.string(), username: z.string(), displayName: z.string(), department: z.string().nullable() }),
  org: z.object({ id: z.string(), name: z.string() }),
  models: z.array(modelSchema),
  modelsFetchedAt: z.number(),
})

/**
 * Interpret a stored record.
 * @param record - whatever the provider returned.
 * @returns the parsed record, or `undefined` when absent or not ours.
 */
export function parseRecord(record: CredentialRecord | undefined): ModelDeskRecord | undefined {
  if (record === undefined || record.kind !== 'grant') return undefined
  const signed = signedInSchema.safeParse(record.payload)
  if (signed.success) return signed.data
  const stored = storedSchema.safeParse(record.payload)
  if (stored.success) return stored.data
  return undefined
}

/**
 * Wrap a record for storage.
 * @param value - Credential state being converted or checked.
 * @returns The account state in its stored credential representation.
 */
export function toRecord(value: ModelDeskRecord): CredentialRecord {
  return { kind: 'grant', payload: value }
}

/**
 * Whether a parsed record carries a live session.
 * @param value - Credential state being converted or checked.
 * @returns Whether the credential state represents a signed-in session.
 */
export function isSignedIn(value: ModelDeskRecord | undefined): value is Extract<ModelDeskRecord, { sessionId: string }> {
  return value !== undefined && 'refreshToken' in value
}

/**
 * Keep catalog updates from clearing token fields.
 * @param signed - Current signed-in employee record.
 * @param models - Newly fetched authorized models.
 * @param at - Timestamp used for the cached model catalog.
 * @returns The updated credential record.
 */
export function withModels(signed: Extract<ModelDeskRecord, { sessionId: string }>, models: readonly ModelDeskModel[], at: number): ModelDeskRecord {
  return { ...signed, models, modelsFetchedAt: at }
}

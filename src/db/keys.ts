/**
 * DynamoDB key builders for single-table design.
 *
 * Single-table design stores all entity types in one table, using structured
 * PK/SK strings to distinguish them. This module centralizes key construction
 * so the rest of the codebase never deals with raw key strings.
 *
 * Pattern: ENTITY_TYPE#<identifier>
 *
 * Key schema:
 *   PK: USER#<telegram_id>    SK: PROFILE             → User profile
 *   PK: USER#<telegram_id>    SK: WORD#<iso_timestamp> → Sent word
 *   PK: USER#<telegram_id>    SK: SESSION              → Grammy session
 *
 * GSI1 (active user lookup):
 *   GSI1PK: ACTIVE    GSI1SK: USER#<telegram_id>
 *
 * GSI2 (word date lookup):
 *   GSI2PK: USER#<telegram_id>    GSI2SK: <YYYY-MM-DD>
 */

export function userPK(telegramId: number): string {
  return `USER#${telegramId}`;
}

export const PROFILE_SK = 'PROFILE';
export const SESSION_SK = 'SESSION';

export function wordSK(sentAtIso: string): string {
  return `WORD#${sentAtIso}`;
}

// GSI1 keys — used by the scheduler to find all active users
export const ACTIVE_GSI1PK = 'ACTIVE';

export function userGSI1SK(telegramId: number): string {
  return `USER#${telegramId}`;
}

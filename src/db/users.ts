/**
 * User profile CRUD operations.
 *
 * Each function maps to one of the access patterns from the plan:
 * - getUser()         → GetItem on PK=USER#<id>, SK=PROFILE
 * - upsertUser()      → PutItem (creates or overwrites the profile)
 * - updateUser()      → UpdateItem (partial update of specific fields)
 * - getActiveUsers()  → Query on GSI1 where GSI1PK=ACTIVE
 *
 * Why "upsert" instead of separate create/update?
 * DynamoDB's PutItem is an upsert by default — it creates the item if it
 * doesn't exist, or replaces it if it does. For onboarding, this is exactly
 * what we want: first-time users get created, re-onboarding users get updated.
 */

import {
  GetCommand,
  PutCommand,
  UpdateCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb';
import { docClient, TABLE_NAME } from './client.js';
import { userPK, PROFILE_SK, ACTIVE_GSI1PK, userGSI1SK } from './keys.js';

/** Shape of a user profile stored in DynamoDB. */
export interface UserProfile {
  telegram_id: number;
  username?: string;
  ai_provider: 'anthropic' | 'gemini' | 'openai';
  api_key: string; // AES-256-GCM encrypted
  hsk_level: number;
  timezone: string;
  send_hour: number;
  send_minute: number;
  daily_word_count: number;
  recap_day: string;
  recap_hour: number;
  recap_minute: number;
  is_active: boolean;
  created_at: string;
}

/**
 * Type-safe field name constant.
 *
 * `satisfies keyof UserProfile` validates that 'is_active' is a real field
 * at compile time, while preserving the literal type 'is_active' (not widening
 * to `string`). This means fields[IS_ACTIVE_KEY] correctly resolves to
 * `boolean | undefined` instead of `any`.
 */
const IS_ACTIVE_KEY = 'is_active' satisfies keyof UserProfile;

export async function getUser(telegramId: number): Promise<UserProfile | null> {
  const result = await docClient.send(new GetCommand({
    TableName: TABLE_NAME,
    Key: { PK: userPK(telegramId), SK: PROFILE_SK },
  }));

  if (!result.Item) return null;

  // Strip DynamoDB key fields and return the domain object.
  // The spread + destructure pattern extracts PK/SK/GSI keys and keeps the rest.
  const { PK, SK, GSI1PK, GSI1SK, ...profile } = result.Item;
  return profile as UserProfile;
}

/**
 * Creates or fully replaces a user profile.
 *
 * Also writes GSI1 keys if the user is active, so the scheduler can find them.
 * This is the "overloaded GSI" pattern — we attach extra attributes (GSI1PK/SK)
 * to items that should appear in the index, and omit them from items that shouldn't.
 */
export async function upsertUser(profile: UserProfile): Promise<void> {
  await docClient.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: {
      PK: userPK(profile.telegram_id),
      SK: PROFILE_SK,
      ...profile,
      // Only active users appear in GSI1 (scheduler index)
      ...(profile.is_active
        ? { GSI1PK: ACTIVE_GSI1PK, GSI1SK: userGSI1SK(profile.telegram_id) }
        : {}),
    },
  }));
}

/**
 * Partially updates specific fields on a user profile.
 *
 * Uses DynamoDB's UpdateExpression to modify only the provided fields,
 * leaving everything else untouched. This is better than PutItem for
 * settings changes because it doesn't require reading the full item first.
 *
 * The dynamic expression builder converts { hsk_level: 3, timezone: 'Asia/Tokyo' }
 * into: SET #hsk_level = :hsk_level, #timezone = :timezone
 */
export async function updateUser(
  telegramId: number,
  fields: Partial<Omit<UserProfile, 'telegram_id'>>
): Promise<void> {
  const entries = Object.entries(fields).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return;

  // Build SET expression dynamically from the provided fields
  const setExpressions: string[] = [];
  const names: Record<string, string> = {};
  const values: Record<string, unknown> = {};

  for (const [key, value] of entries) {
    setExpressions.push(`#${key} = :${key}`);
    names[`#${key}`] = key;
    values[`:${key}`] = value;
  }

  // If is_active is being changed, update GSI1 projection accordingly.
  // Using keyof-typed constant so the compiler catches renames.
  if (IS_ACTIVE_KEY in fields) {
    if (fields[IS_ACTIVE_KEY]) {
      setExpressions.push('#GSI1PK = :gsi1pk', '#GSI1SK = :gsi1sk');
      names['#GSI1PK'] = 'GSI1PK';
      names['#GSI1SK'] = 'GSI1SK';
      values[':gsi1pk'] = ACTIVE_GSI1PK;
      values[':gsi1sk'] = userGSI1SK(telegramId);
    } else {
      // Remove GSI1 keys to drop the user from the active index
      setExpressions.push('#GSI1PK = :empty', '#GSI1SK = :empty');
      names['#GSI1PK'] = 'GSI1PK';
      names['#GSI1SK'] = 'GSI1SK';
      values[':empty'] = null;
    }
  }

  await docClient.send(new UpdateCommand({
    TableName: TABLE_NAME,
    Key: { PK: userPK(telegramId), SK: PROFILE_SK },
    UpdateExpression: `SET ${setExpressions.join(', ')}`,
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
  }));
}

/**
 * Queries GSI1 to find all active users.
 *
 * The scheduler calls this every minute. GSI1 only contains active users
 * (those with GSI1PK=ACTIVE), so we don't waste read capacity scanning
 * inactive users.
 *
 * Note: DynamoDB Query returns max 1MB per call. For >1000 users, we'd need
 * to paginate using LastEvaluatedKey. The while loop handles this automatically.
 */
export async function getActiveUsers(): Promise<UserProfile[]> {
  const users: UserProfile[] = [];
  let lastKey: Record<string, unknown> | undefined;

  do {
    const result = await docClient.send(new QueryCommand({
      TableName: TABLE_NAME,
      IndexName: 'GSI1',
      KeyConditionExpression: 'GSI1PK = :active',
      ExpressionAttributeValues: { ':active': ACTIVE_GSI1PK },
      ExclusiveStartKey: lastKey,
    }));

    for (const item of result.Items ?? []) {
      const { PK, SK, GSI1PK, GSI1SK, ...profile } = item;
      users.push(profile as UserProfile);
    }

    lastKey = result.LastEvaluatedKey;
  } while (lastKey);

  return users;
}

/**
 * Word storage and query operations.
 *
 * Each word is stored as a separate DynamoDB item under the user's partition:
 *   PK = USER#<telegram_id>
 *   SK = WORD#<sent_at_iso>
 *
 * GSI2 enables efficient date-based lookups:
 *   GSI2PK = USER#<telegram_id>
 *   GSI2SK = <YYYY-MM-DD>  (user's local date)
 *
 * Access patterns:
 * - hasWordsForDate()   → GSI2 query to check double-send prevention
 * - getWordsForDateRange() → GSI2 query for weekly recap
 * - getRecentWords()    → Main table query for exclude list (last ~200 words)
 * - saveWords()         → BatchWrite multiple word items at once
 */

import {
  QueryCommand,
  BatchWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import { docClient, TABLE_NAME } from './client.js';
import { userPK, wordSK } from './keys.js';

/** A word as returned from queries (without DynamoDB key fields). */
export interface StoredWord {
  chinese: string;
  pinyin: string;
  english: string;
  example_sentence: string;
  example_pinyin: string;
  example_english: string;
  sent_at: string;
  local_date: string;
}

/**
 * Checks if a user has already received words for a given local date.
 *
 * This is the core double-send prevention check. We query GSI2 which is
 * indexed by user + local_date, so this is a fast key lookup — not a scan.
 * We only need to know if ANY item exists (Limit: 1), not how many.
 */
export async function hasWordsForDate(
  telegramId: number,
  localDate: string
): Promise<boolean> {
  const result = await docClient.send(new QueryCommand({
    TableName: TABLE_NAME,
    IndexName: 'GSI2',
    KeyConditionExpression: 'GSI2PK = :pk AND GSI2SK = :date',
    ExpressionAttributeValues: {
      ':pk': userPK(telegramId),
      ':date': localDate,
    },
    Limit: 1,
    // Select ONLY the key — don't transfer full items over the network.
    // We just need to know if a match exists.
    Select: 'COUNT',
  }));

  return (result.Count ?? 0) > 0;
}

/**
 * Gets words for a date range (used by weekly recap).
 *
 * GSI2's sort key is the local date string (YYYY-MM-DD), so a BETWEEN query
 * efficiently returns only the words in the desired range without scanning
 * the user's entire word history.
 */
export async function getWordsForDateRange(
  telegramId: number,
  startDate: string,
  endDate: string
): Promise<StoredWord[]> {
  const words: StoredWord[] = [];
  let lastKey: Record<string, unknown> | undefined;

  do {
    const result = await docClient.send(new QueryCommand({
      TableName: TABLE_NAME,
      IndexName: 'GSI2',
      KeyConditionExpression: 'GSI2PK = :pk AND GSI2SK BETWEEN :start AND :end',
      ExpressionAttributeValues: {
        ':pk': userPK(telegramId),
        ':start': startDate,
        ':end': endDate,
      },
      ExclusiveStartKey: lastKey,
    }));

    for (const item of result.Items ?? []) {
      const { PK, SK, GSI1PK, GSI1SK, GSI2PK, GSI2SK, ...word } = item;
      words.push(word as StoredWord);
    }

    lastKey = result.LastEvaluatedKey;
  } while (lastKey);

  return words;
}

/**
 * Gets the most recent N words for a user (used for the exclude list).
 *
 * Queries the main table (not GSI2) because we want to sort by sent_at
 * timestamp, and the main table's SK (WORD#<iso>) is already sorted
 * chronologically. ScanIndexForward=false gives us newest first.
 *
 * We cap at 200 words to keep the AI prompt token count manageable.
 * After a year of 3 words/day (~1000 words), sending all of them would
 * bloat the prompt and cost more tokens than it's worth.
 */
export async function getRecentWords(
  telegramId: number,
  limit: number = 200
): Promise<string[]> {
  const result = await docClient.send(new QueryCommand({
    TableName: TABLE_NAME,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
    ExpressionAttributeValues: {
      ':pk': userPK(telegramId),
      ':prefix': 'WORD#',
    },
    // Newest first — SK is WORD#<iso_timestamp>, so reverse sort = newest
    ScanIndexForward: false,
    Limit: limit,
    // Only fetch the chinese field — that's all the exclude list needs
    ProjectionExpression: 'chinese',
  }));

  return (result.Items ?? []).map((item) => item.chinese as string);
}

/**
 * Saves multiple words to DynamoDB in a single batch write.
 *
 * Why BatchWrite instead of individual PutItems?
 * - One network round-trip instead of N (for 3 words, 1 call vs 3)
 * - DynamoDB charges per request, so batching is cheaper
 * - BatchWrite supports up to 25 items per call (we'll never hit this
 *   with daily_word_count capped at 10)
 *
 * Each word item includes both main table keys (PK/SK) and GSI2 keys
 * (GSI2PK/GSI2SK) so it appears in both the main table and the date index.
 */
export async function saveWords(
  telegramId: number,
  words: Omit<StoredWord, 'sent_at' | 'local_date'>[],
  localDate: string
): Promise<void> {
  const now = new Date().toISOString();
  const pk = userPK(telegramId);

  const putRequests = words.map((word, index) => {
    // Add index to timestamp to ensure unique sort keys when multiple words
    // are saved in the same millisecond
    const sentAt = new Date(Date.now() + index).toISOString();
    return {
      PutRequest: {
        Item: {
          PK: pk,
          SK: wordSK(sentAt),
          ...word,
          sent_at: sentAt,
          local_date: localDate,
          // GSI2 keys for date-based lookups
          GSI2PK: pk,
          GSI2SK: localDate,
        },
      },
    };
  });

  await docClient.send(new BatchWriteCommand({
    RequestItems: {
      [TABLE_NAME]: putRequests,
    },
  }));
}

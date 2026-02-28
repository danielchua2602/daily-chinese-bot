/**
 * Grammy session storage adapter using our single DynamoDB table.
 *
 * Grammy's conversations plugin needs to persist conversation state between
 * messages. In a long-running server, this would live in memory. But Lambda
 * is stateless — each invocation might be a different container — so we
 * store session data in DynamoDB.
 *
 * The adapter implements Grammy's StorageAdapter interface:
 * - read(key)         → GetItem
 * - write(key, value) → PutItem
 * - delete(key)       → DeleteItem
 *
 * Sessions are stored at PK=USER#<telegram_id>, SK=SESSION, colocated
 * with the user's other data in the single table.
 *
 * Why not @grammyjs/storage-dynamodb?
 * That package expects its own dedicated table. Since we're using single-table
 * design, we write a simple adapter that uses our existing table and key scheme.
 * It's only ~30 lines of code, so the dependency isn't worth it.
 */

import { GetCommand, PutCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, TABLE_NAME } from './client.js';
import { userPK, SESSION_SK } from './keys.js';

export interface SessionStorage<T> {
  read(key: string): Promise<T | undefined>;
  write(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
}

/**
 * Creates a Grammy-compatible storage adapter backed by DynamoDB.
 *
 * The key parameter Grammy passes is the chat ID (a number as a string).
 * We convert it to our PK/SK format internally.
 */
export function createSessionStorage<T>(): SessionStorage<T> {
  return {
    async read(key: string): Promise<T | undefined> {
      const result = await docClient.send(new GetCommand({
        TableName: TABLE_NAME,
        Key: { PK: userPK(Number(key)), SK: SESSION_SK },
      }));

      if (!result.Item) return undefined;

      // The session data is stored in a 'data' attribute to avoid
      // key collisions with our PK/SK fields
      return result.Item.data as T;
    },

    async write(key: string, value: T): Promise<void> {
      await docClient.send(new PutCommand({
        TableName: TABLE_NAME,
        Item: {
          PK: userPK(Number(key)),
          SK: SESSION_SK,
          data: value,
        },
      }));
    },

    async delete(key: string): Promise<void> {
      await docClient.send(new DeleteCommand({
        TableName: TABLE_NAME,
        Key: { PK: userPK(Number(key)), SK: SESSION_SK },
      }));
    },
  };
}

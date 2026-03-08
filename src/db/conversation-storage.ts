/**
 * DynamoDB storage adapter for Grammy conversations plugin v2.
 *
 * The conversations plugin needs to persist multi-step conversation state
 * (e.g., onboarding wizards) across messages. Since Lambda is stateless,
 * we store this in DynamoDB alongside the user's other data.
 *
 * This adapter implements the VersionedStateStorage interface from
 * @grammyjs/conversations, which differs from the regular session adapter:
 * - State is wrapped in a version envelope: { version, state }
 * - The version field enables optimistic concurrency control so the plugin
 *   can detect stale reads when two updates race
 *
 * Conversation data is stored at PK=USER#<telegram_id>, SK=CONVO, colocated
 * with the user's session and profile in the single table.
 */

import { GetCommand, PutCommand, DeleteCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, TABLE_NAME } from "./client.js";
import { userPK, CONVO_SK } from "./keys.js";
import type {
  VersionedStateStorage,
  VersionedState,
  ConversationData,
} from "@grammyjs/conversations";

/**
 * Creates a conversations-plugin-compatible storage adapter backed by DynamoDB.
 *
 * The key parameter the plugin passes is ctx.chatId as a string.
 * We convert it to our PK/SK format internally.
 */
export function createConversationStorage(): VersionedStateStorage<string, ConversationData> {
  return {
    async read(key: string): Promise<VersionedState<ConversationData> | undefined> {
      const result = await docClient.send(new GetCommand({
        TableName: TABLE_NAME,
        Key: { PK: userPK(Number(key)), SK: CONVO_SK },
      }));

      if (!result.Item) return undefined;

      return result.Item.data as VersionedState<ConversationData>;
    },

    async write(key: string, state: VersionedState<ConversationData>): Promise<void> {
      await docClient.send(new PutCommand({
        TableName: TABLE_NAME,
        Item: {
          PK: userPK(Number(key)),
          SK: CONVO_SK,
          data: state,
        },
      }));
    },

    async delete(key: string): Promise<void> {
      await docClient.send(new DeleteCommand({
        TableName: TABLE_NAME,
        Key: { PK: userPK(Number(key)), SK: CONVO_SK },
      }));
    },
  };
}

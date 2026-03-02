/**
 * DynamoDB document client singleton.
 *
 * Created at module level (outside any function) so Lambda reuses it across
 * warm-start invocations. This avoids re-creating TCP/TLS connections on
 * every request — the AWS-recommended pattern for Lambda.
 *
 * DynamoDBDocumentClient vs DynamoDBClient:
 * - DynamoDBClient is the low-level client — you must manually marshal
 *   JavaScript objects into DynamoDB's { S: "string", N: "123" } format.
 * - DynamoDBDocumentClient wraps it and handles marshalling automatically,
 *   so you work with plain JS objects. Much less boilerplate.
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

const rawClient = new DynamoDBClient({
  region: process.env.AWS_REGION ?? "ap-southeast-1",
});

export const docClient = DynamoDBDocumentClient.from(rawClient, {
  marshallOptions: {
    // Don't convert empty strings to null — we want to preserve them
    convertEmptyValues: false,
    // Remove undefined values instead of sending them as null
    removeUndefinedValues: true,
  },
});

export const TABLE_NAME = process.env.DYNAMODB_TABLE_NAME ?? "LearnChineseBot";

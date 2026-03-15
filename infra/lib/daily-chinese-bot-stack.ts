/**
 * What this creates:
 * 1. DynamoDB table (single-table design) with 2 GSIs
 * 2. Bot Lambda (handles Telegram webhooks)
 * 3. Scheduler Lambda (runs every minute via EventBridge)
 * 4. API Gateway (receives Telegram webhook POST requests)
 * 5. EventBridge Scheduler (triggers scheduler every minute)
 *
 */

import * as cdk from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as lambda from "aws-cdk-lib/aws-lambda-nodejs";
import * as lambdaRuntime from "aws-cdk-lib/aws-lambda";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import * as scheduler from "aws-cdk-lib/aws-scheduler";
import * as schedulerTargets from "aws-cdk-lib/aws-scheduler-targets";
import type { Construct } from "constructs";
import * as path from "node:path";

export class DailyChineseBotStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ─── DynamoDB Table ───────────────────────────────────────────
    // Single table for all entities (users, words, sessions).
    // PAY_PER_REQUEST means we pay per read/write — no capacity planning.
    // PITR (point-in-time recovery) enables continuous backups.
    const table = new dynamodb.Table(this, "DailyChineseBot", {
      tableName: "DailyChineseBot",
      partitionKey: { name: "PK", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "SK", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      // DESTROY means the table is deleted when the stack is deleted.
      // For production, change to RETAIN to prevent accidental data loss.
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // GSI1: find all active users (scheduler uses this)
    // The scheduler queries GSI1PK = 'ACTIVE' to get only active users,
    // avoiding a full table scan.
    table.addGlobalSecondaryIndex({
      indexName: "GSI1",
      partitionKey: { name: "GSI1PK", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "GSI1SK", type: dynamodb.AttributeType.STRING },
    });

    // GSI2: query words by user + local date (double-send check + recap)
    // Enables efficient "has user X received words on date Y?" lookups.
    table.addGlobalSecondaryIndex({
      indexName: "GSI2",
      partitionKey: { name: "GSI2PK", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "GSI2SK", type: dynamodb.AttributeType.STRING },
    });

    // ─── SSM Parameters ─────────────────────────────────────────
    // Secrets are stored in SSM Parameter Store (SecureString) and
    // resolved at deploy time via CloudFormation dynamic references.
    // The {{resolve:ssm:...}} syntax tells CloudFormation to fetch
    // the value at deploy time — only the reference string appears
    // in the template, not the actual secret.
    const botToken = "{{resolve:ssm:/daily-chinese-bot/bot-token}}";
    const encryptionKey = "{{resolve:ssm:/daily-chinese-bot/encryption-key}}";

    // ─── Shared Lambda configuration ─────────────────────────────
    // NodejsFunction uses esbuild to bundle TypeScript automatically —
    // no separate build step needed for Lambda deployment.
    const srcDir = path.join(__dirname, "..", "..", "src");

    const sharedEnv = {
      DYNAMODB_TABLE_NAME: table.tableName,
      BOT_TOKEN: botToken,
      ENCRYPTION_KEY: encryptionKey,
    };

    // ─── Bot Lambda ──────────────────────────────────────────────
    // Handles incoming Telegram webhook requests.
    // 30s timeout is generous — most requests complete in <5s, but
    // AI API calls during /today can take 10-15s.
    const botFn = new lambda.NodejsFunction(this, "BotHandler", {
      entry: path.join(srcDir, "handlers", "bot.ts"),
      handler: "handler",
      runtime: lambdaRuntime.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      environment: sharedEnv,
    });

    // ─── Scheduler Lambda ────────────────────────────────────────
    // Runs every minute to check which users need words or recaps.
    // 5-minute timeout to handle many users (each needs an AI API call).
    const schedulerFn = new lambda.NodejsFunction(this, "SchedulerHandler", {
      entry: path.join(srcDir, "handlers", "scheduler.ts"),
      handler: "handler",
      runtime: lambdaRuntime.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.minutes(5),
      memorySize: 256,
      environment: sharedEnv,
    });

    // ─── API Gateway ─────────────────────────────────────────────
    // Creates a REST API with a single POST /webhook endpoint.
    // Telegram sends webhook updates as POST requests with JSON body.
    const api = new apigateway.RestApi(this, "BotApi", {
      restApiName: "DailyChineseBotApi",
    });
    api.root.addResource("webhook").addMethod("POST", new apigateway.LambdaIntegration(botFn));

    // ─── EventBridge Scheduler ─────────────────────────────────────
    // Triggers the scheduler Lambda every minute.
    new scheduler.Schedule(this, "SchedulerSchedule", {
      schedule: scheduler.ScheduleExpression.rate(cdk.Duration.minutes(1)),
      target: new schedulerTargets.LambdaInvoke(schedulerFn),
      enabled: true,
    });

    // ─── Permissions ─────────────────────────────────────────────
    table.grantReadWriteData(botFn);
    table.grantReadWriteData(schedulerFn);

    // ─── Outputs ─────────────────────────────────────────────────
    // Print the API Gateway URL after deploy — needed to register
    // the Telegram webhook.
    new cdk.CfnOutput(this, "WebhookUrl", {
      value: `${api.url}webhook`,
      description: "URL to register as Telegram webhook",
    });
  }
}

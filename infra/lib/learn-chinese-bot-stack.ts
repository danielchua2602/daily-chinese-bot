/**
 * CDK Stack — defines all AWS resources for the Learn Chinese Bot.
 *
 * What this creates:
 * 1. DynamoDB table (single-table design) with 2 GSIs
 * 2. Bot Lambda (handles Telegram webhooks)
 * 3. Scheduler Lambda (runs every minute via EventBridge)
 * 4. API Gateway (receives Telegram webhook POST requests)
 * 5. EventBridge rule (triggers scheduler every minute)
 *
 * CDK advantage over raw CloudFormation:
 * - Type-safe: the compiler catches invalid property names
 * - Concise: ~80 lines vs ~300+ lines of YAML
 * - Smart defaults: NodejsFunction auto-bundles with esbuild, sets up
 *   IAM execution roles, configures log groups, etc.
 * - .grantReadWriteData() generates the minimal IAM policy automatically
 *   instead of hand-writing { Effect: Allow, Action: dynamodb:*, Resource: ... }
 */

import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda-nodejs';
import * as lambdaRuntime from 'aws-cdk-lib/aws-lambda';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import type { Construct } from 'constructs';
import * as path from 'node:path';

export class LearnChineseBotStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ─── DynamoDB Table ───────────────────────────────────────────
    // Single table for all entities (users, words, sessions).
    // PAY_PER_REQUEST means we pay per read/write — no capacity planning.
    // PITR (point-in-time recovery) enables continuous backups.
    const table = new dynamodb.Table(this, 'LearnChineseBot', {
      tableName: 'LearnChineseBot',
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecovery: true,
      // DESTROY means the table is deleted when the stack is deleted.
      // For production, change to RETAIN to prevent accidental data loss.
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // GSI1: find all active users (scheduler uses this)
    // The scheduler queries GSI1PK = 'ACTIVE' to get only active users,
    // avoiding a full table scan.
    table.addGlobalSecondaryIndex({
      indexName: 'GSI1',
      partitionKey: { name: 'GSI1PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'GSI1SK', type: dynamodb.AttributeType.STRING },
    });

    // GSI2: query words by user + local date (double-send check + recap)
    // Enables efficient "has user X received words on date Y?" lookups.
    table.addGlobalSecondaryIndex({
      indexName: 'GSI2',
      partitionKey: { name: 'GSI2PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'GSI2SK', type: dynamodb.AttributeType.STRING },
    });

    // ─── Shared Lambda configuration ─────────────────────────────
    // Path to the src/ directory relative to this CDK file.
    // NodejsFunction uses esbuild to bundle TypeScript automatically —
    // no separate build step needed for Lambda deployment.
    const srcDir = path.join(__dirname, '..', '..', 'src');

    const sharedEnv = {
      DYNAMODB_TABLE_NAME: table.tableName,
      // BOT_TOKEN and ENCRYPTION_KEY will be set manually after first deploy
      // (or via AWS Secrets Manager in production)
    };

    // ─── Bot Lambda ──────────────────────────────────────────────
    // Handles incoming Telegram webhook requests.
    // 30s timeout is generous — most requests complete in <5s, but
    // AI API calls during /today can take 10-15s.
    const botFn = new lambda.NodejsFunction(this, 'BotHandler', {
      entry: path.join(srcDir, 'handlers', 'bot.ts'),
      handler: 'handler',
      runtime: lambdaRuntime.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      environment: sharedEnv,
    });

    // ─── Scheduler Lambda ────────────────────────────────────────
    // Runs every minute to check which users need words or recaps.
    // 5-minute timeout to handle many users (each needs an AI API call).
    const schedulerFn = new lambda.NodejsFunction(this, 'SchedulerHandler', {
      entry: path.join(srcDir, 'handlers', 'scheduler.ts'),
      handler: 'handler',
      runtime: lambdaRuntime.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.minutes(5),
      memorySize: 256,
      environment: sharedEnv,
    });

    // ─── API Gateway ─────────────────────────────────────────────
    // Creates a REST API with a single POST /webhook endpoint.
    // Telegram sends webhook updates as POST requests with JSON body.
    const api = new apigateway.RestApi(this, 'BotApi', {
      restApiName: 'LearnChineseBotApi',
    });
    api.root.addResource('webhook').addMethod(
      'POST',
      new apigateway.LambdaIntegration(botFn)
    );

    // ─── EventBridge Rule ────────────────────────────────────────
    // Triggers the scheduler Lambda every minute.
    // EventBridge is essentially a managed cron service — more reliable
    // than in-process node-cron because AWS guarantees invocation.
    new events.Rule(this, 'ScheduleRule', {
      schedule: events.Schedule.rate(cdk.Duration.minutes(1)),
      targets: [new targets.LambdaFunction(schedulerFn)],
    });

    // ─── Permissions ─────────────────────────────────────────────
    // .grantReadWriteData() creates an IAM policy allowing the Lambda
    // to perform GetItem, PutItem, Query, BatchWriteItem, etc. on this
    // specific table (and its GSIs). Much safer than Action: dynamodb:*.
    table.grantReadWriteData(botFn);
    table.grantReadWriteData(schedulerFn);

    // ─── Outputs ─────────────────────────────────────────────────
    // Print the API Gateway URL after deploy — needed to register
    // the Telegram webhook.
    new cdk.CfnOutput(this, 'WebhookUrl', {
      value: `${api.url}webhook`,
      description: 'URL to register as Telegram webhook',
    });
  }
}

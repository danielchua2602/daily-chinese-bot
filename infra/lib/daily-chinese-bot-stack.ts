/**
 * What this creates:
 * 1. DynamoDB table (single-table design) with 2 GSIs
 * 2. Bot Lambda (handles Telegram webhooks, secured with secret token)
 * 3. Scheduler Lambda (runs every 15 min via EventBridge)
 * 4. API Gateway (receives Telegram webhook POST requests)
 * 5. EventBridge Scheduler (triggers scheduler every 15 min)
 * 6. CloudWatch alarms + SNS email notifications (if ALARM_EMAIL is set)
 */

import * as cdk from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as lambda from "aws-cdk-lib/aws-lambda-nodejs";
import * as lambdaRuntime from "aws-cdk-lib/aws-lambda";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as cloudwatchActions from "aws-cdk-lib/aws-cloudwatch-actions";
import * as sns from "aws-cdk-lib/aws-sns";
import * as snsSubscriptions from "aws-cdk-lib/aws-sns-subscriptions";
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
    // Secrets are stored in SSM Parameter Store (String type).
    // Lambda env vars don't support ssm-secure references, and
    // {{resolve:ssm:...}} can't read SecureString parameters either,
    // so plain String is the only option for Lambda env var injection.
    // Access is still controlled by IAM — only these Lambdas can read them.
    const botToken = "{{resolve:ssm:/daily-chinese-bot/bot-token}}";
    const encryptionKey = "{{resolve:ssm:/daily-chinese-bot/encryption-key}}";
    const webhookSecret = "{{resolve:ssm:/daily-chinese-bot/webhook-secret}}";

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
      environment: {
        ...sharedEnv,
        WEBHOOK_SECRET: webhookSecret,
        ALLOWED_USERS: process.env.ALLOWED_USERS ?? "",
      },
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
    // Triggers the scheduler Lambda at :00, :15, :30, :45 every hour.
    new scheduler.Schedule(this, "SchedulerSchedule", {
      schedule: scheduler.ScheduleExpression.expression('cron(0/15 * * * ? *)'),
      target: new schedulerTargets.LambdaInvoke(schedulerFn),
      enabled: true,
    });

    // ─── Permissions ─────────────────────────────────────────────
    table.grantReadWriteData(botFn);
    table.grantReadWriteData(schedulerFn);

    // ─── Monitoring ──────────────────────────────────────────────
    // SNS topic for alarm notifications. Alarms publish here,
    // and email subscribers receive the alerts.
    const alarmTopic = new sns.Topic(this, "AlarmTopic", {
      displayName: "DailyChineseBot Alarms",
    });

    // Only subscribe if ALARM_EMAIL is set in the environment.
    // This is evaluated at synth time (not deploy time), so set it
    // before running `cdk deploy`: ALARM_EMAIL=you@example.com npx cdk deploy
    const alarmEmail = process.env.ALARM_EMAIL;
    if (alarmEmail) {
      alarmTopic.addSubscription(
        new snsSubscriptions.EmailSubscription(alarmEmail),
      );
    }

    const alarmAction = new cloudwatchActions.SnsAction(alarmTopic);

    // Bot Lambda errors — "the bot is broken for users right now"
    botFn
      .metricErrors({ period: cdk.Duration.minutes(5) })
      .createAlarm(this, "BotLambdaErrorAlarm", {
        alarmDescription: "Bot Lambda errors >= 1 in 5 minutes",
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      })
      .addAlarmAction(alarmAction);

    // Scheduler Lambda errors — "daily words / recaps aren't being delivered"
    schedulerFn
      .metricErrors({ period: cdk.Duration.minutes(5) })
      .createAlarm(this, "SchedulerLambdaErrorAlarm", {
        alarmDescription: "Scheduler Lambda errors >= 1 in 5 minutes",
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      })
      .addAlarmAction(alarmAction);

    // API Gateway 5xx — "requests aren't even reaching Lambda"
    api
      .metricServerError({ period: cdk.Duration.minutes(5) })
      .createAlarm(this, "ApiGateway5xxAlarm", {
        alarmDescription: "API Gateway 5xx errors >= 1 in 5 minutes",
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      })
      .addAlarmAction(alarmAction);

    // ─── Outputs ─────────────────────────────────────────────────
    // Print the API Gateway URL after deploy — needed to register
    // the Telegram webhook.
    new cdk.CfnOutput(this, "WebhookUrl", {
      value: `${api.url}webhook`,
      description: "URL to register as Telegram webhook",
    });
  }
}

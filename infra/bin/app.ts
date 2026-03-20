#!/usr/bin/env node
/**
 * CDK app entry point.
 *
 * This is the file that `cdk deploy` runs. It creates the CDK App
 * (a container for stacks) and instantiates our stack.
 *
 * CDK hierarchy: App → Stack → Constructs (Lambda, DynamoDB, etc.)
 * - App: the root. You can have multiple stacks in one app (e.g., staging + prod).
 * - Stack: maps 1:1 to a CloudFormation stack. All resources in a stack are
 *   deployed/destroyed together.
 * - Constructs: individual resources (table, function, API gateway).
 */

import "dotenv/config";
import * as cdk from "aws-cdk-lib";
import { DailyChineseBotStack } from "../lib/daily-chinese-bot-stack";

const app = new cdk.App();

new DailyChineseBotStack(app, "DailyChineseBotStack", {
  env: {
    region: "ap-southeast-1",
  },
});

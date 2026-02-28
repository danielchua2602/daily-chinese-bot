/**
 * Bot Lambda entry point — Telegram webhook handler.
 *
 * This is the function that API Gateway invokes when Telegram sends a
 * webhook update (user message, button press, etc.).
 *
 * Architecture:
 * Telegram → API Gateway (POST /webhook) → this Lambda → Grammy processes → replies to Telegram
 *
 * Grammy's webhookCallback() adapter handles the Lambda↔Grammy translation:
 * - Parses the API Gateway event into a Telegram Update object
 * - Feeds it to Grammy's middleware pipeline (commands, conversations, etc.)
 * - Returns the appropriate API Gateway response
 *
 * The 'aws-lambda-async' adapter is used because our API Gateway is
 * configured with Lambda proxy integration (the default for CDK).
 */

import { Bot } from 'grammy';
import { webhookCallback } from 'grammy';
import { handleStart, handleHelp } from '../bot/commands.js';

/**
 * Bot instance — created at module level for Lambda warm-start reuse.
 *
 * Same singleton pattern as the DynamoDB client: the Bot instance and its
 * middleware pipeline are built once during cold start, then reused across
 * invocations. This avoids re-registering commands and conversations on
 * every webhook call.
 */
const bot = new Bot(process.env.BOT_TOKEN!);

// Register command handlers
bot.command('start', handleStart);
bot.command('help', handleHelp);

/**
 * The Lambda handler itself.
 *
 * webhookCallback returns an async function matching Lambda's handler
 * signature: (event, context) => Promise<APIGatewayProxyResult>.
 * We export it directly — no wrapper needed.
 */
export const handler = webhookCallback(bot, 'aws-lambda-async');

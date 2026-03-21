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
 *
 * Middleware ordering matters:
 * 1. conversations() — intercepts updates for active conversations
 * 2. createConversation() — registers conversation builders
 * 3. command handlers — route slash commands
 */

import { Bot, webhookCallback } from "grammy";
import { conversations, createConversation } from "@grammyjs/conversations";
import type { BotContext } from "../bot/types.js";
import { createConversationStorage } from "../db/conversation-storage.js";
import { handleStart, handleHelp, handleSettings, handleStop, handleResume, handleToday } from "../bot/commands.js";
import { setupConversation, SETUP_CONVERSATION_ID } from "../bot/conversations/setup.js";
import { settimeConversation, SETTIME_CONVERSATION_ID } from "../bot/conversations/settime.js";
import { setrecapConversation, SETRECAP_CONVERSATION_ID } from "../bot/conversations/setrecap.js";
import { sethskConversation, SETHSK_CONVERSATION_ID } from "../bot/conversations/sethsk.js";

/**
 * Bot instance — created at module level for Lambda warm-start reuse.
 *
 * Same singleton pattern as the DynamoDB client: the Bot instance and its
 * middleware pipeline are built once during cold start, then reused across
 * invocations. This avoids re-registering commands and conversations on
 * every webhook call.
 */
const bot = new Bot<BotContext>(process.env.BOT_TOKEN!);

// 1. Install conversations plugin with DynamoDB persistence
bot.use(
  conversations({
    storage: {
      type: "key",
      adapter: createConversationStorage(),
    },
  }),
);

// 2. Register conversation builders (order determines priority for parallel convos)
bot.use(createConversation(setupConversation, { id: SETUP_CONVERSATION_ID }));
bot.use(createConversation(settimeConversation, { id: SETTIME_CONVERSATION_ID }));
bot.use(createConversation(setrecapConversation, { id: SETRECAP_CONVERSATION_ID }));
bot.use(createConversation(sethskConversation, { id: SETHSK_CONVERSATION_ID }));

// 3. Register command handlers
bot.command("start", handleStart);
bot.command("help", handleHelp);
bot.command("setup", (ctx) => ctx.conversation.enter(SETUP_CONVERSATION_ID));
bot.command("settime", (ctx) => ctx.conversation.enter(SETTIME_CONVERSATION_ID));
bot.command("setrecap", (ctx) => ctx.conversation.enter(SETRECAP_CONVERSATION_ID));
bot.command("sethsk", (ctx) => ctx.conversation.enter(SETHSK_CONVERSATION_ID));
bot.command("settings", handleSettings);
bot.command("today", handleToday);
bot.command("stop", handleStop);
bot.command("resume", handleResume);

/**
 * The Lambda handler itself.
 *
 * webhookCallback returns an async function matching Lambda's handler
 * signature: (event, context) => Promise<APIGatewayProxyResult>.
 * We export it directly — no wrapper needed.
 */
export const handler = webhookCallback(bot, "aws-lambda-async", {
  secretToken: process.env.WEBHOOK_SECRET,
});

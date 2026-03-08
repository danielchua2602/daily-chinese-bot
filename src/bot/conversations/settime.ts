/**
 * Conversation to change the daily word delivery time.
 *
 * Presents hour and minute pickers via inline keyboards, then persists
 * the chosen schedule to DynamoDB.
 */

import type { Conversation } from "@grammyjs/conversations";
import type { Context } from "grammy";
import type { BotContext } from "../types.js";
import { updateUser } from "../../db/users.js";
import { hourKeyboard, minuteKeyboard } from "../keyboards.js";

export const SETTIME_CONVERSATION_ID = "settime";

/** Allows the user to pick a new daily delivery time (hour + minute). */
export async function settimeConversation(
  conversation: Conversation<BotContext, Context>,
  ctx: Context
): Promise<void> {
  // Step 1 — pick hour
  await ctx.reply("What hour should I send your daily words?", {
    reply_markup: hourKeyboard(),
  });

  const hourCtx = await conversation.waitForCallbackQuery(/^hour:\d+$/, {
    otherwise: async (ctx) => {
      await ctx.reply("Please tap one of the hour buttons above.");
    },
  });
  const send_hour = parseInt(hourCtx.callbackQuery.data!.replace("hour:", ""), 10);
  await hourCtx.answerCallbackQuery();

  // Step 2 — pick minute
  await ctx.reply("And which minute?", {
    reply_markup: minuteKeyboard(),
  });

  const minCtx = await conversation.waitForCallbackQuery(/^min:\d+$/, {
    otherwise: async (ctx) => {
      await ctx.reply("Please tap one of the minute buttons above.");
    },
  });
  const send_minute = parseInt(minCtx.callbackQuery.data!.replace("min:", ""), 10);
  await minCtx.answerCallbackQuery();

  // Step 3 — persist
  await conversation.external(() =>
    updateUser(ctx.from!.id, { send_hour, send_minute })
  );

  // Step 4 — confirm
  const hh = send_hour.toString().padStart(2, "0");
  const mm = send_minute.toString().padStart(2, "0");
  await ctx.reply(`Daily delivery time updated to ${hh}:${mm}.`);
}

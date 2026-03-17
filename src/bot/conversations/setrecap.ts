/**
 * Conversation to change weekly recap settings.
 *
 * Presents day-of-week, hour, and minute pickers via inline keyboards,
 * then persists the chosen recap schedule to DynamoDB.
 */

import type { Conversation } from "@grammyjs/conversations";
import type { Context } from "grammy";
import type { BotContext } from "../types.js";
import { updateUser } from "../../db/users.js";
import type { DayName } from "../../utils/timezone.js";
import { dayOfWeekKeyboard, hourKeyboard, minuteKeyboard } from "../keyboards.js";

export const SETRECAP_CONVERSATION_ID = "setrecap";

/** Allows the user to pick a new weekly recap day and time. */
export async function setrecapConversation(
  conversation: Conversation<BotContext, Context>,
  ctx: Context
): Promise<void> {
  // Step 1 — pick day of week
  await ctx.reply("Which day should I send your weekly recap?", {
    reply_markup: dayOfWeekKeyboard(),
  });

  const dayCtx = await conversation.waitForCallbackQuery(/^day:/, {
    otherwise: async (ctx) => {
      await ctx.reply("Please tap one of the day buttons above.");
    },
  });
  const recap_day = dayCtx.callbackQuery.data!.replace("day:", "") as DayName;
  await dayCtx.answerCallbackQuery();

  // Step 2 — pick hour
  await ctx.reply("What hour should the recap arrive?", {
    reply_markup: hourKeyboard(),
  });

  const hourCtx = await conversation.waitForCallbackQuery(/^hour:\d+$/, {
    otherwise: async (ctx) => {
      await ctx.reply("Please tap one of the hour buttons above.");
    },
  });
  const recap_hour = parseInt(hourCtx.callbackQuery.data!.replace("hour:", ""), 10);
  await hourCtx.answerCallbackQuery();

  // Step 3 — pick minute
  await ctx.reply("And which minute?", {
    reply_markup: minuteKeyboard(),
  });

  const minCtx = await conversation.waitForCallbackQuery(/^min:\d+$/, {
    otherwise: async (ctx) => {
      await ctx.reply("Please tap one of the minute buttons above.");
    },
  });
  const recap_minute = parseInt(minCtx.callbackQuery.data!.replace("min:", ""), 10);
  await minCtx.answerCallbackQuery();

  // Step 4 — persist
  await conversation.external(() =>
    updateUser(ctx.from!.id, { recap_day, recap_hour, recap_minute })
  );

  // Step 5 — confirm
  const dayCapitalized = recap_day.charAt(0).toUpperCase() + recap_day.slice(1);
  const hh = recap_hour.toString().padStart(2, "0");
  const mm = recap_minute.toString().padStart(2, "0");
  await ctx.reply(`Weekly recap updated to ${dayCapitalized} at ${hh}:${mm}.`);
}

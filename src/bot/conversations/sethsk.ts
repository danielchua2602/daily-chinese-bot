/**
 * Conversation to change the user's HSK level.
 *
 * Presents HSK 1-6 buttons via an inline keyboard, then persists the
 * chosen level to DynamoDB.
 */

import type { Conversation } from "@grammyjs/conversations";
import type { Context } from "grammy";
import type { BotContext } from "../types.js";
import { updateUser } from "../../db/users.js";
import { hskLevelKeyboard } from "../keyboards.js";

export const SETHSK_CONVERSATION_ID = "sethsk";

/** Allows the user to pick a new HSK level (1-6). */
export async function sethskConversation(
  conversation: Conversation<BotContext, Context>,
  ctx: Context
): Promise<void> {
  // Step 1 — pick HSK level
  await ctx.reply("Which HSK level would you like?", {
    reply_markup: hskLevelKeyboard(),
  });

  const hskCtx = await conversation.waitForCallbackQuery(/^hsk:[1-6]$/, {
    otherwise: async (ctx) => {
      await ctx.reply("Please tap one of the HSK level buttons above.");
    },
  });
  const hsk_level = parseInt(hskCtx.callbackQuery.data!.replace("hsk:", ""), 10);
  await hskCtx.answerCallbackQuery();

  // Step 2 — persist
  await conversation.external(() =>
    updateUser(ctx.from!.id, { hsk_level })
  );

  // Step 3 — confirm
  await ctx.reply(`HSK level updated to ${hsk_level}.`);
}

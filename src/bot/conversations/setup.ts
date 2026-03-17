/**
 * Main onboarding conversation for the Learn Chinese bot.
 *
 * Uses grammY conversations plugin v2 (replay model). Every incoming update
 * causes this function to re-run from scratch; the plugin transparently
 * replays prior I/O so execution reaches the "current" step. Because of
 * this, all side effects (DB writes, encryption) MUST be wrapped in
 * `conversation.external()` so they only execute once.
 *
 * Flow:
 * 1. Choose AI provider
 * 2. Enter API key (encrypted, message deleted)
 * 3. Choose HSK level
 * 4. Choose timezone (city picker or manual IANA entry)
 * 5. Choose daily send hour
 * 6. Choose daily send minute
 * 7. Choose daily word count
 * 8. Choose weekly recap day
 * 9. Choose recap hour + minute
 * 10. Save profile to DynamoDB and show confirmation
 */

import type { Conversation } from "@grammyjs/conversations";
import type { Context } from "grammy";
import type { BotContext } from "../types.js";
import type { UserProfile } from "../../db/users.js";
import { upsertUser } from "../../db/users.js";
import { encrypt } from "../../utils/crypto.js";
import { validateTimezone } from "../../utils/timezone.js";
import type { DayName } from "../../utils/timezone.js";
import {
  aiProviderKeyboard,
  hskLevelKeyboard,
  timezoneCityKeyboard,
  hourKeyboard,
  minuteKeyboard,
  wordCountKeyboard,
  dayOfWeekKeyboard,
} from "../keyboards.js";
import { AI_PROVIDERS, PROVIDER_DISPLAY } from "../constants.js";
import type { AiProviderId } from "../constants.js";

export const SETUP_CONVERSATION_ID = "setup";

/** Zero-pad a number to two digits. */
function pad(n: number): string {
  return n.toString().padStart(2, "0");
}

export async function setupConversation(conversation: Conversation<BotContext, Context>, ctx: Context): Promise<void> {
  // ---------- Step 1: AI Provider ----------
  await ctx.reply(
    "Welcome! Let's set up your daily Chinese vocabulary bot.\n\n" + "Which AI provider would you like to use?",
    { reply_markup: aiProviderKeyboard() },
  );

  const providerPattern = new RegExp(`^provider:(${AI_PROVIDERS.map((p) => p.id).join("|")})$`);
  const providerCtx = await conversation.waitForCallbackQuery(providerPattern, {
    otherwise: (ctx) => ctx.reply("Please tap one of the buttons above."),
  });
  const aiProvider = providerCtx.callbackQuery.data!.replace("provider:", "") as AiProviderId;
  await providerCtx.answerCallbackQuery();

  // ---------- Step 2: API Key ----------
  await ctx.reply(
    `Great choice! Now send me your ${PROVIDER_DISPLAY[aiProvider]} API key.\n\n` +
      "Your key will be encrypted before storage. " +
      "I'll try to delete your message right after for security.",
  );

  const apiKeyCtx = await conversation.waitFor("message:text", {
    otherwise: (ctx) => ctx.reply("Please send your API key as a text message."),
  });
  const apiKeyText = apiKeyCtx.message.text;

  const encryptedKey = await conversation.external(() => encrypt(apiKeyText));

  // Best-effort deletion of the message containing the API key
  try {
    await apiKeyCtx.deleteMessage();
  } catch {
    // Deletion can fail if the bot lacks permission — that's OK
  }

  // ---------- Step 3: HSK Level ----------
  await ctx.reply("What HSK level are you studying?", {
    reply_markup: hskLevelKeyboard(),
  });

  const hskCtx = await conversation.waitForCallbackQuery(/^hsk:[1-6]$/, {
    otherwise: (ctx) => ctx.reply("Please tap one of the buttons above."),
  });
  const hskLevel = parseInt(hskCtx.callbackQuery.data!.split(":")[1], 10);
  await hskCtx.answerCallbackQuery();

  // ---------- Step 4: Timezone ----------
  await ctx.reply("Pick your timezone (for scheduling daily words):", {
    reply_markup: timezoneCityKeyboard(),
  });

  const tzCtx = await conversation.waitForCallbackQuery(/^tz:/, {
    otherwise: (ctx) => ctx.reply("Please tap one of the buttons above."),
  });
  let timezone = tzCtx.callbackQuery.data!.replace("tz:", "");
  await tzCtx.answerCallbackQuery();

  if (timezone === "other") {
    // Manual IANA timezone entry with validation loop
    await ctx.reply("Type your IANA timezone (e.g. America/New_York, Europe/London):");

    let validatedTz: string | null = null;
    while (validatedTz === null) {
      const tzInput = await conversation.form.text({
        otherwise: (ctx) => ctx.reply("Please send a text message with your timezone."),
      });
      validatedTz = await conversation.external(() => validateTimezone(tzInput));

      if (validatedTz === null) {
        await ctx.reply(
          "That doesn't look like a valid IANA timezone. " + "Please try again (e.g. Asia/Tokyo, US/Eastern):",
        );
      }
    }
    timezone = validatedTz;
  }

  // ---------- Step 5: Daily send hour ----------
  await ctx.reply("What hour should I send your daily words?", {
    reply_markup: hourKeyboard(),
  });

  const hourCtx = await conversation.waitForCallbackQuery(/^hour:\d+$/, {
    otherwise: (ctx) => ctx.reply("Please tap one of the buttons above."),
  });
  const sendHour = parseInt(hourCtx.callbackQuery.data!.split(":")[1], 10);
  await hourCtx.answerCallbackQuery();

  // ---------- Step 6: Daily send minute ----------
  await ctx.reply("And which minute?", {
    reply_markup: minuteKeyboard(),
  });

  const minCtx = await conversation.waitForCallbackQuery(/^min:\d+$/, {
    otherwise: (ctx) => ctx.reply("Please tap one of the buttons above."),
  });
  const sendMinute = parseInt(minCtx.callbackQuery.data!.split(":")[1], 10);
  await minCtx.answerCallbackQuery();

  // ---------- Step 7: Word count ----------
  await ctx.reply("How many new words per day?", {
    reply_markup: wordCountKeyboard(),
  });

  const wcCtx = await conversation.waitForCallbackQuery(/^wc:\d+$/, {
    otherwise: (ctx) => ctx.reply("Please tap one of the buttons above."),
  });
  const dailyWordCount = parseInt(wcCtx.callbackQuery.data!.split(":")[1], 10);
  await wcCtx.answerCallbackQuery();

  // ---------- Step 8: Recap day ----------
  await ctx.reply("Which day should I send your weekly recap?", {
    reply_markup: dayOfWeekKeyboard(),
  });

  const dayCtx = await conversation.waitForCallbackQuery(/^day:/, {
    otherwise: (ctx) => ctx.reply("Please tap one of the buttons above."),
  });
  const recapDay = dayCtx.callbackQuery.data!.replace("day:", "") as DayName;
  await dayCtx.answerCallbackQuery();

  // ---------- Step 9: Recap hour + minute ----------
  await ctx.reply("What hour for the weekly recap?", {
    reply_markup: hourKeyboard(),
  });

  const recapHourCtx = await conversation.waitForCallbackQuery(/^hour:\d+$/, {
    otherwise: (ctx) => ctx.reply("Please tap one of the buttons above."),
  });
  const recapHour = parseInt(recapHourCtx.callbackQuery.data!.split(":")[1], 10);
  await recapHourCtx.answerCallbackQuery();

  await ctx.reply("And which minute for the recap?", {
    reply_markup: minuteKeyboard(),
  });

  const recapMinCtx = await conversation.waitForCallbackQuery(/^min:\d+$/, {
    otherwise: (ctx) => ctx.reply("Please tap one of the buttons above."),
  });
  const recapMinute = parseInt(recapMinCtx.callbackQuery.data!.split(":")[1], 10);
  await recapMinCtx.answerCallbackQuery();

  // ---------- Step 10: Save to DynamoDB ----------
  const profile = {
    telegram_id: ctx.from!.id,
    username: ctx.from?.username,
    ai_provider: aiProvider,
    api_key: encryptedKey,
    hsk_level: hskLevel,
    timezone,
    send_hour: sendHour,
    send_minute: sendMinute,
    daily_word_count: dailyWordCount,
    recap_day: recapDay,
    recap_hour: recapHour,
    recap_minute: recapMinute,
    is_active: true,
    created_at: new Date().toISOString(),
  } satisfies UserProfile;

  await conversation.external(() => upsertUser(profile));

  await ctx.reply(
    "All set! Here's a summary of your settings:\n\n" +
      `AI Provider: ${PROVIDER_DISPLAY[aiProvider]}\n` +
      `HSK Level: ${hskLevel}\n` +
      `Timezone: ${timezone}\n` +
      `Daily delivery: ${pad(sendHour)}:${pad(sendMinute)}\n` +
      `Words per day: ${dailyWordCount}\n` +
      `Weekly recap: ${recapDay.charAt(0).toUpperCase() + recapDay.slice(1)} at ${pad(recapHour)}:${pad(recapMinute)}\n\n` +
      "You'll start receiving words at your next scheduled time. " +
      "Use /settings to change any of these later.",
  );
}

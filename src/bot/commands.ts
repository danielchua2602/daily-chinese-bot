/**
 * Bot command handlers.
 *
 * Each exported function handles one Telegram slash command. They're
 * registered on the Bot instance in the handler entry point.
 *
 * Grammy pattern: command handlers receive a Context object (ctx) which
 * gives access to the incoming message, the chat, and methods to reply.
 * ctx.reply() sends a message back to the same chat.
 */

import type { BotContext } from "./types.js";
import { getUser, updateUser } from "../db/users.js";
import { decrypt } from "../utils/crypto.js";
import { PROVIDER_DISPLAY } from "./constants.js";
import { sendDailyWords } from "../services/send-words.js";
import { ProviderError } from "../ai/provider.js";

/**
 * /start — Welcome message + prompt to begin onboarding.
 *
 * This is the first thing users see. Telegram automatically sends /start
 * when a user opens the bot for the first time.
 */
export async function handleStart(ctx: BotContext): Promise<void> {
  await ctx.reply(
    "Welcome to the Chinese Words Bot! 🇨🇳\n\n" +
      "I'll send you daily Chinese vocabulary words tailored to your HSK level, " +
      "powered by the AI provider of your choice.\n\n" +
      "To get started, use /setup to configure your preferences.\n\n" +
      "Use /help to see all available commands.",
  );
}

/**
 * /help — Lists all available commands.
 */
export async function handleHelp(ctx: BotContext): Promise<void> {
  await ctx.reply(
    "Available commands:\n\n" +
      "/start — Welcome message\n" +
      "/setup — Set up your AI provider, API key, and HSK level\n" +
      "/settime — Change your daily delivery time\n" +
      "/setrecap — Change your weekly recap day and time\n" +
      "/today — Get today's words right now\n" +
      "/settings — View your current settings\n" +
      "/stop — Pause daily word delivery\n" +
      "/resume — Resume daily word delivery\n" +
      "/help — Show this message",
  );
}

/**
 * /settings — Displays current user settings.
 *
 * Fetches the user profile from DynamoDB and formats all settings into a
 * readable message. The API key is decrypted only to show the last 4 chars,
 * with the rest masked for security.
 */
export async function handleSettings(ctx: BotContext): Promise<void> {
  const user = await getUser(ctx.from!.id);

  if (!user) {
    await ctx.reply("You haven't set up yet. Use /setup to get started.");
    return;
  }

  let maskedKey: string;
  try {
    const plainKey = decrypt(user.api_key);
    const last4 = plainKey.slice(-4);
    maskedKey = `••••${last4}`;
  } catch {
    maskedKey = "••••••••";
  }

  const sendTime = `${String(user.send_hour).padStart(2, "0")}:${String(user.send_minute).padStart(2, "0")}`;
  const recapTime = `${String(user.recap_hour).padStart(2, "0")}:${String(user.recap_minute).padStart(2, "0")}`;
  const status = user.is_active ? "Active" : "Paused";

  await ctx.reply(
    "⚙️ Your settings:\n\n" +
      `AI Provider: ${PROVIDER_DISPLAY[user.ai_provider] ?? user.ai_provider}\n` +
      `API Key: ${maskedKey}\n` +
      `HSK Level: ${user.hsk_level}\n` +
      `Timezone: ${user.timezone}\n` +
      `Daily delivery: ${sendTime}\n` +
      `Words per day: ${user.daily_word_count}\n` +
      `Weekly recap: ${user.recap_day.charAt(0).toUpperCase() + user.recap_day.slice(1)} at ${recapTime}\n` +
      `Status: ${status}`,
  );
}

/**
 * /stop — Pauses daily word delivery.
 */
export async function handleStop(ctx: BotContext): Promise<void> {
  await updateUser(ctx.from!.id, { is_active: false });
  await ctx.reply("⏸ Daily word delivery paused. Use /resume to start again.");
}

/**
 * /resume — Resumes daily word delivery.
 *
 */
export async function handleResume(ctx: BotContext): Promise<void> {
  await updateUser(ctx.from!.id, { is_active: true });
  await ctx.reply("▶️ Daily word delivery resumed!");
}

/**
 * /today — Get today's words on demand.
 *
 * Uses the same sendDailyWords pipeline as the scheduler, so the user
 * gets identical results whether words come from /today or the daily schedule.
 * We pass ctx.api so sendDailyWords can send messages without needing a
 * Grammy context (it also works from the scheduler Lambda).
 */
export async function handleToday(ctx: BotContext): Promise<void> {
  const user = await getUser(ctx.from!.id);

  if (!user) {
    await ctx.reply("You haven't set up yet. Use /setup to get started.");
    return;
  }

  await ctx.reply("Generating your words... ⏳");

  try {
    await sendDailyWords(user, ctx.api);
  } catch (error) {
    if (error instanceof ProviderError) {
      await ctx.reply(error.userMessage);
    } else {
      await ctx.reply(
        "Something went wrong generating your words. Please try again.\n\n" +
          "If the problem persists, check your API key with /setup.",
      );
    }
  }
}

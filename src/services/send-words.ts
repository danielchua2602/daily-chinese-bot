/**
 * Send-words orchestration service.
 *
 * Ties together the full word delivery pipeline:
 *   decrypt key → create provider → get exclude list → generate → save → format → send
 *
 * Used by both /today (on-demand) and the scheduler (Phase 4).
 * By extracting this into a shared service, both callers get identical behavior
 * without duplicating the pipeline logic.
 */

import { Api } from "grammy";
import type { UserProfile } from "../db/users.js";
import { getRecentWords, saveWords } from "../db/words.js";
import { decrypt } from "../utils/crypto.js";
import { getUserLocalDate } from "../utils/timezone.js";
import { formatDailyWords, formatDisplayDate } from "../utils/format.js";
import { createProvider } from "../ai/provider.js";
import { generateValidatedWords } from "./word-generator.js";

/**
 * Generates and sends daily words to a single user.
 *
 * @param user      — the user profile from DynamoDB
 * @param api       — Grammy Api instance for sending messages
 * @param localDate — optional override for the user's local date (for testing).
 *                    If omitted, calculated from the user's timezone.
 *
 * Why pass the Api instance instead of a ctx object?
 * The scheduler Lambda doesn't have a Grammy context (no incoming message).
 * Grammy's Api class can send messages independently using just the bot token.
 * For /today, we extract ctx.api and pass it in.
 */
export async function sendDailyWords(user: UserProfile, api: Api, localDate?: string): Promise<void> {
  const apiKey = decrypt(user.api_key);
  const provider = await createProvider(user.ai_provider, apiKey);

  // Fetch recent words to build the exclude list (capped at 200)
  const excludeWords = await getRecentWords(user.telegram_id);

  const words = await generateValidatedWords({
    provider,
    count: user.daily_word_count,
    hskLevel: user.hsk_level,
    excludeWords,
  });

  // Determine the user's local date for storage and display
  const date = localDate ?? getUserLocalDate(user.timezone);

  // Save to DynamoDB before sending — if the send fails, at least we don't
  // regenerate the same words on retry (double-send prevention uses this data)
  await saveWords(user.telegram_id, words, date);

  // Format into displayable message(s) and send.
  // formatDailyWords returns an array for Telegram's 4096-char limit safety,
  // but with max 10 words it will almost always be a single message.
  const formattedDate = formatDisplayDate(date);
  const messages = formatDailyWords(words, formattedDate);

  for (const message of messages) {
    await api.sendMessage(user.telegram_id, message);
  }
}

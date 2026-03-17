/**
 * Weekly recap orchestration service.
 *
 * Fetches the past week's words and sends a formatted recap message.
 * Unlike send-words.ts, this doesn't involve AI — it only reads stored data.
 *
 * Used by the scheduler when a user's recap_day + recap_hour:recap_minute matches.
 */

import { Api } from "grammy";
import type { UserProfile } from "../db/users.js";
import { getWordsForDateRange } from "../db/words.js";
import { getUserLocalDate, formatLocalDate, getISOWeekNumber } from "../utils/timezone.js";
import { formatWeeklyRecap } from "../utils/format.js";

/**
 * Fetches the past 7 days of words and sends a recap message.
 *
 * Date range: 7 days ago through yesterday (in the user's local timezone).
 * We exclude "today" because the user might not have received today's words yet
 * (recap time could be earlier than send time).
 *
 * @param user — the user profile from DynamoDB
 * @param api  — Grammy Api instance for sending messages
 * @param now  — current timestamp (passed from scheduler for consistency)
 */
export async function sendRecap(user: UserProfile, api: Api, now: Date): Promise<void> {
  const today = getUserLocalDate(user.timezone, now);

  // Calculate date range: 7 days ago through yesterday
  const todayDate = new Date(today + "T00:00:00");
  const yesterday = new Date(todayDate);
  yesterday.setDate(yesterday.getDate() - 1);
  const weekAgo = new Date(todayDate);
  weekAgo.setDate(weekAgo.getDate() - 7);

  const startDate = formatLocalDate(weekAgo);
  const endDate = formatLocalDate(yesterday);

  const words = await getWordsForDateRange(user.telegram_id, startDate, endDate);

  const weekNumber = getISOWeekNumber(yesterday);

  const messages = formatWeeklyRecap(words, weekNumber);
  for (const message of messages) {
    await api.sendMessage(user.telegram_id, message);
  }
}

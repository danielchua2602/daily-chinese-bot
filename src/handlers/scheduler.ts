/**
 * Scheduler Lambda entry point — triggered by EventBridge every 15 minutes.
 *
 * Each tick:
 * 1. Fetches all active users from GSI1
 * 2. Filters to users due for daily words (send_hour:send_minute match)
 * 3. Filters to users due for weekly recap (recap_day + recap_hour:recap_minute match)
 * 4. Processes both groups with p-limit(5) concurrency
 *
 * Error handling:
 * - Telegram 403 (user blocked bot) → deactivate silently
 * - ProviderError non-retryable (bad key) → notify user + deactivate
 * - Transient errors → log and move on (next tick will retry naturally)
 */

import type { ScheduledEvent } from "aws-lambda";
import { Api, GrammyError } from "grammy";
import pino from "pino";
import { getActiveUsers, updateUser } from "../db/users.js";
import type { UserProfile } from "../db/users.js";
import { hasGeneratedWordsForDate } from "../db/words.js";
import { sendDailyWords } from "../services/send-words.js";
import { ProviderError } from "../ai/provider.js";
import { getUserLocalDate, getUserLocalDayName, isTimeMatch } from "../utils/timezone.js";
import { sendRecap } from "../services/send-recap.js";

/**
 * Module-level logger and Api instance — created once and reused across
 * Lambda warm starts. This avoids re-creating them on every invocation.
 *
 * pino outputs structured JSON logs. In CloudWatch, you can filter on any
 * field (e.g., telegramId=12345) instead of grepping through raw strings.
 */
const logger = pino({ name: "scheduler" });

/**
 * Grammy's Api class sends Telegram messages without needing a Bot context.
 * We create it at module level so Lambda warm starts reuse the same instance.
 * BOT_TOKEN is injected via Lambda environment variables (set in CDK stack).
 */
const api = new Api(process.env.BOT_TOKEN!);

/**
 * Main handler — EventBridge invokes this every 15 minutes.
 *
 * The flow is intentionally simple: fetch → filter → process.
 * Most minutes, no users are due, so we return early after the filter step.
 */
export const handler = async (_event: ScheduledEvent): Promise<void> => {
  /**
   * Dynamic import because p-limit v5 is ESM-only and our project is CJS.
   * esbuild (used by CDK's NodejsFunction) resolves this at bundle time,
   * so it works fine in the Lambda runtime. Same pattern as provider.ts
   * dynamic imports for AI SDKs.
   */
  const { default: pLimit } = await import("p-limit");
  const limit = pLimit(5);

  /**
   * Capture `now` once and pass it through all time checks.
   * If we called new Date() in each isTimeMatch call, a slow Lambda
   * could cross a minute boundary mid-processing, causing inconsistent
   * filtering (some users checked at 08:00, others at 08:01).
   */
  const now = new Date();
  logger.info({ timestamp: now.toISOString() }, "scheduler tick");

  // Step 1: Get all active users from GSI1
  const users = await getActiveUsers();
  logger.info({ activeUserCount: users.length }, "fetched active users");

  // Step 2: Filter to users whose local time matches their preferred send time.
  // isTimeMatch converts UTC to the user's timezone and checks hour:minute.
  // Example: if it's 00:00 UTC and a user in Asia/Singapore (UTC+8) has
  // send_hour=8, send_minute=0, isTimeMatch returns true.
  const wordsDue = users.filter((user) => isTimeMatch(user.timezone, user.send_hour, user.send_minute, now));

  // Step 3: Filter to users due for weekly recap.
  // Must match both the day of week AND the time.
  const recapDue = users.filter(
    (user) =>
      getUserLocalDayName(user.timezone, now) === user.recap_day &&
      isTimeMatch(user.timezone, user.recap_hour, user.recap_minute, now),
  );

  if (wordsDue.length === 0 && recapDue.length === 0) {
    logger.info("no users due this tick");
    return;
  }

  logger.info({ wordsDueCount: wordsDue.length, recapDueCount: recapDue.length }, "processing due users");

  // Step 4: Process both groups concurrently with p-limit(5).
  // Promise.allSettled ensures one user's failure doesn't block others.
  const results = await Promise.allSettled([
    ...wordsDue.map((user) => limit(() => processUser(user, now))),
    ...recapDue.map((user) => limit(() => processRecapUser(user, now))),
  ]);

  // Step 5: Log summary for observability
  const succeeded = results.filter((r) => r.status === "fulfilled").length;
  const failed = results.filter((r) => r.status === "rejected").length;
  logger.info({ succeeded, failed, total: results.length }, "scheduler tick complete");
};

/**
 * Processes a single user: checks double-send, generates words, sends them.
 *
 * Errors are caught here (not in the caller) so that processUser either
 * succeeds or handles the error gracefully. The only way it throws is if
 * handleUserError itself throws (e.g., DynamoDB down during deactivation),
 * which Promise.allSettled catches.
 */
async function processUser(user: UserProfile, now: Date): Promise<void> {
  // Child logger automatically includes telegramId in every log line,
  // so we don't have to repeat it in every message.
  const userLog = logger.child({ telegramId: user.telegram_id });

  // Double-send prevention: check if words were already generated today.
  const localDate = getUserLocalDate(user.timezone, now);
  const alreadySent = await hasGeneratedWordsForDate(user.telegram_id, localDate);
  if (alreadySent) {
    userLog.info({ localDate }, "already sent today, skipping");
    return;
  }

  userLog.info({ localDate }, "sending daily words");

  try {
    await sendDailyWords(user, api, localDate);
    userLog.info("daily words sent successfully");
  } catch (error) {
    await handleUserError(error, user, userLog);
  }
}

/**
 * Processes a single user's weekly recap: fetches past week's words, formats, sends.
 *
 * No double-send prevention needed here — recap only triggers once per week
 * because the day-of-week filter in the handler already limits it.
 */
async function processRecapUser(user: UserProfile, now: Date): Promise<void> {
  const userLog = logger.child({ telegramId: user.telegram_id, task: "recap" });
  userLog.info("sending weekly recap");

  try {
    await sendRecap(user, api, now);
    userLog.info("weekly recap sent successfully");
  } catch (error) {
    await handleUserError(error, user, userLog);
  }
}

/**
 * Categorizes errors and takes appropriate action.
 *
 * Three categories:
 * 1. User blocked bot (Telegram 403) → deactivate silently (user chose to block)
 * 2. Bad API key / quota (ProviderError non-retryable) → notify + deactivate
 * 3. Everything else (transient) → log only, next tick retries automatically
 *
 * Why deactivate on category 1 & 2?
 * Without deactivation, the scheduler would retry every minute forever,
 * burning Lambda invocations on guaranteed failures. Deactivating removes
 * the user from GSI1, so getActiveUsers() won't return them.
 *
 * Why NOT deactivate on category 3?
 * A transient DynamoDB error or network hiccup is temporary. The next
 * minute's tick will retry and likely succeed. Deactivating would require
 * the user to manually /resume after a momentary AWS blip.
 */
async function handleUserError(error: unknown, user: UserProfile, userLog: pino.Logger): Promise<void> {
  // Category 1: User blocked the bot
  // Grammy throws GrammyError with error_code 403 when sendMessage fails
  // because the user has blocked or deleted the bot.
  if (error instanceof GrammyError && error.error_code === 403) {
    userLog.warn("user blocked bot, deactivating");
    await updateUser(user.telegram_id, { is_active: false });
    return;
  }

  // Category 2: Non-retryable AI provider error
  // ProviderError.retryable is set by each adapter's classifyError().
  // Non-retryable = auth failure (401/403) or quota exhaustion.
  // The word-generator already retried retryable errors, so if we get
  // a non-retryable one here, retrying won't help.
  if (error instanceof ProviderError && !error.retryable) {
    userLog.error({ err: error }, "non-retryable provider error, deactivating");
    // Try to tell the user what happened before deactivating.
    // If this also fails (e.g., they blocked the bot too), we just log it.
    try {
      await api.sendMessage(
        user.telegram_id,
        `\u26a0\ufe0f Your daily words could not be sent:\n\n${error.userMessage}\n\n` +
          "Your daily delivery has been paused. Use /setup to reconfigure your API key, " +
          "then /resume to restart.",
      );
    } catch (notifyError) {
      userLog.warn({ err: notifyError }, "failed to notify user about provider error");
    }
    await updateUser(user.telegram_id, { is_active: false });
    return;
  }

  // Category 3: Transient / unexpected error — log and move on
  userLog.error({ err: error }, "unexpected error processing user");
}

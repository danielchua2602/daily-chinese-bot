/**
 * Telegram message formatters.
 *
 * Handles formatting words into readable Telegram messages and splitting
 * messages that exceed Telegram's 4096-character limit.
 *
 * Why split messages?
 * Telegram rejects messages over 4096 characters with a 400 error.
 * If a user sets daily_word_count to 10 with long example sentences,
 * the formatted message could easily exceed this. Rather than truncating
 * (losing content), we split into multiple messages sent sequentially.
 */

import type { StoredWord } from '../db/words.js';

const TELEGRAM_MAX_LENGTH = 4096;

export interface WordForDisplay {
  chinese: string;
  pinyin: string;
  english: string;
  example_sentence: string;
  example_pinyin: string;
  example_english: string;
}

/**
 * Formats a list of words into the daily message format.
 *
 * Returns an array of strings — usually just one, but multiple if the
 * content exceeds Telegram's limit.
 */
export function formatDailyWords(words: WordForDisplay[], date: string): string[] {
  const header = `📚 Daily Chinese Words — ${date}\n\n`;

  const wordBlocks = words.map((word, i) => {
    return [
      `${i + 1}. ${word.chinese} (${word.pinyin}) — ${word.english}`,
      `   💬 ${word.example_sentence}`,
      `      ${word.example_pinyin}`,
      `      ${word.example_english}`,
    ].join('\n');
  });

  return splitMessage(header + wordBlocks.join('\n\n'));
}

/**
 * Formats a weekly recap message grouped by day.
 *
 * Takes words with their local_date and groups them by date,
 * showing a compact summary per day.
 */
export function formatWeeklyRecap(
  words: StoredWord[],
  weekNumber: number
): string[] {
  if (words.length === 0) {
    return ['📖 No words learned this week. Use /today to get started!'];
  }

  // Group words by local_date
  const byDate = new Map<string, StoredWord[]>();
  for (const word of words) {
    const existing = byDate.get(word.local_date) ?? [];
    existing.push(word);
    byDate.set(word.local_date, existing);
  }

  const header = `📖 Week ${weekNumber} Recap — ${words.length} words learned!\n\n`;

  const dayLines: string[] = [];
  for (const [date, dayWords] of byDate) {
    const dayName = new Date(date + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short' });
    const wordList = dayWords.map((w) => `${w.chinese} (${w.pinyin})`).join(', ');
    dayLines.push(`${dayName}: ${wordList}`);
  }

  const footer = '\nKeep it up! 💪';

  return splitMessage(header + dayLines.join('\n') + footer);
}

/**
 * Splits a message into chunks that fit within Telegram's character limit.
 *
 * Strategy: split on double-newlines (paragraph boundaries) first, then
 * single newlines if a paragraph is still too long. This keeps word blocks
 * together rather than cutting mid-sentence.
 */
function splitMessage(text: string): string[] {
  if (text.length <= TELEGRAM_MAX_LENGTH) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= TELEGRAM_MAX_LENGTH) {
      chunks.push(remaining);
      break;
    }

    // Find the last double-newline within the limit
    let splitIndex = remaining.lastIndexOf('\n\n', TELEGRAM_MAX_LENGTH);

    // Fall back to single newline if no paragraph break found
    if (splitIndex === -1 || splitIndex === 0) {
      splitIndex = remaining.lastIndexOf('\n', TELEGRAM_MAX_LENGTH);
    }

    // Last resort: hard cut at the limit
    if (splitIndex === -1 || splitIndex === 0) {
      splitIndex = TELEGRAM_MAX_LENGTH;
    }

    chunks.push(remaining.slice(0, splitIndex));
    remaining = remaining.slice(splitIndex).trimStart();
  }

  return chunks;
}

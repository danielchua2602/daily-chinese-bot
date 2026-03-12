/**
 * Shared prompt templates for word generation.
 *
 * All three AI providers use the same prompts to ensure consistent output
 * format regardless of which provider the user chose. The prompt asks for
 * a JSON array — no markdown, no explanation — so we can parse it directly.
 *
 * Why a system prompt + user prompt split?
 * - System prompt sets the AI's role and output format constraints.
 *   It's "always on" context the AI should follow.
 * - User prompt contains the specific request (level, count, exclusions).
 *   It changes per call.
 * This separation is a best practice for all three providers.
 */

import type { GenerateWordsParams } from './provider.js';

export const SYSTEM_PROMPT = `You are a Chinese language teaching assistant. You generate vocabulary words for students learning Mandarin Chinese.

IMPORTANT: Respond with ONLY a JSON array. No markdown, no code fences, no explanation. Just the raw JSON array.

Each word object must have exactly these fields:
- "chinese": the word in simplified Chinese characters
- "pinyin": the pronunciation with tone marks (e.g., "nǐ hǎo")
- "english": a concise English translation
- "example_sentence": a natural example sentence in Chinese characters
- "example_pinyin": pinyin for the example sentence with tone marks
- "example_english": English translation of the example sentence

Example of the expected output format:
[{"chinese":"你好","pinyin":"nǐ hǎo","english":"hello","example_sentence":"你好，我是小明。","example_pinyin":"Nǐ hǎo, wǒ shì Xiǎo Míng.","example_english":"Hello, I am Xiao Ming."}]`;

export function buildUserPrompt(params: GenerateWordsParams): string {
  const { count, hskLevel, excludeWords } = params;

  let prompt = `Generate ${count} Chinese vocabulary word${count > 1 ? 's' : ''} at HSK level ${hskLevel}.`;

  if (excludeWords.length > 0) {
    prompt += `\n\nDo NOT include any of these words (the student already knows them):\n${excludeWords.join('、')}`;
  }

  prompt += `\n\nRespond with a JSON array of ${count} word object${count > 1 ? 's' : ''}.`;

  return prompt;
}

/**
 * Strips markdown code fences from AI responses.
 *
 * Despite being told "no code fences," models sometimes wrap JSON in
 * ```json ... ``` blocks. This defensive helper ensures we get clean JSON
 * regardless. Used by all three provider adapters.
 */
export function stripCodeFences(text: string): string {
  return text.trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
}

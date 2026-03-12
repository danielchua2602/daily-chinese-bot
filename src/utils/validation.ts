/**
 * Zod schemas for validating AI-generated word responses.
 *
 * Why validate AI output?
 * AI models are non-deterministic — they can return malformed JSON, missing
 * fields, wrong types, or even hallucinated structures. Zod gives us runtime
 * type checking with clear error messages, so we can retry on bad responses
 * instead of writing garbage to DynamoDB.
 *
 * The CJK character check on the "chinese" field catches cases where the model
 * returns pinyin or English instead of actual Chinese characters — a common
 * failure mode, especially at lower temperature settings.
 */

import { z } from 'zod/v4';

/**
 * CJK Unified Ideographs range: U+4E00 to U+9FFF.
 * This covers the vast majority of simplified and traditional Chinese characters.
 * We only require at least one CJK character — compound words like "你好" pass,
 * and so do mixed strings like "HSK1级" (unlikely but valid).
 */
const CJK_REGEX = /[\u4e00-\u9fff]/;

const wordResultSchema = z.object({
  chinese: z.string().min(1).refine((s) => CJK_REGEX.test(s), {
    message: 'chinese field must contain at least one CJK character',
  }),
  pinyin: z.string().min(1),
  english: z.string().min(1),
  example_sentence: z.string().min(1),
  example_pinyin: z.string().min(1),
  example_english: z.string().min(1),
});

/** Schema for the full AI response — an array of word objects. */
export const wordArraySchema = z.array(wordResultSchema);

/**
 * Validates and parses an unknown value against the word array schema.
 *
 * Returns { success: true, data } or { success: false, error }.
 * We use safeParse (not parse) so the caller can decide how to handle
 * failures — in our case, retry the AI call.
 */
export function validateWordArray(data: unknown) {
  return wordArraySchema.safeParse(data);
}

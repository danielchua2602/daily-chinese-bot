/**
 * Word generation service — the core pipeline for producing vocabulary words.
 *
 * Orchestrates: exclude list → AI call → validate → dedup → retry on failure.
 *
 * Why is retry logic here and not in the adapters?
 * - All three providers can produce invalid JSON or fail validation.
 * - Putting retries here avoids duplicating the same logic in each adapter.
 * - The adapter's job is just "call the API and return raw data."
 *   This service's job is "get valid, deduplicated words or die trying."
 *
 * Uses fixed 1-second delays between retries because the most common failure
 * is bad AI output (malformed JSON, missing fields), not rate limiting.
 * Waiting progressively longer doesn't help when the issue is non-deterministic
 * AI output — the next attempt is independent.
 */

import type { AIProvider, WordResult } from '../ai/provider.js';
import { ProviderError } from '../ai/provider.js';
import { validateWordArray } from '../utils/validation.js';

/** Default 2 retries. Override via WORD_GEN_MAX_RETRIES env var. */
function getMaxRetries(): number {
  const env = process.env.WORD_GEN_MAX_RETRIES;
  if (env) {
    const n = parseInt(env, 10);
    if (!isNaN(n) && n >= 0) return n;
  }
  return 2;
}

const RETRY_DELAY_MS = 1000;

interface GenerateValidatedWordsParams {
  provider: AIProvider;
  count: number;
  hskLevel: number;
  excludeWords: string[];
}

/**
 * Generates validated, deduplicated words with retry logic.
 *
 * Flow:
 * 1. Call the AI provider's generateWords()
 * 2. Validate the response shape with Zod
 * 3. Filter out any words that appear in the exclude list
 *    (the AI might ignore our "do not include" instruction)
 * 4. Check we got at least 1 word
 * 5. On any failure, retry up to MAX_RETRIES times
 *
 * Throws if all retries are exhausted — the caller (send-words) handles
 * notifying the user.
 */
export async function generateValidatedWords(
  params: GenerateValidatedWordsParams,
): Promise<WordResult[]> {
  const { provider, count, hskLevel, excludeWords } = params;
  const excludeSet = new Set(excludeWords);
  const maxRetries = getMaxRetries();

  let lastError: ProviderError | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      await sleep(RETRY_DELAY_MS);
    }

    try {
      const rawText = await provider.generateWords({ count, hskLevel, excludeWords });
      const parsed: unknown = JSON.parse(rawText);

      // Validate shape with Zod
      const result = validateWordArray(parsed);
      if (!result.success) {
        throw new Error(`Validation failed: ${result.error.message}`);
      }

      // Filter out duplicates that slipped past the prompt
      const deduped = result.data.filter(
        (word) => !excludeSet.has(word.chinese),
      );

      // Accept if we got at least 1 word — partial results are better than
      // nothing. The AI might return fewer if the exclude list is very large
      // (e.g., HSK 1 has ~150 words, user has seen 140 of them).
      if (deduped.length === 0) {
        throw new Error(`All ${result.data.length} words were duplicates`);
      }

      // Return exactly the requested count (or fewer if dedup removed some)
      return deduped.slice(0, count);
    } catch (error) {
      // Let the provider classify its own SDK errors
      const classified = provider.classifyError(error);

      // Non-retryable errors (bad key, quota) — bail immediately
      if (!classified.retryable) {
        throw classified;
      }

      lastError = classified;
    }
  }

  throw new Error(
    `Word generation failed after ${maxRetries + 1} attempts: ${lastError?.message}`,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

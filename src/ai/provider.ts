/**
 * Unified AI provider interface and factory.
 *
 * All three providers (Anthropic, Gemini, OpenAI) implement the same
 * AIProvider interface. The rest of the codebase works with this interface
 * only — it never imports a specific provider directly. This is the
 * Strategy pattern: swap the AI backend without changing calling code.
 *
 * The factory function picks the right adapter based on the user's
 * ai_provider setting stored in DynamoDB.
 */

import type { AiProviderId } from "../bot/constants.js";

/** Shape of a single generated word from the AI. */
export interface WordResult {
  chinese: string;
  pinyin: string;
  english: string;
  example_sentence: string;
  example_pinyin: string;
  example_english: string;
}

/** Parameters for word generation. */
export interface GenerateWordsParams {
  count: number;
  hskLevel: number;
  excludeWords: string[];
}

/**
 * Contract that all AI provider adapters must implement.
 *
 * generateWords() — asks the AI to produce vocabulary words.
 * validateKey()   — makes a lightweight API call to verify the key works.
 *                   Used during onboarding so the user gets immediate feedback.
 */
export interface AIProvider {
  generateWords(params: GenerateWordsParams): Promise<string>;
  validateKey(): Promise<boolean>;

  /**
   * Converts a raw SDK error into a structured ProviderError.
   *
   * Called by the word-generator's single try/catch — keeps error classification
   * in the adapter (which knows its SDK's error types) while keeping the
   * retry/bail logic in one place.
   */
  classifyError(error: unknown): ProviderError;
}

/**
 * Factory function — creates the right provider adapter for a given ID.
 *
 * Uses dynamic imports so we only load the SDK the user actually needs.
 * If a user picks Anthropic, we never import the OpenAI or Gemini SDKs,
 * keeping cold-start times lower for the Lambda.
 */
export async function createProvider(providerId: AiProviderId, apiKey: string): Promise<AIProvider> {
  switch (providerId) {
    case "anthropic": {
      const { AnthropicProvider } = await import("./anthropic.js");
      return new AnthropicProvider(apiKey);
    }
    case "gemini": {
      const { GeminiProvider } = await import("./gemini.js");
      return new GeminiProvider(apiKey);
    }
    case "openai": {
      const { OpenAIProvider } = await import("./openai.js");
      return new OpenAIProvider(apiKey);
    }
  }
}

/**
 * Custom error for AI provider failures that carry structured info.
 *
 * - retryable: false for auth errors (401/403) and quota exhaustion (429).
 *              true for transient errors (500, network timeouts).
 * - userMessage: clean, human-readable message safe to show in Telegram.
 *
 * The word-generator checks retryable to decide whether to retry or bail immediately.
 */
export class ProviderError extends Error {
  constructor(
    message: string,
    public readonly retryable: boolean,
    public readonly userMessage: string,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

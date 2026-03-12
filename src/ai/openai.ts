/**
 * OpenAI adapter for the AIProvider interface.
 *
 * Uses the openai SDK's chat completions API. OpenAI's structure is the
 * closest to Anthropic's — system/user message roles with a choices array.
 *
 * Default model is GPT-4o Mini — the cheapest model that reliably follows
 * JSON format instructions. Configurable via OPENAI_MODEL env var.
 */

import OpenAI from 'openai';
import { ProviderError } from './provider.js';
import type { AIProvider, GenerateWordsParams } from './provider.js';
import { SYSTEM_PROMPT, buildUserPrompt, stripCodeFences } from './prompt.js';

const DEFAULT_MODEL = 'gpt-4o-mini';

function getModel(): string {
  return process.env.OPENAI_MODEL || DEFAULT_MODEL;
}

/** Exported so the bot can tell users which model will be used. */
export function getOpenAIModelName(): string {
  return getModel();
}

export class OpenAIProvider implements AIProvider {
  private client: OpenAI;

  constructor(apiKey: string) {
    this.client = new OpenAI({ apiKey });
  }

  async generateWords(params: GenerateWordsParams): Promise<string> {
    const response = await this.client.chat.completions.create({
      model: getModel(),
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: buildUserPrompt(params) },
      ],
    });

    const text = response.choices[0]?.message?.content;
    if (!text) {
      throw new Error('OpenAI returned no content');
    }

    return stripCodeFences(text);
  }

  classifyError(error: unknown): ProviderError {
    if (error instanceof OpenAI.AuthenticationError || error instanceof OpenAI.PermissionDeniedError) {
      return new ProviderError(error.message, false, 'Your OpenAI API key is invalid or expired. Use /setup to update it.');
    }
    if (error instanceof OpenAI.RateLimitError) {
      return new ProviderError(error.message, false, 'Your OpenAI API rate limit has been exceeded. Please try again later or check your plan at https://platform.openai.com');
    }

    const message = error instanceof Error ? error.message : String(error);
    return new ProviderError(message, true, 'An unexpected error occurred with the OpenAI API. Please try again.');
  }

  /**
   * Validates the API key with a minimal chat completion call.
   *
   * max_tokens=1 keeps cost near zero. Invalid keys throw an
   * AuthenticationError (401).
   */
  async validateKey(): Promise<boolean> {
    try {
      await this.client.chat.completions.create({
        model: getModel(),
        max_tokens: 1,
        messages: [{ role: 'user', content: 'Hi' }],
      });
      return true;
    } catch (error: unknown) {
      if (error instanceof OpenAI.AuthenticationError) return false;
      if (error instanceof OpenAI.PermissionDeniedError) return false;
      throw error;
    }
  }
}

/**
 * Anthropic (Claude) adapter for the AIProvider interface.
 *
 * Uses the @anthropic-ai/sdk to call the Claude Messages API.
 * The SDK handles retries and error formatting internally.
 *
 * Why Claude Haiku as default?
 * - Generating 3-10 vocabulary words is a simple task — Haiku is fast and cheap.
 * - Haiku follows JSON format instructions reliably at this complexity level.
 * - Users pay with their own API keys, so keeping costs low matters.
 *
 * The model is configurable via ANTHROPIC_MODEL env var so you can upgrade
 * without redeploying code (e.g., switch to a newer Sonnet for better quality).
 */

import Anthropic from "@anthropic-ai/sdk";
import { ProviderError } from "./provider.js";
import type { AIProvider, GenerateWordsParams } from "./provider.js";
import { SYSTEM_PROMPT, buildUserPrompt, stripCodeFences } from "./prompt.js";

const DEFAULT_MODEL = "claude-haiku-4-5-20251001";

function getModel(): string {
  return process.env.ANTHROPIC_MODEL || DEFAULT_MODEL;
}

/** Exported so the bot can tell users which model will be used. */
export function getAnthropicModelName(): string {
  return getModel();
}

export class AnthropicProvider implements AIProvider {
  private client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey });
  }

  async generateWords(params: GenerateWordsParams): Promise<string> {
    const response = await this.client.messages.create({
      model: getModel(),
      max_tokens: 2048,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: buildUserPrompt(params) }],
    });

    // Claude returns content blocks — extract the text from the first one.
    // For a simple JSON response, there will always be exactly one text block.
    const textBlock = response.content.find((block) => block.type === "text");
    if (!textBlock || textBlock.type !== "text") {
      throw new Error("Anthropic returned no text content");
    }

    return stripCodeFences(textBlock.text);
  }

  classifyError(error: unknown): ProviderError {
    if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) {
      return new ProviderError(
        error.message,
        false,
        "Your Anthropic API key is invalid or expired. Use /setup to update it.",
      );
    }
    if (error instanceof Anthropic.RateLimitError) {
      return new ProviderError(
        error.message,
        false,
        "Your Anthropic API rate limit has been exceeded. Please try again later or check your plan at https://console.anthropic.com",
      );
    }

    const message = error instanceof Error ? error.message : String(error);
    return new ProviderError(message, true, "An unexpected error occurred with the Anthropic API. Please try again.");
  }

  /**
   * Validates the API key by making a minimal API call.
   *
   * We send a trivial prompt with max_tokens=1 to minimize cost.
   * If the key is invalid, the SDK throws an AuthenticationError (401).
   */
  async validateKey(): Promise<boolean> {
    try {
      await this.client.messages.create({
        model: getModel(),
        max_tokens: 1,
        messages: [{ role: "user", content: "Hi" }],
      });
      return true;
    } catch (error: unknown) {
      if (error instanceof Anthropic.AuthenticationError) return false;
      if (error instanceof Anthropic.PermissionDeniedError) return false;
      throw error;
    }
  }
}

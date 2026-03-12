/**
 * Google Gemini adapter for the AIProvider interface.
 *
 * Uses the @google/generative-ai SDK. Gemini's API differs from Anthropic/OpenAI:
 * - Uses GoogleGenerativeAI client, not a chat/messages endpoint
 * - System prompt is set via systemInstruction on the model instance
 * - Content is passed to generateContent() directly
 *
 * Default model is Gemini 2.5 Flash — fast, cheap, and good at following
 * structured output instructions. Configurable via GEMINI_MODEL env var.
 */

import { GoogleGenerativeAI, GoogleGenerativeAIError } from "@google/generative-ai";
import { ProviderError } from "./provider.js";
import type { AIProvider, GenerateWordsParams } from "./provider.js";
import { SYSTEM_PROMPT, buildUserPrompt, stripCodeFences } from "./prompt.js";

const DEFAULT_MODEL = "gemini-2.5-flash";

function getModel(): string {
  return process.env.GEMINI_MODEL || DEFAULT_MODEL;
}

/** Exported so the bot can tell users which model will be used. */
export function getGeminiModelName(): string {
  return getModel();
}

export class GeminiProvider implements AIProvider {
  private client: GoogleGenerativeAI;

  constructor(apiKey: string) {
    this.client = new GoogleGenerativeAI(apiKey);
  }

  async generateWords(params: GenerateWordsParams): Promise<string> {
    const model = this.client.getGenerativeModel({
      model: getModel(),
      systemInstruction: SYSTEM_PROMPT,
    });

    const result = await model.generateContent(buildUserPrompt(params));
    const text = result.response.text();

    return stripCodeFences(text);
  }

  classifyError(error: unknown): ProviderError {
    if (error instanceof GoogleGenerativeAIError) {
      const msg = error.message.toLowerCase();

      if (msg.includes("429") || msg.includes("quota")) {
        return new ProviderError(
          error.message,
          false,
          "Your Gemini API quota has been exceeded. Please check your plan and billing at https://ai.google.dev",
        );
      }
      if (msg.includes("401") || msg.includes("403") || msg.includes("api key")) {
        return new ProviderError(
          error.message,
          false,
          "Your Gemini API key is invalid or expired. Use /setup to update it.",
        );
      }
    }

    const message = error instanceof Error ? error.message : String(error);
    return new ProviderError(message, true, "An unexpected error occurred with the Gemini API. Please try again.");
  }

  /**
   * Validates the API key with a minimal generation call.
   *
   * Gemini doesn't have a dedicated "whoami" endpoint in the basic SDK,
   * so we make a trivial generation call. An invalid key throws a
   * GoogleGenerativeAIError with a 400/403 status message.
   */
  async validateKey(): Promise<boolean> {
    try {
      const model = this.client.getGenerativeModel({ model: getModel() });
      await model.generateContent("Hi");
      return true;
    } catch (error: unknown) {
      if (error instanceof GoogleGenerativeAIError) {
        const msg = error.message.toLowerCase();
        if (msg.includes("api key") || msg.includes("permission") || msg.includes("403") || msg.includes("401")) {
          return false;
        }
      }
      throw error;
    }
  }
}

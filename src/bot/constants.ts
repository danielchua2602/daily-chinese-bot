export const AI_PROVIDERS = [
  { id: "anthropic", label: "Anthropic" },
  { id: "gemini", label: "Gemini" },
  { id: "openai", label: "OpenAI" },
] as const;

export type AiProviderId = (typeof AI_PROVIDERS)[number]["id"];

export const PROVIDER_DISPLAY = Object.fromEntries(AI_PROVIDERS.map((p) => [p.id, p.label])) as Record<
  AiProviderId,
  string
>;

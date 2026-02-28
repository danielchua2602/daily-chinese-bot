/**
 * Bot command handlers.
 *
 * Each exported function handles one Telegram slash command. They're
 * registered on the Bot instance in the handler entry point.
 *
 * Grammy pattern: command handlers receive a Context object (ctx) which
 * gives access to the incoming message, the chat, and methods to reply.
 * ctx.reply() sends a message back to the same chat.
 */

import type { Context } from 'grammy';

/**
 * /start — Welcome message + prompt to begin onboarding.
 *
 * This is the first thing users see. Telegram automatically sends /start
 * when a user opens the bot for the first time.
 */
export async function handleStart(ctx: Context): Promise<void> {
  await ctx.reply(
    'Welcome to the Chinese Words Bot! 🇨🇳\n\n' +
    'I\'ll send you daily Chinese vocabulary words tailored to your HSK level, ' +
    'powered by the AI provider of your choice.\n\n' +
    'To get started, use /setup to configure your preferences.\n\n' +
    'Use /help to see all available commands.'
  );
}

/**
 * /help — Lists all available commands.
 *
 * Kept as a simple static message. We could use ctx.setMyCommands() to
 * register commands with Telegram's UI (the "/" menu), but that's a
 * one-time setup we'll do during deployment, not per-message.
 */
export async function handleHelp(ctx: Context): Promise<void> {
  await ctx.reply(
    'Available commands:\n\n' +
    '/start — Welcome message\n' +
    '/setup — Set up your AI provider, API key, and HSK level\n' +
    '/settime — Change your daily delivery time\n' +
    '/setrecap — Change your weekly recap day and time\n' +
    '/today — Get today\'s words right now\n' +
    '/settings — View your current settings\n' +
    '/stop — Pause daily word delivery\n' +
    '/resume — Resume daily word delivery\n' +
    '/help — Show this message'
  );
}

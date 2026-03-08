/**
 * Custom context type for the bot.
 *
 * ConversationFlavor adds `ctx.conversation` to the context, which lets
 * command handlers enter/exit conversations via ctx.conversation.enter().
 * This type must be used everywhere the bot's context is referenced —
 * handlers, conversations, and the Bot<> generic.
 */

import type { Context } from "grammy";
import type { ConversationFlavor } from "@grammyjs/conversations";

export type BotContext = ConversationFlavor<Context>;

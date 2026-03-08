/**
 * Reusable inline keyboard builders for the Telegram bot.
 * Each function returns a grammy InlineKeyboard instance ready to attach to a message.
 */

import { InlineKeyboard } from "grammy";
import { TIMEZONE_CITIES } from "../utils/timezone.js";
import { AI_PROVIDERS } from "./constants.js";

export function aiProviderKeyboard(): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const p of AI_PROVIDERS) {
    kb.text(p.label, `provider:${p.id}`);
  }
  return kb;
}

export function hskLevelKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("HSK 1", "hsk:1")
    .text("HSK 2", "hsk:2")
    .text("HSK 3", "hsk:3")
    .row()
    .text("HSK 4", "hsk:4")
    .text("HSK 5", "hsk:5")
    .text("HSK 6", "hsk:6");
}

export function timezoneCityKeyboard(): InlineKeyboard {
  const kb = new InlineKeyboard();
  const sorted = [...TIMEZONE_CITIES].sort((a, b) => a.label.localeCompare(b.label));

  for (let i = 0; i < sorted.length; i++) {
    const city = sorted[i];
    kb.text(city.label, `tz:${city.timezone}`);
    // 3 columns per row
    if ((i + 1) % 3 === 0 && i < sorted.length - 1) {
      kb.row();
    }
  }

  // Final row with manual entry option
  kb.row().text("Other (type manually)", "tz:other");

  return kb;
}

export function hourKeyboard(): InlineKeyboard {
  const kb = new InlineKeyboard();

  for (let h = 0; h < 24; h++) {
    const label = h.toString().padStart(2, "0");
    kb.text(label, `hour:${h}`);
    if ((h + 1) % 6 === 0 && h < 23) {
      kb.row();
    }
  }

  return kb;
}

export function minuteKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text(":00", "min:0").text(":15", "min:15").text(":30", "min:30").text(":45", "min:45");
}

export function wordCountKeyboard(): InlineKeyboard {
  const kb = new InlineKeyboard();

  for (let n = 1; n <= 10; n++) {
    kb.text(`${n}`, `wc:${n}`);
    if (n === 5) {
      kb.row();
    }
  }

  return kb;
}

export function dayOfWeekKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("Mon", "day:monday")
    .text("Tue", "day:tuesday")
    .text("Wed", "day:wednesday")
    .text("Thu", "day:thursday")
    .row()
    .text("Fri", "day:friday")
    .text("Sat", "day:saturday")
    .text("Sun", "day:sunday");
}

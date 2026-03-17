/**
 * Timezone validation and conversion utilities.
 *
 * Uses the Intl API (built into Node.js 18+) for timezone handling.
 * This is the correct approach because:
 * - IANA timezone names (e.g., "America/New_York") handle DST automatically.
 * - Numeric UTC offsets (e.g., "+5") do NOT handle DST — they'd be wrong
 *   for half the year.
 * - The Intl API is maintained by the ICU project, so timezone data stays
 *   up-to-date with Node.js releases.
 */

/**
 * Validates an IANA timezone string.
 * Returns the canonical form if valid, null if invalid.
 *
 * Uses Intl.supportedValuesOf('timeZone') which returns all IANA timezones
 * supported by the runtime. We do a case-insensitive search because users
 * might type "america/new_york" instead of "America/New_York".
 */
export function validateTimezone(input: string): string | null {
  const supported = Intl.supportedValuesOf("timeZone");
  const match = supported.find((tz) => tz.toLowerCase() === input.toLowerCase());
  return match ?? null;
}

/**
 * Gets the current time in a user's timezone as a Date object.
 *
 * Implementation note: toLocaleString('en-US', { timeZone }) returns a
 * locale-formatted string, which we re-parse into a Date. This is a
 * well-known pattern — slightly hacky but reliable across all Node.js versions.
 * The alternative (Temporal API) isn't stable yet.
 */
export function getUserLocalTime(timezone: string, now?: Date): Date {
  const timestamp = now ?? new Date();
  return new Date(timestamp.toLocaleString("en-US", { timeZone: timezone }));
}

/**
 * Gets the user's local date as YYYY-MM-DD.
 *
 * Uses 'en-CA' locale because Canada uses ISO 8601 date format (YYYY-MM-DD)
 * by default — a neat trick to avoid manual date formatting.
 */
export function getUserLocalDate(timezone: string, now?: Date): string {
  const timestamp = now ?? new Date();
  return timestamp.toLocaleDateString("en-CA", { timeZone: timezone });
}

export type DayName = "sunday" | "monday" | "tuesday" | "wednesday" | "thursday" | "friday" | "saturday";

const DAY_NAMES: DayName[] = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

/** Gets the day of week name (lowercase) in the user's timezone. */
export function getUserLocalDayName(timezone: string, now?: Date): DayName {
  const userTime = getUserLocalTime(timezone, now);
  return DAY_NAMES[userTime.getDay()];
}

/**
 * Checks if the user's current local time matches a target hour:minute.
 */
export function isTimeMatch(timezone: string, targetHour: number, targetMinute: number, now?: Date): boolean {
  const userTime = getUserLocalTime(timezone, now);
  return userTime.getHours() === targetHour && userTime.getMinutes() === targetMinute;
}

/** Formats a Date as YYYY-MM-DD (matching DynamoDB's GSI2SK format). */
export function formatLocalDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * Returns the ISO 8601 week number for a given date.
 *
 * Algorithm: find the nearest Thursday (ISO weeks start on Monday),
 * then calculate how many weeks into the year that Thursday falls.
 */
export function getISOWeekNumber(date: Date): number {
  const tmp = new Date(date.getTime());
  tmp.setHours(0, 0, 0, 0);
  // Set to nearest Thursday: current date + 4 - current day number (Monday=1, Sunday=7)
  tmp.setDate(tmp.getDate() + 4 - (tmp.getDay() || 7));
  const yearStart = new Date(tmp.getFullYear(), 0, 1);
  return Math.ceil(((tmp.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
}

/**
 * City-to-IANA timezone mapping for the inline keyboard picker.
 *
 * We use cities instead of raw IANA strings because:
 * - Users recognize city names ("Tokyo") but not IANA codes ("Asia/Tokyo")
 * - Telegram inline keyboards have a ~64-byte limit per button callback,
 *   so short labels work better
 * - We cover ~15 cities across major regions to handle most users
 *
 * The "Other" option in the keyboard will fall back to validateTimezone()
 * for power users who know their IANA string.
 */
export const TIMEZONE_CITIES: { label: string; timezone: string }[] = [
  // Americas
  { label: "New York", timezone: "America/New_York" },
  { label: "Chicago", timezone: "America/Chicago" },
  { label: "Denver", timezone: "America/Denver" },
  { label: "Los Angeles", timezone: "America/Los_Angeles" },
  { label: "São Paulo", timezone: "America/Sao_Paulo" },
  // Europe / Africa
  { label: "London", timezone: "Europe/London" },
  { label: "Paris", timezone: "Europe/Paris" },
  { label: "Moscow", timezone: "Europe/Moscow" },
  // Middle East / South Asia
  { label: "Dubai", timezone: "Asia/Dubai" },
  { label: "Mumbai", timezone: "Asia/Kolkata" },
  // East / Southeast Asia
  { label: "Singapore", timezone: "Asia/Singapore" },
  { label: "Shanghai", timezone: "Asia/Shanghai" },
  { label: "Tokyo", timezone: "Asia/Tokyo" },
  { label: "Seoul", timezone: "Asia/Seoul" },
  // Oceania
  { label: "Sydney", timezone: "Australia/Sydney" },
  { label: "Auckland", timezone: "Pacific/Auckland" },
];

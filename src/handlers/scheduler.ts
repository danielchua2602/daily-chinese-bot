/**
 * Scheduler Lambda entry point — triggered by EventBridge every minute.
 *
 * This Lambda checks which users are due for:
 * 1. Daily words (matches their send_hour:send_minute in their timezone)
 * 2. Weekly recap (matches their recap_day + recap_hour:recap_minute)
 *
 * Placeholder for Phase 4 — the scheduler logic will be implemented after
 * AI providers and word generation are built in Phase 3.
 */

import type { ScheduledEvent } from 'aws-lambda';

export const handler = async (_event: ScheduledEvent): Promise<void> => {
  // Phase 4: implement scheduler logic
  console.log('Scheduler tick', new Date().toISOString());
};

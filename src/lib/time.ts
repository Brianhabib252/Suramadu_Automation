/**
 * Helpers for consistently rendering Jakarta-local timestamps. Centralised here
 * so other modules do not have to remember the time zone identifier or wiring.
 */
import { formatInTimeZone } from 'date-fns-tz';

export const JAKARTA_TIME_ZONE = 'Asia/Jakarta';

export function formatJakarta(date: Date, pattern: string): string {
  return formatInTimeZone(date, JAKARTA_TIME_ZONE, pattern);
}

export function nowJakarta(pattern: string): string {
  return formatJakarta(new Date(), pattern);
}

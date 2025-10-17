import { formatInTimeZone } from 'date-fns-tz';

export const JAKARTA_TIME_ZONE = 'Asia/Jakarta';

export function formatJakarta(date: Date, pattern: string): string {
  return formatInTimeZone(date, JAKARTA_TIME_ZONE, pattern);
}

export function nowJakarta(pattern: string): string {
  return formatJakarta(new Date(), pattern);
}


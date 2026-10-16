import { randomInt, randomUUID } from 'node:crypto';

/** Pairing codes and their sessions expire after this long. */
export const SESSION_TTL_SECONDS = 2 * 60 * 60;

// 6 digits: a million codes. At the API's 10 requests a second, trying them all takes ~28 hours,
// far longer than a code lives (4 digits took ~17 minutes).
const CODE_PATTERN = /^\d{6}$/;

export interface Session {
  code: string;
  /** AppSync Events channel the camera publishes to and the TV subscribes to. */
  channel: string;
  createdAt: string;
  /** Unix seconds; DynamoDB deletes the item after this. */
  ttl: number;
}

export function isValidCode(code: string | undefined): code is string {
  return code !== undefined && CODE_PATTERN.test(code);
}

/** A 6-digit code that is still easy to read off a TV and type on a phone. */
export function newCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, '0');
}

export function newSession(code: string, now = new Date()): Session {
  return {
    code,
    channel: `/session/${randomUUID()}`,
    createdAt: now.toISOString(),
    ttl: Math.floor(now.getTime() / 1000) + SESSION_TTL_SECONDS,
  };
}

export function sessionKey(code: string): { pk: string; sk: string } {
  return { pk: `SESSION#${code}`, sk: 'META' };
}

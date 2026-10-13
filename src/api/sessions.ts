import { randomInt, randomUUID } from 'node:crypto';

/** Pairing codes and their sessions expire after this long. */
export const SESSION_TTL_SECONDS = 2 * 60 * 60;

const CODE_PATTERN = /^\d{4}$/;

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

/** A 4-digit code that is easy to read off a TV and type on a phone. */
export function newCode(): string {
  return randomInt(0, 10_000).toString().padStart(4, '0');
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

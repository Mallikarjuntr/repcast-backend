import { describe, expect, it } from 'vitest';
import { isValidCode, newCode, newSession, SESSION_TTL_SECONDS, sessionKey } from '../src/api/sessions.js';

describe('sessions', () => {
  it('makes 6-digit codes, keeping leading zeros', () => {
    for (let i = 0; i < 500; i++) expect(newCode()).toMatch(/^\d{6}$/);
  });

  it('accepts only 6-digit codes', () => {
    expect(isValidCode('004271')).toBe(true);
    expect(isValidCode('0427')).toBe(false);
    expect(isValidCode('1234567')).toBe(false);
    expect(isValidCode('12a456')).toBe(false);
    expect(isValidCode(undefined)).toBe(false);
  });

  it('gives each session its own channel and a two-hour expiry', () => {
    const now = new Date('2026-10-13T12:00:00Z');
    const a = newSession('1234', now);
    const b = newSession('1234', now);
    expect(a.channel).toMatch(/^\/session\/[0-9a-f-]{36}$/);
    expect(a.channel).not.toBe(b.channel);
    expect(a.ttl).toBe(Math.floor(now.getTime() / 1000) + SESSION_TTL_SECONDS);
  });

  it('keys sessions by code', () => {
    expect(sessionKey('0042')).toEqual({ pk: 'SESSION#0042', sk: 'META' });
  });
});

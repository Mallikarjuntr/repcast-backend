import { describe, expect, it } from 'vitest';
import { firstAnswer } from '../src/coach/retry.js';

const opts = { attemptMs: 40, lastStartMs: 200, skip: (err: unknown) => (err as Error).message === 'refused' };
const hang = (signal: AbortSignal) => new Promise<string | null>((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))));
const never = () => new Promise<string | null>(() => {});

describe('asking the models', () => {
  it('cuts off a call that hangs and asks the same model again', async () => {
    let calls = 0;
    const started = Date.now();
    const answer = await firstAnswer(1, 0, (_, signal) => (++calls === 1 ? hang(signal) : Promise.resolve('report')), opts);
    expect(answer).toEqual({ value: 'report', index: 0 });
    expect(calls).toBe(2);
    expect(Date.now() - started).toBeLessThan(150);
  });

  it('cuts off a call even when the client ignores the signal', async () => {
    let calls = 0;
    expect(await firstAnswer(1, 0, () => (++calls === 1 ? never() : Promise.resolve('report')), opts)).toEqual({ value: 'report', index: 0 });
  });

  it('passes over a refused model, and over one that declines to answer', async () => {
    const seen: number[] = [];
    const answer = await firstAnswer(3, 0, async (i) => {
      seen.push(i);
      if (i === 0) throw new Error('refused');
      return i === 1 ? null : 'from the third';
    }, opts);
    expect(answer).toEqual({ value: 'from the third', index: 2 });
    expect(seen).toEqual([0, 1, 2]);
  });

  it('starts from the model that answered last time', async () => {
    const seen: number[] = [];
    await firstAnswer(3, 2, async (i) => (seen.push(i), 'ok'), opts);
    expect(seen).toEqual([2]);
  });

  it('gives up in time when nothing answers', async () => {
    const started = Date.now();
    const errors: boolean[] = [];
    expect(await firstAnswer(1, 0, (_, signal) => hang(signal), { ...opts, onError: (_, __, skipped) => errors.push(skipped) })).toBeNull();
    expect(Date.now() - started).toBeLessThan(opts.lastStartMs + opts.attemptMs + 60);
    expect(errors.length).toBeGreaterThanOrEqual(4);
    expect(errors.every((skipped) => !skipped)).toBe(true);
  });
});

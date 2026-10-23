/**
 * Asks the models in turn for an answer, each call cut off after `attemptMs`.
 * - A model that's refused or unknown here (`skip` says so) is passed over.
 * - A call that hangs or errors is made again to the same model: on 2026-10-23 about one Nova call
 *   in four hung until the old 20 s timeout, while the rest answered in under 2 s, so a fresh call
 *   is far quicker than waiting.
 * - A refusal or a malformed answer (`null`) moves on to the next model.
 * No call starts after `lastStartMs`, so the whole thing ends before API Gateway's 30 s.
 */
export async function firstAnswer<T>(
  count: number,
  first: number,
  call: (index: number, signal: AbortSignal) => Promise<T | null>,
  opts: { attemptMs: number; lastStartMs: number; skip: (err: unknown) => boolean; onError?: (index: number, err: unknown, skipped: boolean) => void },
): Promise<{ value: T; index: number } | null> {
  const started = Date.now();
  let tried = 0;
  while (tried < count && Date.now() - started < opts.lastStartMs) {
    const index = (first + tried) % count;
    const signal = AbortSignal.timeout(opts.attemptMs);
    try {
      // The race makes the cut-off hold even if a client ignores the signal.
      const value = await Promise.race([
        call(index, signal),
        new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })),
      ]);
      if (value !== null) return { value, index };
      tried++;
    } catch (err) {
      const skipped = opts.skip(err);
      opts.onError?.(index, err, skipped);
      if (skipped) tried++;
    }
  }
  return null;
}

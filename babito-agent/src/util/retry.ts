export class RetryableError extends Error {
  constructor(message: string, readonly retryAfterMs?: number) {
    super(message);
    this.name = "RetryableError";
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Retries only errors explicitly marked retryable (RetryableError) or network
 * failures (TypeError from fetch). Everything else fails fast.
 */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  opts: { retries?: number; baseDelayMs?: number; maxDelayMs?: number } = {},
): Promise<T> {
  const retries = opts.retries ?? 2;
  const base = opts.baseDelayMs ?? 400;
  const max = opts.maxDelayMs ?? 4000;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      const retryable = err instanceof RetryableError || err instanceof TypeError || (err as Error)?.name === "TimeoutError";
      if (!retryable || attempt === retries) throw err;
      const hinted = err instanceof RetryableError ? err.retryAfterMs : undefined;
      const delay = Math.min(hinted ?? base * 2 ** attempt + Math.random() * 100, max);
      await sleep(delay);
    }
  }
  throw lastErr;
}

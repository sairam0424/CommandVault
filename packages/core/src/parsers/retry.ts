const TRANSIENT_CODES = new Set(['EBUSY', 'EMFILE', 'ENFILE', 'EAGAIN']);

export async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries = 1,
  delayMs = 100,
): Promise<T> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (attempt < maxRetries && code && TRANSIENT_CODES.has(code)) {
        await new Promise((r) => setTimeout(r, delayMs));
        continue;
      }
      throw err;
    }
  }
  throw new Error('unreachable');
}

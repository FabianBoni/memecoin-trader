type AsyncOperation<T> = () => Promise<T>;

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isSolanaRpcRateLimitError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message.toLowerCase();
  return message.includes('429 too many requests')
    || message.includes('too many requests')
    || message.includes('status 429')
    || message.includes('status: 429')
    || message.includes('rate limited')
    || message.includes('code":-32429')
    || message.includes('error code: 429');
}

export async function withRpcRetry<T>(
  operation: AsyncOperation<T>,
  options?: {
    delaysMs?: number[];
    onRetry?: (delayMs: number, attempt: number, error: unknown) => void;
  },
): Promise<T> {
  const delaysMs = options?.delaysMs ?? [];
  let lastError: unknown;

  for (let attempt = 0; attempt <= delaysMs.length; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!isSolanaRpcRateLimitError(error) || attempt >= delaysMs.length) {
        throw error;
      }

      const delayMs = delaysMs[attempt] ?? 0;
      options?.onRetry?.(delayMs, attempt + 1, error);
      await sleep(delayMs);
    }
  }

  throw lastError instanceof Error ? lastError : new Error('RPC request failed.');
}

export function createAsyncLimiter(concurrency: number) {
  let active = 0;
  const waiters: Array<() => void> = [];

  return async function limit<T>(operation: AsyncOperation<T>): Promise<T> {
    if (active >= concurrency) {
      await new Promise<void>((resolve) => {
        waiters.push(resolve);
      });
    }

    active += 1;
    try {
      return await operation();
    } finally {
      active -= 1;
      const next = waiters.shift();
      if (next) {
        next();
      }
    }
  };
}
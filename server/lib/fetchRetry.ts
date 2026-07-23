function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, ms);
    const onAbort = () => done(signal?.reason || new DOMException("Aborted", "AbortError"));
    function done(error?: unknown) {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      error ? reject(error) : resolve();
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function isTransientHttpStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

export async function fetchWithOneRetry(
  input: string | URL,
  init: RequestInit,
  callerSignal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<Response> {
  // ponytail: Retrying assumes a replayable body; current callers use JSON strings or
  // no body. Buffer a streaming body first if one is ever added here.
  for (let attempt = 0; attempt < 2; attempt++) {
    callerSignal?.throwIfAborted();
    const requestSignal = callerSignal
      ? AbortSignal.any([callerSignal, AbortSignal.timeout(timeoutMs)])
      : AbortSignal.timeout(timeoutMs);
    try {
      const response = await fetch(input, { ...init, signal: requestSignal });
      if (attempt === 0 && isTransientHttpStatus(response.status)) {
        const retryAfterSeconds = Number(response.headers.get("retry-after"));
        await response.body?.cancel().catch(() => {});
        await abortableDelay(Number.isFinite(retryAfterSeconds) ? Math.min(retryAfterSeconds * 1_000, 2_000) : 500, callerSignal);
        continue;
      }
      return response;
    } catch (error: any) {
      if (callerSignal?.aborted || error?.name === "AbortError" || error?.name === "TimeoutError" || attempt === 1) throw error;
      await abortableDelay(500, callerSignal);
    }
  }
  throw new Error("unreachable_retry_state");
}

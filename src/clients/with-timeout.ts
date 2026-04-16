/**
 * Rejects with a timeout error if `operation` does not settle within
 * `timeoutMs`. The underlying I/O is not cancelled — this only frees
 * the caller; the socket may still linger until the OS reclaims it.
 * For operations that accept an AbortSignal (e.g. native `fetch`),
 * prefer passing a controller signal so the socket is actually closed.
 * @param operation - Async function to race against the timeout
 * @param timeoutMs - Milliseconds before the race rejects
 * @param label - Short identifier included in the timeout error message
 */
export async function withTimeout<T>(
  operation: () => Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(
      () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
      timeoutMs,
    )
  })
  try {
    return await Promise.race([operation(), timeoutPromise])
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle)
  }
}

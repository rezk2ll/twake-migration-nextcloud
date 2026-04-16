import type { Logger } from 'pino'

/**
 * Bounds the number of concurrent migrations and tracks in-flight work
 * so a graceful shutdown can wait for them to finish. The RabbitMQ
 * library's prefetch only limits concurrent *handlers*; once a handler
 * early-ACKs and fires the migration, it is effectively unbounded
 * unless something like this enforces a ceiling.
 */
export interface MigrationRunner {
  /**
   * Blocks until a concurrency slot is available, then starts `task`
   * in the background and returns. The caller does not await the
   * task's completion — the slot is held until the task settles.
   */
  run(task: () => Promise<void>): Promise<void>
  /**
   * Waits for every in-flight task to settle, up to `timeoutMs`.
   * @returns true when all tasks drained in time, false when the
   *   deadline fired with tasks still running.
   */
  drain(timeoutMs: number): Promise<boolean>
  /** Count of tasks currently occupying a slot (for logs / metrics). */
  readonly active: number
}

/**
 * @param maxConcurrent - Maximum number of tasks that may run at once.
 *   Must be ≥ 1.
 * @param logger - Pino logger used for drain-timeout warnings.
 */
export function createMigrationRunner(
  maxConcurrent: number,
  logger: Logger,
): MigrationRunner {
  if (maxConcurrent < 1) {
    throw new Error(`maxConcurrent must be >= 1, got ${maxConcurrent}`)
  }

  let active = 0
  const waiters: Array<() => void> = []
  const inFlight = new Set<Promise<void>>()

  function acquire(): Promise<void> {
    if (active < maxConcurrent) {
      active += 1
      return Promise.resolve()
    }
    return new Promise<void>((resolve) => {
      waiters.push(() => {
        active += 1
        resolve()
      })
    })
  }

  function release(): void {
    active -= 1
    const next = waiters.shift()
    if (next) next()
  }

  return {
    async run(task) {
      await acquire()
      // Swallow rejections inside the tracked promise so a task that
      // escapes its own error handling does not produce an unhandled
      // rejection. Callers are expected to wrap their task with a
      // `.catch` that handles logging; this is a belt-and-braces
      // guard so the shutdown drain never sees an unsettled promise.
      const promise = task()
        .catch(() => { /* fire-and-forget contract; see above */ })
        .finally(() => {
          release()
          inFlight.delete(promise)
        })
      inFlight.add(promise)
    },

    async drain(timeoutMs) {
      if (inFlight.size === 0) return true
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined
      const timeout = new Promise<'timeout'>((resolve) => {
        timeoutHandle = setTimeout(() => resolve('timeout'), timeoutMs)
      })
      const settled = Promise.allSettled([...inFlight]).then(() => 'drained' as const)
      try {
        const winner = await Promise.race([settled, timeout])
        if (winner === 'timeout') {
          logger.warn({
            event: 'runner.drain_timeout',
            still_active: active,
            timeout_ms: timeoutMs,
          }, 'Drain timed out with migrations still running')
          return false
        }
        return true
      } finally {
        if (timeoutHandle !== undefined) clearTimeout(timeoutHandle)
      }
    },

    get active() { return active },
  }
}

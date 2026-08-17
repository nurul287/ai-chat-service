const pending = new Set<Promise<unknown>>();

/**
 * Registers a fire-and-forget async operation (one whose caller
 * deliberately never awaits it, so a slow or failing background write can
 * never delay or fail the request that triggered it) so tests can wait for
 * it to settle before running cleanup that might race it against a
 * cascading DELETE. Production code never awaits the returned value or
 * reads `pending` — this exists purely so flushBackgroundWork() (test-only)
 * has something to wait for.
 */
export function trackBackgroundWork(promise: Promise<unknown>): void {
  const settled = promise.then(
    () => undefined,
    () => undefined,
  );
  pending.add(settled);
  void settled.finally(() => pending.delete(settled));
}

/**
 * Test-only: resolves once every tracked fire-and-forget write has
 * settled. Without this, a test whose request triggers a background write
 * (chat metrics, intent-summary refresh) can move on to the next test's
 * cleanup — a cascading DELETE — while that write is still in flight on a
 * separate pooled connection, which can deadlock against the DELETE.
 */
export async function flushBackgroundWork(): Promise<void> {
  await Promise.all([...pending]);
}

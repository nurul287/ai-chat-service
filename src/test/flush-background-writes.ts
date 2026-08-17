import { afterEach } from "vitest";
import { flushBackgroundWork } from "../lib/background-work";
import { flushApiKeyTouches } from "../tenants/tenants.service";

/**
 * Several code paths deliberately write to Postgres without ever being
 * awaited by their caller — verifyApiKey/verifyPublishableApiKey's
 * last_used_at touch, chat's post-reply metrics recording, and the
 * intent-summary refresh — because none of them may add latency to or fail
 * the request that triggered them. That's correct for production, but it
 * leaves a real race in tests: any test whose request triggers one of these
 * can move on to the next test's cleanup — a cascading `DELETE FROM
 * tenants` — while the write is still in flight on a separate pooled
 * connection, and the two can deadlock on overlapping row locks under CI's
 * timing.
 *
 * Registered globally (not per test file) so every test — not just the
 * ones that happen to remember — waits for its own pending background
 * writes to settle before the next test's cleanup runs. A no-op for tests
 * that never trigger one.
 */
afterEach(async () => {
  await Promise.all([flushApiKeyTouches(), flushBackgroundWork()]);
});

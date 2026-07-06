import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Suites share one Postgres database and reset it between tests —
    // run files serially so they can't truncate each other mid-flight.
    fileParallelism: false,
    // Integration tests gate themselves on env vars (HUB_TEST_MQTT, TEST_DATABASE_URL)
    // and skip cleanly when the backing service is unavailable.
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});

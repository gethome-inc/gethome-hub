import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Files run in parallel. They used to run serially because every suite
    // shared one Postgres database and reset it between tests; there is no
    // server now — `test/helpers/db.ts` gives each suite its own SQLite file
    // in a temp directory, the API suites listen on port 0, and the two
    // end-to-end suites use different Zigbee2MQTT base topics on the broker.
    // Nothing is left for one file to truncate out from under another.
    //
    // The end-to-end suites gate themselves on HUB_TEST_MQTT and skip cleanly
    // when no broker is running.
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});

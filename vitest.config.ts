import {defineConfig} from 'vitest/config';

// Isolate the home namespace for the whole test run. Several config tests call
// `loadConfig` without an explicit `SKEIN_HOME`/`MOSAIC_HOME`, which otherwise
// resolves to the developer's real `~/.mosaic` — leaking (and potentially
// mutating) live credentials and making trust-boundary assertions depend on
// local machine state. Pinning the home namespace to a throwaway temp dir keeps
// the suite hermetic.
export default defineConfig({
  test: {
    setupFiles: ['./test/setup/isolate-home.ts'],
  },
});

import {configDefaults, defineConfig} from 'vitest/config';

// Isolate the home namespace for the whole test run. Several config tests call
// `loadConfig` without an explicit `SKEIN_HOME`/`MOSAIC_HOME`, which otherwise
// resolves to the developer's real `~/.mosaic` — leaking (and potentially
// mutating) live credentials and making trust-boundary assertions depend on
// local machine state. Pinning the home namespace to a throwaway temp dir keeps
// the suite hermetic.
export default defineConfig({
  test: {
    setupFiles: ['./test/setup/isolate-home.ts'],
    // Several CLI suites intentionally cold-start tsx child processes while
    // executable UI benchmarks measure wall-clock budgets. Bounding file-level
    // workers avoids oversubscribing those child processes on developer and CI
    // hosts, which otherwise turns healthy behavior into timeout-only flakes.
    maxWorkers: 2,
    // Editor and agent worktrees hold full checkouts of this repository;
    // without the exclusion every committed test file is discovered twice.
    exclude: [...configDefaults.exclude, '**/.claude/**', '**/.mosaic/**', '**/.skein/**'],
  },
});

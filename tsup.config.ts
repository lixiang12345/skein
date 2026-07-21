import {defineConfig} from 'tsup';

export default defineConfig({
  entry: ['src/cli.tsx'],
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  bundle: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  banner: {js: '#!/usr/bin/env node'},
  noExternal: ['ink-text-input'],
  removeNodeProtocol: false,
});

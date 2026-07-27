import {readFile} from 'node:fs/promises';
import {describe, expect, it} from 'vitest';

describe('project documentation truth guards', () => {
  it('binds the handoff baseline and verified package name to package.json', async () => {
    const [packageJson, nextSteps] = await Promise.all([
      readFile('package.json', 'utf8'),
      readFile('docs/NEXT_STEPS.md', 'utf8'),
    ]);
    const {version} = JSON.parse(packageJson) as {version: string};
    expect(nextSteps).toContain(`Current repository version: \`${version}\`.`);
    expect(nextSteps).toContain(`The latest verified package is \`skein-code-cli-${version}.tgz\`.`);
    expect(nextSteps).toContain(`\`artifacts/package/skein-code-cli-${version}.tgz.sha256\``);
  });

  it('does not regress shipped local review and upgrade capabilities to backlog claims', async () => {
    const benchmark = await readFile('docs/PRODUCT_BENCHMARK.md', 'utf8');
    expect(benchmark).toContain('Ask, Plan, and Build modes');
    expect(benchmark).toContain('deterministic redacted review bundle');
    expect(benchmark).toContain('manager-aware self-update');
    expect(benchmark).not.toContain('Ask and Build modes exist; Ask is read-only');
    expect(benchmark).not.toContain('no shareable artifact or review bundle');
    expect(benchmark).not.toContain('Add capability review and upgrade UX');
  });

  it('keeps CLI Excellence linked to the authorized Notion tracker', async () => {
    const excellence = await readFile('docs/CLI_EXCELLENCE.md', 'utf8');
    expect(excellence).toContain('https://app.notion.com/p/cf684ae61fd1428ea044d5d6636ed447');
    expect(excellence).not.toContain('pending one-time OAuth');
  });
});

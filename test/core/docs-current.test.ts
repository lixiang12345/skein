import {readFile} from 'node:fs/promises';
import {describe, expect, it} from 'vitest';
import {PRODUCT_MARK, PRODUCT_NAME} from '../../src/brand.js';
import {EMBLEM_LINES, EMBLEM_WIDTH, LOGO_LINES, LOGO_WIDTH} from '../../src/ui/logo.js';

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

  it('keeps the terminal identity description bound to the shipped wordmark and fallbacks', async () => {
    const brand = await readFile('docs/BRAND.md', 'utf8');
    const wordmarkWidth = LOGO_WIDTH + 2 + 6;
    const emblemWidth = 2 + LOGO_WIDTH + 1 + EMBLEM_WIDTH + 2;

    expect(LOGO_LINES).toHaveLength(5);
    expect(EMBLEM_LINES).toHaveLength(LOGO_LINES.length);
    expect(brand).toContain(`${LOGO_LINES.length}-row block \`${PRODUCT_NAME.toUpperCase()}\` wordmark`);
    expect(brand).toContain(`appears at ${wordmarkWidth} or more terminal columns`);
    expect(brand).toContain(`At ${emblemWidth} or more terminal columns`);
    expect(brand).toContain(`one-cell transcript signer \`${PRODUCT_MARK}\``);
    expect(brand).toContain('ASCII fallback: `*` with the text name `SKEIN`');
    expect(brand).toContain('`TERM=dumb`, and screen-reader sessions select this deterministic path');
  });
});

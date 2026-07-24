import {describe, expect, it} from 'vitest';
import {
  detectPackageManager,
  resolveUpgradePlan,
  upgradeCommandOverride,
} from '../../src/utils/self-update.js';
import {PACKAGE_NAME} from '../../src/utils/update-check.js';

describe('detectPackageManager', () => {
  it('prefers the npm_config_user_agent hint when present', () => {
    expect(detectPackageManager('/usr/local/bin/skein', {npm_config_user_agent: 'pnpm/8.15.0 npm/? node/v22'})).toBe('pnpm');
    expect(detectPackageManager('/usr/local/bin/skein', {npm_config_user_agent: 'yarn/1.22.0'})).toBe('yarn');
    expect(detectPackageManager('/usr/local/bin/skein', {npm_config_user_agent: 'bun/1.1.0'})).toBe('bun');
    expect(detectPackageManager('/usr/local/bin/skein', {npm_config_user_agent: 'npm/10.0.0'})).toBe('npm');
  });

  it('falls back to the resolved binary path when no user agent is set', () => {
    expect(detectPackageManager('/Users/x/.bun/bin/skein', {})).toBe('bun');
    expect(detectPackageManager('/Users/x/Library/pnpm/skein', {})).toBe('pnpm');
    expect(detectPackageManager('/Users/x/.config/yarn/global/node_modules/.bin/skein', {})).toBe('yarn');
  });

  it('defaults to npm for an unrecognised path', () => {
    expect(detectPackageManager('/usr/local/bin/skein', {})).toBe('npm');
    expect(detectPackageManager(undefined, {})).toBe('npm');
  });

  it('ignores an unknown user agent and uses the path instead', () => {
    expect(detectPackageManager('/Users/x/.bun/bin/skein', {npm_config_user_agent: 'deno/1.0'})).toBe('bun');
  });
});

describe('resolveUpgradePlan', () => {
  it('builds a pinned global-install argv for the detected manager', () => {
    const plan = resolveUpgradePlan({version: '1.2.3', env: {}, binaryPath: '/usr/local/bin/skein'});
    expect(plan.manager).toBe('npm');
    expect(plan.command).toBe('npm');
    expect(plan.args).toEqual(['install', '-g', `${PACKAGE_NAME}@1.2.3`]);
    expect(plan.display).toBe(`npm install -g ${PACKAGE_NAME}@1.2.3`);
  });

  it('uses each manager’s global-install verb', () => {
    expect(resolveUpgradePlan({env: {npm_config_user_agent: 'pnpm/8'}}).args).toEqual(['add', '-g', `${PACKAGE_NAME}@latest`]);
    expect(resolveUpgradePlan({env: {npm_config_user_agent: 'yarn/1'}}).args).toEqual(['global', 'add', `${PACKAGE_NAME}@latest`]);
    expect(resolveUpgradePlan({env: {npm_config_user_agent: 'bun/1'}}).args).toEqual(['add', '-g', `${PACKAGE_NAME}@latest`]);
  });

  it('keeps the package spec as a single argv token so it cannot be shell-interpreted', () => {
    const plan = resolveUpgradePlan({version: 'latest; rm -rf /', env: {}});
    expect(plan.args.at(-1)).toBe(`${PACKAGE_NAME}@latest; rm -rf /`);
  });
});

describe('upgradeCommandOverride', () => {
  it('returns the trimmed override when set', () => {
    expect(upgradeCommandOverride({SKEIN_UPDATE_COMMAND: '  brew upgrade skein  '})).toBe('brew upgrade skein');
  });

  it('honours the legacy Mosaic variable', () => {
    expect(upgradeCommandOverride({MOSAIC_UPDATE_COMMAND: 'apt update'})).toBe('apt update');
  });

  it('prefers the Skein variable over the legacy one', () => {
    expect(upgradeCommandOverride({SKEIN_UPDATE_COMMAND: 'skein-cmd', MOSAIC_UPDATE_COMMAND: 'mosaic-cmd'})).toBe('skein-cmd');
  });

  it('is undefined when unset or blank', () => {
    expect(upgradeCommandOverride({})).toBeUndefined();
    expect(upgradeCommandOverride({SKEIN_UPDATE_COMMAND: '   '})).toBeUndefined();
  });
});

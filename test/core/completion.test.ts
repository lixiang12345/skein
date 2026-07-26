import {describe, expect, it} from 'vitest';
import {generateShellCompletion} from '../../src/cli/completion.js';

describe('shell completion', () => {
  it.each(['bash', 'zsh', 'fish'] as const)('generates deterministic %s completion', (shell) => {
    const output = generateShellCompletion(shell);
    expect(output).toContain('skein');
    expect(output).toContain('session');
    expect(output).toContain('fork');
    expect(output).toContain('completion');
    expect(output).not.toMatch(/[\u0000\r]/u);
  });

  it('includes global flags in bash completion', () => {
    const output = generateShellCompletion('bash');
    expect(output).toContain('--connection');
    expect(output).toContain('--trust-project-config');
    expect(output).toContain('complete -F _skein_completion skein');
  });
});

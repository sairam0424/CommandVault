import { describe, it, expect } from 'vitest';
import {
  generateBash,
  generateZsh,
  generateFish,
  SUBCOMMANDS,
} from '../../commands/completions.js';

describe('completions command', () => {
  describe('bash completions', () => {
    it('produces non-empty output', () => {
      const output = generateBash();
      expect(output.length).toBeGreaterThan(0);
    });

    it('includes the complete function registration', () => {
      const output = generateBash();
      expect(output).toContain('complete -F _vault_completions vault');
    });

    it('contains all subcommand names', () => {
      const output = generateBash();
      for (const cmd of SUBCOMMANDS) {
        expect(output).toContain(cmd);
      }
    });
  });

  describe('zsh completions', () => {
    it('produces non-empty output', () => {
      const output = generateZsh();
      expect(output.length).toBeGreaterThan(0);
    });

    it('includes compdef registration', () => {
      const output = generateZsh();
      expect(output).toContain('compdef _vault vault');
    });

    it('contains all subcommand names', () => {
      const output = generateZsh();
      for (const cmd of SUBCOMMANDS) {
        expect(output).toContain(cmd);
      }
    });
  });

  describe('fish completions', () => {
    it('produces non-empty output', () => {
      const output = generateFish();
      expect(output.length).toBeGreaterThan(0);
    });

    it('uses fish complete syntax', () => {
      const output = generateFish();
      expect(output).toContain('complete -c vault');
    });

    it('contains all subcommand names', () => {
      const output = generateFish();
      for (const cmd of SUBCOMMANDS) {
        expect(output).toContain(cmd);
      }
    });

    it('includes global flags', () => {
      const output = generateFish();
      expect(output).toContain('-l json');
      expect(output).toContain('-l claude-path');
      expect(output).toContain('-l tier');
    });
  });
});

import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { context, createSandbox, parseJson, type RunResult, type Sandbox } from './harness.js';

/** `vault audit`, `info` and `import` against the BUILT binary. */

vi.setConfig({ testTimeout: 60_000 });

const EXIT_FAILURE = 1;
const EXIT_USAGE = 2;

interface AuditReport {
  readonly stale: ReadonlyArray<{ readonly name: string }>;
  readonly missing: ReadonlyArray<{ readonly name: string; readonly filePath: string }>;
  readonly summary: {
    readonly missingCount: number;
    readonly lowQualityCount: number;
  };
}

const boxes: Sandbox[] = [];

function newBox(): Sandbox {
  const box = createSandbox();
  boxes.push(box);
  return box;
}

afterEach(() => {
  for (const box of boxes.splice(0)) box.dispose();
});

function errorLines(result: RunResult): string[] {
  return result.stderr.split('\n').filter((line) => line.startsWith('error:'));
}

describe('built CLI: audit validates its thresholds', () => {
  it.each([
    ['a non-numeric --threshold', ['audit', '--threshold', 'abc'], /--threshold/],
    ['a negative --threshold', ['audit', '--threshold', '-5'], /--threshold/],
    ['a fractional --threshold', ['audit', '--threshold', '1.5'], /--threshold/],
    ['a --threshold with trailing text', ['audit', '--threshold', '30days'], /--threshold/],
    ['a non-numeric --min-score', ['audit', '--min-score', 'abc'], /--min-score/],
    ['a --min-score above 100', ['audit', '--min-score', '101'], /--min-score/],
  ])('rejects %s with exit 2 before opening the vault', (_name, args, message) => {
    const result = newBox().run(args);

    expect(result.status, context(result)).toBe(EXIT_USAGE);
    expect(errorLines(result), context(result)).toHaveLength(1);
    expect(result.stderr, context(result)).toMatch(message);
    expect(result.stdout, context(result)).toBe('');
  });
});

describe('built CLI: audit reports the truth', () => {
  it('does not report a settings.json hook as stale or as a missing source', () => {
    const result = newBox().run(['audit', '--json']);

    expect(result.status, context(result)).toBe(0);
    const report = parseJson<AuditReport>(result);
    expect(report.summary.missingCount, context(result)).toBe(0);
    expect(report.stale.map((entry) => entry.name)).not.toContain('PreToolUse:Bash:echo hi');
  });

  it('reports a hook whose script was deleted as a missing source', () => {
    const box = newBox();
    const script = join(box.home, '.claude', 'hooks', 'deleted-guard.js');
    writeFileSync(
      join(box.home, '.claude', 'settings.json'),
      JSON.stringify({
        hooks: {
          PreToolUse: [
            { matcher: 'Bash', hooks: [{ type: 'command', command: `node ${script}` }] },
          ],
        },
      }),
    );

    const result = box.run(['audit', '--json']);

    expect(result.status, context(result)).toBe(0);
    const report = parseJson<AuditReport>(result);
    expect(report.summary.missingCount, context(result)).toBe(1);
    expect(report.missing.map((entry) => entry.filePath)).toEqual([script]);
  });

  it('judges relative, tilde and environment-variable hook scripts by settings.json, from any cwd', () => {
    const box = newBox();
    const hooksDir = join(box.home, '.claude', 'hooks');
    mkdirSync(hooksDir, { recursive: true });
    writeFileSync(join(hooksDir, 'rel.js'), '// relative hook');
    const commands = [
      'node hooks/rel.js',
      'node ~/x/tilde.js',
      'node ${CLAUDE_PLUGIN_ROOT}/hooks/env.js',
      'node $HOME/x/home.js',
    ];
    writeFileSync(
      join(box.home, '.claude', 'settings.json'),
      JSON.stringify({
        hooks: {
          PreToolUse: [{ matcher: 'Bash', hooks: commands.map((command) => ({ command })) }],
        },
      }),
    );

    const result = box.run(['audit', '--json']);

    expect(result.status, context(result)).toBe(0);
    const report = parseJson<AuditReport>(result);
    expect(report.missing, context(result)).toEqual([]);
    expect(report.stale, context(result)).toEqual([]);
  });

  it('lists the entries whose source is missing in the JSON output', () => {
    const result = newBox().run(['audit', '--json']);

    expect(parseJson<AuditReport>(result).missing).toEqual([]);
  });

  it('exits 0 by default even when entries score below --min-score', () => {
    const result = newBox().run(['audit', '--min-score', '100']);

    expect(result.status, context(result)).toBe(0);
  });

  it('exits 1 with --fail-under when entries score below --min-score', () => {
    const box = newBox();
    const count = parseJson<AuditReport>(box.run(['audit', '--json', '--min-score', '100'])).summary
      .lowQualityCount;
    expect(count).toBeGreaterThan(0);

    const result = box.run(['audit', '--fail-under', '--min-score', '100']);

    expect(result.status, context(result)).toBe(EXIT_FAILURE);
    expect(result.stderr, context(result)).toMatch(
      new RegExp(`^error: ${count} entr(y|ies) scored below 100$`, 'm'),
    );
    expect(result.stdout, context(result)).toContain('Vault Audit Report');
  });

  it('exits 0 with --fail-under when nothing scores below --min-score', () => {
    const result = newBox().run(['audit', '--fail-under', '--min-score', '0']);

    expect(result.status, context(result)).toBe(0);
  });
});

describe('built CLI: info prints only what is known', () => {
  it('leaves out metadata fields that have no value instead of printing undefined', () => {
    const box = newBox();
    for (const name of ['demo-skill', 'demo-agent', 'demo-cmd']) {
      const result = box.run(['info', name]);
      expect(result.status, context(result)).toBe(0);
      expect(result.stdout, context(result)).not.toContain('undefined');
    }
  });
});

describe('built CLI: import separates errors from warnings', () => {
  function bundleWithOneBadRecord(box: Sandbox): string {
    const file = join(box.workDir, 'bundle.vault.json');
    writeFileSync(
      file,
      JSON.stringify({
        version: '1',
        source: 'e2e',
        entries: [
          { name: 'good-one', type: 'skill', description: 'fine' },
          { name: 'bad-one', type: 'nonsense', description: 'skipped' },
        ],
      }),
    );
    return file;
  }

  it('counts the skipped record as an error and still imports the valid one', () => {
    const box = newBox();
    const result = box.run(['import', bundleWithOneBadRecord(box), '--dry-run']);

    expect(result.status, context(result)).toBe(0);
    expect(result.stderr, context(result)).toMatch(/1 error, 0 warnings/);
    expect(result.stderr, context(result)).toContain('Invalid entry type "nonsense"');
    expect(result.stdout, context(result)).toContain('good-one');
  });
});

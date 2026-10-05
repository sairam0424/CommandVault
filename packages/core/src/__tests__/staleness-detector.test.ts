import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectStaleness } from '../indexer/staleness-detector.js';
import type { VaultEntry } from '../types/index.js';

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const THRESHOLD_DAYS = 30;

function entryAt(filePath: string, type: VaultEntry['type'] = 'skill'): VaultEntry {
  return {
    id: `${type}-${filePath}`,
    name: filePath,
    type,
    source: 'custom',
    description: '',
    filePath,
    tags: [],
    metadata: {},
    content: '',
    lastModified: new Date(),
    favorite: false,
    usageCount: 0,
  };
}

async function ageFile(path: string, days: number): Promise<void> {
  const when = new Date(Date.now() - days * MS_PER_DAY);
  await utimes(path, when, when);
}

describe('detectStaleness', () => {
  let dir: string;
  let settingsPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'vault-stale-test-'));
    settingsPath = join(dir, 'settings.json');
    await writeFile(settingsPath, '{}');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('judges a file entry by its own file', async () => {
    const skill = join(dir, 'SKILL.md');
    await writeFile(skill, 'x');
    await ageFile(skill, 90);

    const [result] = await detectStaleness([entryAt(skill)], THRESHOLD_DAYS, { settingsPath });

    expect(result).toMatchObject({ sourceFileExists: true, isStale: true, daysSinceModified: 90 });
  });

  it('reports a file entry whose file is gone as missing', async () => {
    const [result] = await detectStaleness([entryAt(join(dir, 'gone.md'))], THRESHOLD_DAYS, {
      settingsPath,
    });

    expect(result).toMatchObject({ sourceFileExists: false, isStale: true });
  });

  describe('hook entries', () => {
    it('are judged by settings.json when the command is not a file', async () => {
      const [result] = await detectStaleness([entryAt('echo hi', 'hook')], THRESHOLD_DAYS, {
        settingsPath,
      });

      expect(result).toMatchObject({ sourceFileExists: true, isStale: false });
    });

    it('go stale when settings.json has not changed for longer than the threshold', async () => {
      await ageFile(settingsPath, 120);

      const [result] = await detectStaleness([entryAt('echo hi', 'hook')], THRESHOLD_DAYS, {
        settingsPath,
      });

      expect(result).toMatchObject({
        sourceFileExists: true,
        isStale: true,
        daysSinceModified: 120,
      });
    });

    it('are judged by their script when the script exists', async () => {
      const script = join(dir, 'hooks', 'guard.js');
      await mkdir(join(dir, 'hooks'));
      await writeFile(script, 'x');
      await ageFile(script, 200);

      const [result] = await detectStaleness([entryAt(script, 'hook')], THRESHOLD_DAYS, {
        settingsPath,
      });

      expect(result).toMatchObject({ isStale: true, daysSinceModified: 200 });
    });

    it('are missing when the absolute script they name no longer exists', async () => {
      const [result] = await detectStaleness(
        [entryAt(join(dir, 'hooks', 'deleted-guard.js'), 'hook')],
        THRESHOLD_DAYS,
        { settingsPath },
      );

      expect(result).toMatchObject({ sourceFileExists: false, isStale: true });
    });

    describe('whose script path is not absolute', () => {
      const unresolvable = [
        ['a relative path nothing holds', 'hooks/nowhere.js'],
        ['a tilde path', '~/x/tilde.js'],
        ['a $VAR path', '$HOME/x/home.js'],
        ['a ${VAR} path', '${CLAUDE_PLUGIN_ROOT}/hooks/env.js'],
      ] as const;

      it.each(unresolvable)('are judged by settings.json for %s', async (_label, scriptPath) => {
        const [result] = await detectStaleness([entryAt(scriptPath, 'hook')], THRESHOLD_DAYS, {
          settingsPath,
        });

        expect(result).toMatchObject({ sourceFileExists: true, isStale: false });
      });

      it('do not depend on the current directory', async () => {
        const cwdDir = await mkdtemp(join(tmpdir(), 'vault-stale-cwd-'));
        await mkdir(join(cwdDir, 'hooks'));
        const elsewhere = join(cwdDir, 'hooks', 'nowhere.js');
        await writeFile(elsewhere, 'x');
        await ageFile(elsewhere, 200);
        const previous = process.cwd();
        process.chdir(cwdDir);
        try {
          const [result] = await detectStaleness(
            [entryAt('hooks/nowhere.js', 'hook')],
            THRESHOLD_DAYS,
            { settingsPath },
          );
          expect(result).toMatchObject({ sourceFileExists: true, isStale: false });
        } finally {
          process.chdir(previous);
          await rm(cwdDir, { recursive: true, force: true });
        }
      });

      it('judge a relative script by the file under the settings directory', async () => {
        const script = join(dir, 'hooks', 'rel.js');
        await mkdir(join(dir, 'hooks'));
        await writeFile(script, 'x');
        await ageFile(script, 200);

        const [result] = await detectStaleness([entryAt('hooks/rel.js', 'hook')], THRESHOLD_DAYS, {
          settingsPath,
        });

        expect(result).toMatchObject({ isStale: true, daysSinceModified: 200 });
      });
    });

    it('are missing when settings.json itself is gone', async () => {
      const [result] = await detectStaleness([entryAt('echo hi', 'hook')], THRESHOLD_DAYS, {
        settingsPath: join(dir, 'no-such-settings.json'),
      });

      expect(result).toMatchObject({ sourceFileExists: false, isStale: true });
    });

    it('have no source to check without a settings path', async () => {
      const [result] = await detectStaleness([entryAt('echo hi', 'hook')], THRESHOLD_DAYS);

      expect(result).toMatchObject({ sourceFileExists: false });
    });

    it('never fall back to settings.json for other entry types', async () => {
      const [result] = await detectStaleness(
        [entryAt(join(dir, 'gone.md'), 'agent')],
        THRESHOLD_DAYS,
        {
          settingsPath,
        },
      );

      expect(result).toMatchObject({ sourceFileExists: false });
    });
  });
});

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseHooks } from '../parsers/hook-parser.js';
import { createVault } from '../vault.js';
import type { Vault } from '../vault.js';
import type { VaultEntry } from '../types/index.js';

/**
 * A hook command in settings.json names a script, and the entry's content is that script's text.
 * Where a relative script is looked for must not depend on the directory the scan runs from, the
 * same defect class as CV-G1-020: the index would change with the shell's cwd. The settings file's
 * own directory is always a root, and so is a project directory the caller passed explicitly.
 * The current directory is never one.
 *
 * Every directory is a realpath unless a test says it is a symlink: macOS reports `process.cwd()`
 * through /private, and a project or settings directory may legitimately be reached through a link.
 */

const ORIGINAL_CWD = process.cwd();
const SETTINGS_BODY = 'script in the settings directory';
const PROJECT_BODY = 'script in the project directory';
const CWD_BODY = 'script in the current directory';

let root: string;
let claudeDir: string;
let projectDir: string;
let otherDir: string;
let vault: Vault | null;

async function writeIn(dir: string, relativePath: string, body: string): Promise<string> {
  const filePath = join(dir, ...relativePath.split('/'));
  await mkdir(join(filePath, '..'), { recursive: true });
  await writeFile(filePath, body);
  return filePath;
}

async function linkTo(target: string, name: string): Promise<string> {
  const linkPath = join(root, name);
  await symlink(target, linkPath);
  return linkPath;
}

async function writeSettings(command: string, dir: string = claudeDir): Promise<string> {
  const hooks = { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command }] }] };
  return writeIn(dir, 'settings.json', JSON.stringify({ hooks }));
}

async function parseHookContent(
  settingsPath: string,
  options?: { projectRoot?: string },
): Promise<string> {
  const { entries, errors } = await parseHooks(settingsPath, options);
  expect(errors).toEqual([]);
  expect(entries).toHaveLength(1);
  return entries[0]?.content ?? '';
}

async function scanHookContent(
  projectRoot?: string,
  claudeConfigPath: string = claudeDir,
): Promise<VaultEntry | undefined> {
  vault = createVault({
    claudeConfigPath,
    dbPath: join(root, 'vault.db'),
    enableWatcher: false,
    ...(projectRoot === undefined ? {} : { projectRoot }),
  });
  await vault.initialize();
  return vault.getEntriesByType('hook')[0];
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'cv-hook-roots-')));
  claudeDir = join(root, 'claude');
  projectDir = join(root, 'project');
  otherDir = join(root, 'elsewhere');
  await Promise.all([
    mkdir(claudeDir, { recursive: true }),
    mkdir(projectDir, { recursive: true }),
    mkdir(otherDir, { recursive: true }),
  ]);
  vault = null;
});

afterEach(async () => {
  process.chdir(ORIGINAL_CWD);
  await vault?.dispose();
  await rm(root, { recursive: true, force: true });
});

describe('parseHooks with a relative script', () => {
  it('does not read a script that only exists in the current directory', async () => {
    const settingsPath = await writeSettings('node ./x.js');
    await writeIn(otherDir, 'x.js', CWD_BODY);
    process.chdir(otherDir);

    const content = await parseHookContent(settingsPath);

    expect(content).toBe('// Command: node ./x.js');
    expect(content).not.toContain(CWD_BODY);
  });

  it('reads the script from the settings directory', async () => {
    const settingsPath = await writeSettings('node hooks/x.js');
    await writeIn(claudeDir, 'hooks/x.js', SETTINGS_BODY);

    expect(await parseHookContent(settingsPath)).toBe(SETTINGS_BODY);
  });

  it('gives the same content from two different current directories', async () => {
    const settingsPath = await writeSettings('node hooks/x.js');
    await writeIn(claudeDir, 'hooks/x.js', SETTINGS_BODY);
    await writeIn(otherDir, 'hooks/x.js', CWD_BODY);

    process.chdir(otherDir);
    const fromOther = await parseHookContent(settingsPath);
    process.chdir(claudeDir);
    const fromSettingsDir = await parseHookContent(settingsPath);
    process.chdir(projectDir);
    const fromProject = await parseHookContent(settingsPath);

    expect(fromOther).toBe(SETTINGS_BODY);
    expect(fromSettingsDir).toBe(SETTINGS_BODY);
    expect(fromProject).toBe(SETTINGS_BODY);
  });

  it('gives the same fallback from a directory that has the script and one that has not', async () => {
    const settingsPath = await writeSettings('node ./x.js');
    await writeIn(otherDir, 'x.js', CWD_BODY);

    process.chdir(otherDir);
    const withScript = await parseHookContent(settingsPath);
    process.chdir(projectDir);
    const withoutScript = await parseHookContent(settingsPath);

    expect(withScript).toBe(withoutScript);
  });

  it('does not follow a path out of the settings directory', async () => {
    await writeIn(root, 'outside.js', CWD_BODY);
    const settingsPath = await writeSettings('node ../outside.js');

    expect(await parseHookContent(settingsPath)).not.toContain(CWD_BODY);
  });
});

describe('parseHooks with an absolute script', () => {
  it('does not read one that is only inside the current directory', async () => {
    const script = await writeIn(otherDir, 'abs.js', CWD_BODY);
    const settingsPath = await writeSettings(`node ${script}`);
    process.chdir(otherDir);

    expect(await parseHookContent(settingsPath)).toBe(`// Command: node ${script}`);
  });

  it('reads one inside the settings directory', async () => {
    const script = await writeIn(claudeDir, 'hooks/abs.js', SETTINGS_BODY);
    const settingsPath = await writeSettings(`node ${script}`);

    expect(await parseHookContent(settingsPath)).toBe(SETTINGS_BODY);
  });
});

describe('parseHooks with an explicit project root', () => {
  it('reads a relative script from the project directory, whatever the current directory', async () => {
    const settingsPath = await writeSettings('node scripts/x.js');
    await writeIn(projectDir, 'scripts/x.js', PROJECT_BODY);
    await writeIn(otherDir, 'scripts/x.js', CWD_BODY);
    process.chdir(otherDir);

    expect(await parseHookContent(settingsPath, { projectRoot: projectDir })).toBe(PROJECT_BODY);
  });

  it('reads an absolute script inside the project directory', async () => {
    const script = await writeIn(projectDir, 'scripts/abs.js', PROJECT_BODY);
    const settingsPath = await writeSettings(`node ${script}`);
    process.chdir(otherDir);

    expect(await parseHookContent(settingsPath, { projectRoot: projectDir })).toBe(PROJECT_BODY);
  });

  it('prefers the project directory, where hooks run, when both have the script', async () => {
    const settingsPath = await writeSettings('node hooks/x.js');
    await writeIn(claudeDir, 'hooks/x.js', SETTINGS_BODY);
    await writeIn(projectDir, 'hooks/x.js', PROJECT_BODY);

    expect(await parseHookContent(settingsPath, { projectRoot: projectDir })).toBe(PROJECT_BODY);
  });

  it('still reads from the settings directory when the project has no such script', async () => {
    const settingsPath = await writeSettings('node hooks/x.js');
    await writeIn(claudeDir, 'hooks/x.js', SETTINGS_BODY);

    expect(await parseHookContent(settingsPath, { projectRoot: projectDir })).toBe(SETTINGS_BODY);
  });

  it.each(['', '   '])('does not read %j as the current directory', async (blank) => {
    const settingsPath = await writeSettings('node ./x.js');
    await writeIn(otherDir, 'x.js', CWD_BODY);
    process.chdir(otherDir);

    expect(await parseHookContent(settingsPath, { projectRoot: blank })).toBe(
      '// Command: node ./x.js',
    );
  });
});

describe('Vault hook entries', () => {
  it('index the same hook content from any current directory when no project is given', async () => {
    await writeSettings('node ./x.js');
    await writeIn(otherDir, 'x.js', CWD_BODY);
    process.chdir(otherDir);

    const entry = await scanHookContent();

    expect(entry?.content).toBe('// Command: node ./x.js');
  });

  it('read a relative script from the explicit project directory', async () => {
    await writeSettings('node scripts/x.js');
    await writeIn(projectDir, 'scripts/x.js', PROJECT_BODY);
    await writeIn(otherDir, 'scripts/x.js', CWD_BODY);
    process.chdir(otherDir);

    const entry = await scanHookContent(projectDir);

    expect(entry?.content).toBe(PROJECT_BODY);
  });

  it('do not treat a blank project directory as the current directory', async () => {
    await writeSettings('node ./x.js');
    await writeIn(otherDir, 'x.js', CWD_BODY);
    process.chdir(otherDir);

    const entry = await scanHookContent('');

    expect(entry?.content).toBe('// Command: node ./x.js');
  });

  it('still index every hook when the project directory does not exist', async () => {
    // A typo or a deleted workspace folder must cost the user the project scan only: resolving the
    // missing root (realpath) must not reject, or runParserSafely would drop ALL hook entries.
    const settingsPath = await writeSettings('node ./x.js');
    const missing = join(root, 'no-such-project');

    expect(await parseHookContent(settingsPath, { projectRoot: missing })).toBe(
      '// Command: node ./x.js',
    );
    const entry = await scanHookContent(missing);
    expect(entry?.content).toBe('// Command: node ./x.js');
  });
});

// Windows cannot create a symlink without SeCreateSymbolicLinkPrivilege (an elevated shell or
// Developer Mode), which a developer machine often lacks, and this block links a file as well as
// directories (a junction would only cover directories). Posix only; the containment rules
// themselves are covered for Windows paths in path-containment.test.ts and safe-path-win32.test.ts.
const describePosixOnly = describe.skipIf(process.platform === 'win32');

describePosixOnly('a project or settings directory reached through a symlink', () => {
  it('reads a relative script from a project directory given as a symlink', async () => {
    const settingsPath = await writeSettings('node scripts/x.js');
    await writeIn(projectDir, 'scripts/x.js', PROJECT_BODY);
    const projectLink = await linkTo(projectDir, 'project-link');

    expect(await parseHookContent(settingsPath, { projectRoot: projectLink })).toBe(PROJECT_BODY);
  });

  it('reads an absolute script spelled through the project symlink', async () => {
    await writeIn(projectDir, 'scripts/abs.js', PROJECT_BODY);
    const projectLink = await linkTo(projectDir, 'project-link');
    const settingsPath = await writeSettings(`node ${join(projectLink, 'scripts', 'abs.js')}`);

    expect(await parseHookContent(settingsPath, { projectRoot: projectLink })).toBe(PROJECT_BODY);
  });

  it('reads a relative script when the settings directory is a symlink', async () => {
    await writeSettings('node hooks/x.js');
    await writeIn(claudeDir, 'hooks/x.js', SETTINGS_BODY);
    const claudeLink = await linkTo(claudeDir, 'claude-link');

    expect(await parseHookContent(join(claudeLink, 'settings.json'))).toBe(SETTINGS_BODY);
  });

  it('index the script body when a Vault is given symlinks to both directories', async () => {
    await writeSettings('node scripts/x.js');
    await writeIn(projectDir, 'scripts/x.js', PROJECT_BODY);
    const projectLink = await linkTo(projectDir, 'project-link');
    const claudeLink = await linkTo(claudeDir, 'claude-link');

    const entry = await scanHookContent(projectLink, claudeLink);

    expect(entry?.content).toBe(PROJECT_BODY);
  });

  it.each([
    ['a real', false],
    ['a symlinked', true],
  ])('does not read a script that links out of %s project directory', async (_label, viaLink) => {
    const settingsPath = await writeSettings('node scripts/x.js');
    const outside = await writeIn(otherDir, 'outside.js', CWD_BODY);
    await mkdir(join(projectDir, 'scripts'), { recursive: true });
    await symlink(outside, join(projectDir, 'scripts', 'x.js'));
    const projectRoot = viaLink ? await linkTo(projectDir, 'project-link') : projectDir;

    const content = await parseHookContent(settingsPath, { projectRoot });

    expect(content).toBe('// Command: node scripts/x.js');
  });

  it('climbs .. from the real project directory, not from the link to it', async () => {
    // The link is in root, the real directory two levels down. A hook runs in the real directory,
    // where `..` is root/deep/nested; taken from the link it would be root, and nothing is there.
    const realProject = join(root, 'deep', 'nested', 'app');
    await writeIn(realProject, 'scripts/x.js', PROJECT_BODY);
    const projectLink = await linkTo(realProject, 'app-link');
    const settingsPath = await writeSettings('node ../app/scripts/x.js');

    expect(await parseHookContent(settingsPath, { projectRoot: projectLink })).toBe(PROJECT_BODY);
  });

  it('climbs .. from the real settings directory, not from the link to it', async () => {
    const realClaude = join(root, 'deep', 'nested', 'claude-home');
    await writeIn(realClaude, 'hooks/x.js', SETTINGS_BODY);
    const claudeLink = await linkTo(realClaude, 'claude-link');
    await writeSettings('node ../claude-home/hooks/x.js', realClaude);

    expect(await parseHookContent(join(claudeLink, 'settings.json'))).toBe(SETTINGS_BODY);
  });

  it('does not follow a path out of a symlinked project directory', async () => {
    await writeIn(root, 'outside.js', CWD_BODY);
    const settingsPath = await writeSettings('node ../outside.js');
    const projectLink = await linkTo(projectDir, 'project-link');

    const content = await parseHookContent(settingsPath, { projectRoot: projectLink });

    expect(content).toBe('// Command: node ../outside.js');
  });
});

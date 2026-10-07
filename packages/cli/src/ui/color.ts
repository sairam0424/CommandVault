import chalk from 'chalk';

/**
 * chalk 5 honours FORCE_COLOR and --no-color but never looks at NO_COLOR (https://no-color.org).
 * This module is imported before anything prints, so a set, non-empty NO_COLOR switches colour
 * off unless FORCE_COLOR asks for it explicitly.
 */

interface ColorEnv {
  readonly NO_COLOR?: string;
  readonly FORCE_COLOR?: string;
}

/** True when the environment asks for plain output and nothing overrides it. */
export function isColorDisabled(env: ColorEnv): boolean {
  const noColor = env.NO_COLOR;
  return noColor !== undefined && noColor !== '' && env.FORCE_COLOR === undefined;
}

if (isColorDisabled(process.env)) {
  chalk.level = 0;
}

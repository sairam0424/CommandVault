import { createRequire } from 'node:module';

/**
 * The version in core's own package.json, for the two places that name the writer of something:
 * the database file (`written_by`) and the User-Agent of a remote fetch. Informational only: a
 * bundler that emits CommonJS (the VS Code extension) has no `import.meta.url`, and a copy outside
 * a package layout has no manifest. Both give `undefined`, and the caller leaves the version out.
 */
export function corePackageVersion(): string | undefined {
  const moduleUrl: unknown = import.meta.url;
  if (typeof moduleUrl !== 'string') return undefined;
  try {
    const manifest = createRequire(moduleUrl)('../package.json') as { version?: unknown };
    return typeof manifest.version === 'string' ? manifest.version : undefined;
  } catch {
    return undefined;
  }
}

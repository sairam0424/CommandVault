#!/usr/bin/env node
// Copies better-sqlite3 (native addon) into dist/node_modules so the
// VSIX has access to it at runtime. esbuild marks it as external
// because native .node files can't be bundled.

import { cpSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const sqlitePath = dirname(require.resolve('better-sqlite3/package.json'));
const dest = join(__dirname, '..', 'dist', 'node_modules', 'better-sqlite3');

mkdirSync(dest, { recursive: true });
cpSync(sqlitePath, dest, { recursive: true });

console.log(`Copied better-sqlite3 → dist/node_modules/better-sqlite3`);

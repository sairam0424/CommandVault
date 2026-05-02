# Repository Guidelines

## Project Structure & Module Organization

pnpm monorepo with Turborepo orchestration. Three packages with a strict build order: `core` builds first, then `vscode` and `cli` build in parallel (both depend on core).

```
packages/
  core/    @commandvault/core   — Parsers (7 types), three-tier search (Fuse/MiniSearch/SQLite), file watcher, SQLite via sql.js
  cli/     @commandvault/cli    — 18 Commander.js commands, bin: "vault"
  vscode/  commandvault-ai  — VS Code extension (TreeViews + React webview dashboard), esbuild-bundled
```

**Core** is ESM (`"type": "module"`). **CLI** is ESM. **VS Code extension** is CommonJS (esbuild bundles to CJS). Core uses `sql.js` (ASM.js build, not WASM) for cross-IDE compatibility — no native modules.

## Build, Test, and Development Commands

```bash
pnpm install                    # Install all workspace deps
pnpm build                      # Build all packages (turbo)
pnpm test                       # Run all tests (turbo)
pnpm typecheck                  # Type-check all packages
pnpm format                     # Format with Prettier
pnpm format:check               # Check formatting without writing

# Single package
pnpm --filter @commandvault/core test          # Core tests only
pnpm --filter @commandvault/core test -- -t "tag"  # Run single test by name
pnpm --filter @commandvault/cli build          # CLI only
pnpm --filter commandvault-ai build        # VS Code extension

# VS Code extension packaging
cd packages/vscode && npx @vscode/vsce package --no-dependencies

# CLI local dev
pnpm --filter @commandvault/cli link --global  # Makes "vault" available globally
```

## Coding Style & Naming Conventions

**Prettier** (enforced): single quotes, trailing commas, 100 char print width, semicolons.  
**TypeScript**: strict mode, target ES2022, `bundler` module resolution.  
**EditorConfig**: 2-space indent, LF line endings, UTF-8.

Immutable objects — never mutate in-place. Prefer many small files (200-400 lines, 800 max). `camelCase` for variables/functions, `PascalCase` for types/components, `UPPER_SNAKE_CASE` for constants.

## Testing Guidelines

**Framework**: Vitest. Workspace covers `packages/core` and `packages/cli`.

Tests live alongside source in `src/__tests__/`. Core has integration, parser, search, tag, LRU cache, and path-router tests. CLI has helper tests. Run a single test file:

```bash
pnpm --filter @commandvault/core test -- src/__tests__/search.test.ts
```

## Commit & Pull Request Guidelines

Conventional commits: `<type>(<scope>): <description>`. Types: `feat`, `fix`, `refactor`, `perf`, `chore`, `docs`, `test`, `ci`, `build`. Scope is the package (`core`, `cli`, `vscode`) or area.

Branches from `develop`: `feat/<name>` or `fix/<name>`. PRs target `develop`, not `main`. Do not include `Co-Authored-By` lines.

## CI

GitHub Actions on push to `develop`/`main` and PRs. Matrix: Node 20 + 22. Steps: install → build → test core → typecheck → package VSIX. pnpm version is read from `packageManager` field in root `package.json` (do not set `version` in the workflow).

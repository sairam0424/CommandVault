# Repository Guidelines

## Project Structure & Module Organization

pnpm monorepo with Turborepo orchestration. Three packages with a strict build order: `core` builds first, then `vscode` and `cli` build in parallel (both depend on core).

```
packages/
  core/    @commandvault/core   — 8 parsers, three-tier search (Fuse/MiniSearch/SQLite FTS5), file watcher, database adapter pattern
  cli/     @commandvault/cli    — 21 Commander.js commands + interactive TUI (Ink/React), bin: "vault"
  vscode/  commandvault-ai      — VS Code extension (TreeViews + React webview dashboard), esbuild-bundled
```

**Core** is ESM (`"type": "module"`). **CLI** is ESM. **VS Code extension** is CommonJS (esbuild bundles to CJS).

**Database adapter pattern**: `database-factory.ts` selects between `better-sqlite3` (Node.js/CLI — native performance) and `sql.js` (VS Code — no native modules needed). Both implement the same adapter interface in `database-adapter.ts`.

**File watcher uses path-routing**: Chokidar watches source directories; `path-router.ts` pattern-matches each changed file to its specific parser (skill, agent, command, plugin, rule, hook, multi-agent, single-file) — avoids full rescans.

## Build, Test, and Development Commands

```bash
pnpm install                    # Install all workspace deps
pnpm build                      # Build all packages (turbo)
pnpm test                       # Run all tests (turbo)
pnpm typecheck                  # Type-check all packages
pnpm format                     # Format with Prettier
pnpm format:check               # Check formatting without writing

# Single package
pnpm --filter @commandvault/core test
pnpm --filter @commandvault/core test -- src/__tests__/search.test.ts  # Single test file
pnpm --filter @commandvault/core test -- -t "tag"                      # By test name
pnpm --filter @commandvault/cli build
pnpm --filter commandvault-ai build

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

**Framework**: Vitest. Workspace covers all three packages (`packages/core`, `packages/cli`, `packages/vscode`).

Tests live alongside source in `src/__tests__/`. Run a single test file:

```bash
pnpm --filter @commandvault/core test -- src/__tests__/search.test.ts
```

## Commit & Pull Request Guidelines

Conventional commits enforced by **commitlint**: `<type>(<scope>): <description>`.

- **Types**: `feat`, `fix`, `refactor`, `perf`, `chore`, `docs`, `test`, `ci`, `build`, `revert`
- **Scopes** (required): `core`, `cli`, `vscode`, `deps`, `ci`

Branches from `develop`: `feat/<name>` or `fix/<name>`. PRs target `develop`, not `main`. Do not include `Co-Authored-By` lines.

**PR template** requires: Summary, Changes list, type checkbox, and a checklist — `pnpm typecheck`, `pnpm test`, `pnpm format:check` must pass. CHANGELOG update required for user-facing changes.

## CI

GitHub Actions on push to `develop`/`main` and PRs. Matrix: Node 20 + 22. Pipeline: install → build → test → typecheck → package VSIX. Additional workflows: CodeQL analysis, commitlint, coverage reports, bundle-size checks, PR size labels, and release-please automation.

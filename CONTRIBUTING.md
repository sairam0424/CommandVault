# Contributing to CommandVault

Thanks for your interest in contributing! This guide covers everything you need to get started.

## Prerequisites

- **Node.js** >= 20
- **pnpm** >= 9
- **Git** with conventional commit knowledge

## Setup

```bash
git clone https://github.com/sairam0424/CommandVault.git
cd CommandVault
pnpm install
pnpm build
pnpm test
```

## Development Workflow

1. **Create a branch** from `develop`:
   ```bash
   git checkout develop
   git checkout -b feat/your-feature
   ```

2. **Make changes** in the relevant package(s):
   - `packages/core/` — parsers, search, indexer, types
   - `packages/cli/` — terminal commands
   - `packages/vscode/` — VS Code extension

3. **Build and test**:
   ```bash
   pnpm build
   pnpm test
   pnpm typecheck
   ```

4. **Commit** using conventional commits:
   ```
   feat(core): add new parser for X format
   fix(cli): handle empty search results gracefully
   perf(core): cache filtered Fuse.js instances
   ```

5. **Push and create a PR** targeting `develop` (not `main`).

## Commit Convention

Format: `<type>(<scope>): <description>`

| Type | When |
|------|------|
| `feat` | New feature |
| `fix` | Bug fix |
| `perf` | Performance improvement |
| `refactor` | Code restructuring (no behavior change) |
| `test` | Adding or updating tests |
| `docs` | Documentation only |
| `chore` | Tooling, CI, dependencies |

Scopes: `core`, `cli`, `vscode`, or omit for cross-cutting changes.

## Project Structure

```
packages/
├── core/     Engine: parsers, search, SQLite, watcher
├── cli/      Terminal: Commander.js commands
└── vscode/   Extension: TreeViews, webviews, commands
```

Build order matters: `core` must build before `cli` and `vscode`.

## Adding a New CLI Command

1. Create `packages/cli/src/commands/your-command.ts`
2. Export a `createYourCommand(): Command` factory function
3. Register it in `packages/cli/src/index.ts`
4. Support `--json` output via `globalOpts.json`

## Adding a New Parser

1. Create `packages/core/src/parsers/your-parser.ts`
2. Return `ParserResult` (entries + errors)
3. Register in `packages/core/src/parsers/index.ts`
4. Call it from `Vault.scan()` in `vault.ts`
5. Add watch glob to `packages/core/src/watcher/index.ts`
6. Add route to `packages/core/src/watcher/path-router.ts`
7. Add tests in `packages/core/src/__tests__/`

## Code Style

- **Immutable objects** — never mutate in-place
- **No comments** unless the "why" is non-obvious
- **KISS** — simplest solution that works
- **Functions < 50 lines**, nesting < 4 levels
- **Prettier** handles formatting (`pnpm format`)

## Testing

- Tests live next to source in `__tests__/` directories
- Use `vitest` with `describe`/`it`/`expect`
- Integration tests run against real `~/.claude/` (skipped if absent)
- Target: > 80% coverage

## Pull Request Guidelines

- Title: short (< 70 chars), describes the change
- Body: summary bullets + test plan
- Target `develop`, never `main` directly
- All tests must pass before merge

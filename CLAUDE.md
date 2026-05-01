# CommandVault

Universal AI command manager — browse, search, and organize slash commands, skills, agents, plugins, rules, and hooks across all AI coding assistants.

## Architecture

pnpm monorepo with Turborepo orchestration. Three packages:

```
packages/
├── core/    — @commandvault/core (parsers, three-tier search, watcher, SQLite)
├── vscode/  — commandvault-vscode (VS Code extension with React webview)
└── cli/     — @commandvault/cli (18 terminal commands)
```

Build order: `core` → `vscode` + `cli` (parallel)

## Quick Commands

```bash
pnpm install              # Install all deps
pnpm build                # Build all (via turbo)
pnpm test                 # Run all tests (91 tests)
pnpm typecheck            # Type-check all packages
pnpm format               # Format with Prettier
pnpm --filter @commandvault/cli link --global  # Global vault command
vault                     # Interactive fuzzy search (default)
vault list --json         # Machine-readable output
vault doctor              # Health check
```

## Core Concepts

- **VaultEntry**: Unified type for all 6 entry types (skill, agent, command, plugin, rule, hook)
- **Three-Tier Search**: Fuse.js (fuzzy) → MiniSearch (indexed) → SQLite FTS5 (persistent)
- **LRU Cache**: 100-entry, 30s TTL cache on search results
- **Lazy Engines**: Fuse/MiniSearch only initialized when first queried
- **Path Router**: Maps file changes to specific parsers (avoids full rescan)
- **Debounce**: 500ms batching on watcher events
- **Stable IDs**: Based on type+name+source (file renames preserve favorites/usage)
- **Schema Migrations**: Versioned, auto-applied on DB open

## Key Files

- `packages/core/src/vault.ts` — Main Vault class (scan, search, events)
- `packages/core/src/indexer/search-engine.ts` — Orchestrates 3 search tiers + LRU cache
- `packages/core/src/indexer/sqlite-engine.ts` — SQLite FTS5, tags junction table, snapshots
- `packages/core/src/watcher/path-router.ts` — Routes file paths to parser types
- `packages/core/src/indexer/migrations.ts` — Schema migration system
- `packages/cli/src/index.ts` — Commander.js with 18 commands
- `packages/cli/src/config.ts` — Config file loader
- `packages/vscode/src/extension.ts` — Extension activation, status bar, events

## Conventions

- Immutable objects everywhere — never mutate in-place
- ESM modules in core + cli, CommonJS in vscode extension
- Feature branches: `feat/<name>` from `develop`
- Conventional commits: `feat|fix|refactor|perf|chore(scope): description`
- No Co-Authored-By lines in commits

## Git Strategy

- `main` — production releases only
- `develop` — integration branch (acts as main)
- `feat/*` — feature branches from develop
- PRs target `develop`, not `main`

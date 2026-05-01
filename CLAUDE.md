# CommandVault

Universal AI command manager — browse, search, and organize slash commands, skills, agents, plugins, rules, and hooks across all AI coding assistants.

## Architecture

pnpm monorepo with Turborepo orchestration. Three packages:

```
packages/
├── core/    — @commandvault/core (parsers, three-tier search, watcher)
├── vscode/  — commandvault-vscode (VS Code extension)
└── cli/     — @commandvault/cli (terminal companion)
```

Build order: `core` → `vscode` + `cli` (parallel)

## Quick Commands

```bash
pnpm install              # Install all deps
pnpm build                # Build all (via turbo)
pnpm --filter @commandvault/core build    # Build core only
pnpm --filter @commandvault/cli build     # Build CLI only
```

## Core Concepts

- **VaultEntry**: Unified type for all 6 entry types (skill, agent, command, plugin, rule, hook)
- **Three-Tier Search**: Fuse.js (fuzzy) → MiniSearch (indexed) → SQLite FTS5 (persistent)
- **Parsers**: One per format — reads YAML frontmatter, plugin.json, settings.json hooks
- **Watcher**: Chokidar FSWatcher on ~/.claude/ for live sync

## Conventions

- Immutable objects everywhere — never mutate in-place
- ESM modules in core + cli, CommonJS in vscode extension
- Feature branches: `feat/<name>` from `develop`
- Conventional commits: `feat|fix|refactor|chore(scope): description`

## Git Strategy

- `main` — production releases only
- `develop` — integration branch (acts as main)
- `feat/*` — feature branches from develop
- `test/*` — QA branches from develop
- `release/*` — cut from develop, merge to main + develop

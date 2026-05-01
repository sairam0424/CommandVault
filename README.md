# CommandVault

Universal AI command manager — browse, search, and organize slash commands, skills, agents, plugins, rules, and hooks across all AI coding assistants.

<p align="center">
  <img src="packages/vscode/media/vault-icon.svg" width="80" alt="CommandVault icon" />
</p>

## The Problem

AI coding assistants like Claude Code, Cursor, Copilot, Windsurf, and Aider each store commands, skills, and configurations in different formats across `~/.claude/`, `.cursorrules`, `.github/copilot-instructions.md`, and more. There is no unified way to browse, search, or manage these 350+ items.

## The Solution

CommandVault indexes everything into a single searchable vault with three interfaces:

| Interface | Package | What it does |
|-----------|---------|-------------|
| **VS Code Extension** | `commandvault-vscode` | Sidebar TreeView, search QuickPick, stats dashboard, keyboard shortcuts |
| **CLI** | `@commandvault/cli` | 18 terminal commands — list, search, open, run, backup, and more |
| **Core Engine** | `@commandvault/core` | Parsers, three-tier search, SQLite persistence, file watcher |

## Quick Start

```bash
# Prerequisites: Node.js >= 20, pnpm >= 9
git clone https://github.com/sairam0424/CommandVault.git
cd CommandVault
pnpm install
pnpm build

# Install the CLI globally
pnpm --filter @commandvault/cli link --global

# Launch interactive search
vault

# Or use specific commands
vault list                     # List all entries
vault search deploy            # Fuzzy search
vault list --json | jq         # Machine-readable output
vault stats                    # Dashboard
vault doctor                   # Health check
```

## What Gets Indexed

CommandVault scans `~/.claude/` and your project directory for:

| Type | Source | Format |
|------|--------|--------|
| **Skills** | `~/.claude/skills/*/SKILL.md` | YAML frontmatter + markdown |
| **Agents** | `~/.claude/agents/*.md` | YAML frontmatter + markdown |
| **Commands** | `~/.claude/commands/**/*.md` | Namespaced markdown |
| **Plugins** | `~/.claude/plugins/installed_plugins.json` | JSON registry + manifests |
| **Rules** | `~/.claude/rules/*.md` | YAML frontmatter + markdown |
| **Hooks** | `~/.claude/settings.json` | JSON hooks section |
| **Multi-agent** | `.cursorrules`, `.windsurfrules`, etc. | Per-tool config files |

## Three-Tier Search

CommandVault provides three search engines, selectable per query:

1. **Fuse.js** (`--tier fuse`) — Fuzzy matching with typo tolerance. Best for interactive search.
2. **MiniSearch** (`--tier minisearch`) — Indexed search with prefix matching and suggestions. Default.
3. **SQLite FTS5** (`--tier sqlite`) — Full-text search with boolean queries. Best for complex filters.

Results are ranked by a weighted score:
- Text relevance (55%) + Usage frequency (20%) + Recency (15%) + Favorite boost (10%)

## CLI Commands

```
vault                          Interactive fuzzy search (default)
vault list [--type] [--json]   List all entries
vault search <query>           Search with fuzzy matching
vault info <name>              Detailed entry info
vault stats                    Stats dashboard
vault open <name>              Open source file in $EDITOR
vault run <name>               Print slash command
vault favorite <name>          Toggle favorite
vault tag add <name> <tag>     Add a tag
vault diff                     Show changes since last snapshot
vault watch                    Live file change monitor
vault doctor                   System health check
vault export <file>            Export collection
vault import <file>            Import collection
vault sync <url>               Sync from remote URL
vault backup                   Backup database
vault restore <file>           Restore from backup
vault init                     Initialize config
```

All commands support `--json` for machine-readable output and `--tier` to override the search engine.

## VS Code Extension

The extension adds:

- **Sidebar** with three panels: Commands (grouped by type → source), Favorites, Recently Used
- **Search** via `Cmd+Shift+V` (Mac) / `Ctrl+Shift+V` (Windows/Linux)
- **Status bar** showing total entry count
- **Stats dashboard** with bar charts (React webview)
- **Context menu** actions: copy command, copy content, open file, insert to terminal
- **Sort/Filter** controls in the TreeView toolbar
- **Onboarding walkthrough** for first-time users

### Install from Source

```bash
cd packages/vscode
npx @vscode/vsce package --no-dependencies
# Install the generated .vsix file in VS Code
```

## Architecture

```
commandvault/
├── packages/
│   ├── core/                  @commandvault/core
│   │   ├── src/
│   │   │   ├── parsers/       7 parsers (skill, agent, command, plugin, rule, hook, multi-agent)
│   │   │   ├── indexer/       Search engines (Fuse, MiniSearch, SQLite), LRU cache, normalizer
│   │   │   ├── watcher/       Chokidar file watcher with path router and debounce
│   │   │   ├── sync/          Export/import/sync (VaultExportBundle format)
│   │   │   ├── types/         TypeScript type definitions
│   │   │   └── vault.ts       Main Vault class
│   │   └── src/__tests__/     91 tests (parsers, search, integration, tags, LRU cache, routing)
│   │
│   ├── cli/                   @commandvault/cli
│   │   ├── src/commands/      18 command modules
│   │   ├── src/config.ts      Config file loader
│   │   ├── src/helpers.ts     Shared utilities
│   │   └── src/__tests__/     11 CLI tests
│   │
│   └── vscode/                commandvault-vscode
│       ├── src/providers/     3 TreeView data providers
│       ├── src/commands/      Command registrations
│       ├── src/webview/       Detail panel + React stats dashboard
│       └── webview/src/       React components (StatsApp, BarChart)
│
├── CLAUDE.md                  AI assistant context
├── CHANGELOG.md               Version history
├── turbo.json                 Turborepo config
└── pnpm-workspace.yaml        Workspace definition
```

Build order: `core` → `cli` + `vscode` (parallel, via Turborepo)

## Development

```bash
pnpm install                   # Install all dependencies
pnpm build                     # Build all packages
pnpm test                      # Run all tests (91 tests)
pnpm typecheck                 # Type-check all packages
pnpm format                    # Format with Prettier
pnpm --filter @commandvault/core dev    # Watch mode for core
```

### Testing

```bash
pnpm test                                        # All tests
pnpm --filter @commandvault/core test             # Core only (80 tests)
pnpm --filter @commandvault/cli test              # CLI only (11 tests)
```

### Git Strategy

- `main` — production releases only
- `develop` — integration branch
- `feat/*` — feature branches from develop
- Conventional commits: `feat|fix|refactor|perf|chore(scope): description`

## Configuration

CommandVault stores its database and config at `~/.commandvault/`:

```
~/.commandvault/
├── vault.db          SQLite database (entries, favorites, usage, tags)
├── config.json       CLI configuration (created by `vault init`)
└── backups/          Database backups (created by `vault backup`)
```

### Config File

```json
{
  "claudeConfigPath": "~/.claude",
  "searchTier": "minisearch",
  "enableWatcher": true,
  "projectPaths": []
}
```

CLI flags (`--tier`, `--claude-path`) override config file values.

## Security

- FTS5 query tokens sanitized to prevent injection
- SSRF protection blocks private IPs and localhost in `vault sync`
- Plugin install paths validated against directory traversal
- HTML output escaped (XSS prevention in VS Code webviews)
- CSP headers on all webview panels
- No secrets stored — only indexes metadata

## License

MIT

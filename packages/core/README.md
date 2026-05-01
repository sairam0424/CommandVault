# @commandvault/core

Core engine for CommandVault — parsers, three-tier search, file watcher, and SQLite persistence.

## Installation

```bash
npm install @commandvault/core
```

## Usage

```typescript
import { createVault } from '@commandvault/core';

const vault = createVault({
  claudeConfigPath: '~/.claude',
  defaultSearchTier: 'minisearch',
  enableWatcher: true,
});

const stats = await vault.initialize();
console.log(`Indexed ${stats.totalEntries} entries`);

// Search
const results = vault.search({ query: 'deploy', limit: 10 });

// Quick fuzzy search
const quick = vault.quickSearch('review', 5);

// Filter by type
const skills = vault.getEntriesByType('skill');

// Favorites and usage
vault.toggleFavorite(entry.id);
vault.recordUsage(entry.id);

// Tags
vault.addTag(entry.id, 'important');

// Export/import
import { exportToFile, importFromFile } from '@commandvault/core';
await exportToFile(vault.getAllEntries(), 'backup.json', 'my-vault');

// Cleanup
await vault.dispose();
```

## Search Tiers

| Tier | Engine | Best for |
|------|--------|----------|
| `fuse` | Fuse.js | Interactive fuzzy search with typo tolerance |
| `minisearch` | MiniSearch | Indexed prefix search with suggestions (default) |
| `sqlite` | SQLite FTS5 | Complex boolean queries, persistent data |

## Parsers

The core ships 7 parsers that run in parallel:

- **Skill parser** — `~/.claude/skills/*/SKILL.md` (YAML frontmatter)
- **Agent parser** — `~/.claude/agents/*.md` (YAML frontmatter)
- **Command parser** — `~/.claude/commands/**/*.md` (namespaced)
- **Plugin parser** — `~/.claude/plugins/installed_plugins.json` (registry + manifest chain)
- **Rule parser** — `~/.claude/rules/*.md` (YAML frontmatter)
- **Hook parser** — `~/.claude/settings.json` (hooks section)
- **Multi-agent parser** — `.cursorrules`, `.windsurfrules`, etc. (project-level)

## License

MIT

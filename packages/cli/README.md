# @commandvault/cli

Terminal companion for CommandVault — list, search, open, and manage AI commands from your shell.

## Installation

```bash
# From the monorepo
pnpm --filter @commandvault/cli link --global

# Then use anywhere
vault
```

## Commands

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
vault tag remove <name> <tag>  Remove a tag
vault tag list <name>          List tags
vault diff                     Changes since last snapshot
vault watch                    Live file change monitor
vault doctor                   System health check
vault export <file>            Export collection
vault import <file>            Import collection
vault sync <url>               Sync from remote
vault backup                   Backup database
vault backup --list            List backups
vault restore <file>           Restore from backup
vault init                     Initialize config
```

## Global Options

```
--claude-path <path>    Override ~/.claude config location
--tier <tier>           Search engine (fuse|minisearch|sqlite)
--json                  Machine-readable JSON output
```

## Configuration

Run `vault init` to create `~/.commandvault/config.json`:

```json
{
  "claudeConfigPath": "~/.claude",
  "searchTier": "minisearch",
  "enableWatcher": true,
  "projectPaths": []
}
```

CLI flags override config file values.

## Examples

```bash
# List all skills as JSON
vault list --type skill --json

# Pipe search results to jq
vault search deploy --json | jq '.results[].entry.name'

# Open a skill in your editor
vault open browse

# Get the slash command for a skill
vault run review    # prints: /review

# Backup before making changes
vault backup
vault backup --list
```

## License

MIT

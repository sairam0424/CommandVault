# CommandVault for VS Code

Browse, search, and manage AI slash commands, skills, agents, plugins, rules, and hooks from your VS Code sidebar.

## Features

### Sidebar

Three panels in the CommandVault activity bar:

- **Commands** — All entries grouped by type (Skills, Agents, Commands, Plugins, Rules, Hooks) then by source
- **Favorites** — Starred entries for quick access
- **Recently Used** — Entries you've opened recently

### Search

Press `Cmd+Shift+V` (Mac) or `Ctrl+Shift+V` (Windows/Linux) to open the search palette. Search across all entries by name, description, or tags.

### Status Bar

The status bar shows total entry count. Click it to open search.

### Detail Panel

Click any entry to open a rich detail view showing type, source, description, tags, metadata, and full content.

### Stats Dashboard

Run "CommandVault: Show Stats Dashboard" to see bar charts of entries by type and source, plus your top 10 most-used commands.

### Sort and Filter

Use the toolbar buttons on the Commands panel to:
- **Sort** by name, usage count, or modification date
- **Filter** by text (matches name and description)

### Context Menu

Right-click any entry for:
- Toggle Favorite
- Copy Slash Command
- Copy Content
- Open Source File
- Insert into Terminal

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `commandvault.claudeConfigPath` | (auto) | Path to `.claude` config directory |
| `commandvault.enableFileWatcher` | `true` | Auto-refresh when command files change |
| `commandvault.searchTier` | `minisearch` | Search engine: `fuse`, `minisearch`, or `sqlite` |

## Install from Source

```bash
cd packages/vscode
npx @vscode/vsce package --no-dependencies
```

Then install the `.vsix` file via VS Code: Extensions > "..." menu > "Install from VSIX..."

## License

MIT

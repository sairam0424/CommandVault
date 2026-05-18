# Changelog

All notable changes to the CommandVault AI VS Code extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.7] - 2026-05-02

### Added

- Import collection command for loading shared command sets
- Search prefix syntax (`type:skill`, `tag:security`) for precise filtering
- Interactive stats dashboard with drill-down by type and source
- Copy buttons in the detail panel for quick content extraction
- Keyboard shortcut `Cmd+Shift+R` / `Ctrl+Shift+R` for refresh within sidebar
- Dynamic config reload (no window restart required for setting changes)
- 56 unit tests covering providers, commands, and detail panel

### Fixed

- File watcher now responds to `enableFileWatcher` config changes dynamically
- Filter toolbar correctly applies to source group counts in the entries tree
- Resolved 3 critical audit findings (FTS5 injection, path traversal, error leaks)

## [0.1.6] - 2026-05-02

### Added

- Upgraded marketplace icon with higher resolution and better contrast
- Redesigned sidebar activity bar icon with bolder strokes for visibility

### Fixed

- Sidebar icon barely visible in light themes — increased stroke weight and fill

## [0.1.5] - 2026-05-02

### Added

- "Most Used" tree view (renamed from "Recently Used" to reflect actual ranking)
- Empty state messages for Favorites and Most Used views with action links
- Filled star icon for favorited entries, hollow star for unfavorited

### Changed

- Rebranded publisher to `nothumanslabs` and extension ID to `commandvault-ai`

## [0.1.3] - 2026-05-02

### Fixed

- sql.js WebAssembly file (`sql-wasm.wasm`) now bundled correctly for VS Code's sandboxed environment
- Resolved `sql-asm.js` load failures in extension host

## [0.1.2] - 2026-05-02

### Changed

- Migrated database engine from `better-sqlite3` (native Node addon) to `sql.js` (pure WebAssembly) for cross-platform compatibility

### Fixed

- Extension failed to activate on platforms where native modules could not be compiled

## [0.1.1] - 2026-05-02

### Fixed

- Native `better-sqlite3` module now bundled inside the VSIX package
- Extension no longer fails with `MODULE_NOT_FOUND` on first activation

## [0.1.0] - 2026-05-01

### Added

- **Sidebar tree views**: Commands, Favorites, and Most Used panels in the activity bar
- **Three-tier search**: Fuzzy matching (Fuse.js), indexed search (MiniSearch), and persistent full-text search (SQLite FTS5)
- **Detail webview panel**: Rich content display with syntax-highlighted excerpts and metadata
- **Stats dashboard**: React-based webview with themed bar charts showing entries by type and source
- **Sort and filter toolbar**: Sort entries alphabetically, by usage count, or by recency; filter by entry type
- **Onboarding walkthrough**: 4-step guided tour (Browse, Search, Favorites, Dashboard)
- **Quick actions**:
  - Copy slash command to clipboard
  - Insert command into active terminal
  - Open source file in editor
  - Copy full entry content
  - Toggle favorite from inline icon or context menu
- **Keyboard shortcut** `Cmd+Shift+V` / `Ctrl+Shift+V` for global search
- **Status bar item** showing total entry count
- **File watcher** with 500ms debounce for live vault refresh on file changes
- **Export collection** command for sharing vault data as JSON
- **Configuration options**:
  - `commandvault.claudeConfigPath` — custom config directory path
  - `commandvault.enableFileWatcher` — toggle live refresh
  - `commandvault.searchTier` — choose search engine (fuse, minisearch, sqlite)

[0.1.7]: https://github.com/sairam0424/CommandVault/compare/v0.1.6...v0.1.7
[0.1.6]: https://github.com/sairam0424/CommandVault/compare/v0.1.5...v0.1.6
[0.1.5]: https://github.com/sairam0424/CommandVault/compare/v0.1.3...v0.1.5
[0.1.3]: https://github.com/sairam0424/CommandVault/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/sairam0424/CommandVault/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/sairam0424/CommandVault/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/sairam0424/CommandVault/releases/tag/v0.1.0

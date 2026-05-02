# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased] - v2 Upgrade

### Added
- Search pagination (offset), date range filters, bulk operations
- Entry lifecycle events (entry:added/updated/removed)
- vault config get/set, vault completions (bash/zsh/fish)
- VS Code: import command, search prefixes (type:skill, tag:security)
- VS Code: interactive stats dashboard with drill-down
- VS Code: detail panel copy buttons and clickable file paths
- VS Code: keyboard shortcuts (Cmd+Shift+R, Cmd+Shift+D)
- VS Code: empty state messages for Favorites and Most Used
- VS Code: filled/hollow star icons for favorite state
- Incremental single-file parsing for faster watcher response
- Error retry for transient FS errors (EBUSY, EMFILE)
- Shell completion scripts (bash/zsh/fish)

### Fixed
- import and sync commands now persist data (was silently lost)
- getSlashCommand double-namespace bug for namespaced commands
- Scan race conditions (added concurrency mutex)
- N+1 tag queries in search (100 queries to 3)
- Fuse filter cache unbounded growth (capped at 20)
- "Recently Used" renamed to "Most Used" (matches actual behavior)
- Spinners suppressed in JSON output mode
- Dynamic config reload (no window restart required)

### Changed
- SqliteEngine split into 5 focused modules (facade preserved)
- Shared parser base reduces markdown parser boilerplate
- withVault() wrapper for CLI commands

## [Unreleased] — Phases 4-8

### Added
- **Path router** for targeted re-parsing — only the affected parser runs on file changes
- **Watcher debounce** (500ms) batches rapid file saves into single parse per type
- **LRU search cache** (100 entries, 30s TTL) — identical queries return in <1ms
- **Lazy engine loading** — Fuse.js and MiniSearch only created when first queried
- **Schema migration system** with version tracking for automatic DB upgrades
- **`entry_tags` junction table** for exact tag matching (fixes substring bug)
- **Stable entry IDs** based on type+name+source (file renames preserve favorites/usage)
- **CLI config file** (`~/.commandvault/config.json`) now read by all commands
- **`vault open <name>`** — open entry source file in $EDITOR
- **`vault run <name>`** — print slash command to stdout
- **`vault backup`** / **`vault restore`** — database backup with auto-prune
- **`--json` flag** for machine-readable output on list, search, info, stats
- **VS Code keyboard shortcut** `Cmd+Shift+V` for search
- **VS Code status bar** showing entry count
- **VS Code "Copy Content"** context menu action
- **VS Code TreeView sort** (alphabetical, usage, recent) and filter
- **VS Code onboarding walkthrough** (4 steps)
- **README.md** with full documentation
- **LICENSE** (MIT), **CONTRIBUTING.md**, **.editorconfig**, **.nvmrc**
- 30 new tests (91 total: 80 core + 11 CLI)

### Fixed
- Tag search `LIKE '%qa%'` matched "squad" — now uses exact `EXISTS` query
- Snapshot hash based on `lastModified` missed content-only changes — now hashes content
- SQLite content truncation at 2000 chars — removed, full content stored
- VS Code export used custom JSON format — now uses core's `VaultExportBundle`

### Changed
- MiniSearch uses incremental `discard`/`add` instead of full rebuild on each index
- Fuse.js caches filtered instances by filter signature
- Entry IDs migrated from filePath-based to type+name+source-based (migration v2)

## [0.3.0] — 2026-05-01 — Phase 3

### Added
- CI pipeline with GitHub Actions (Node 20/22 matrix, VSIX packaging)
- Release workflow with npm publish and GitHub Releases
- Prettier config for consistent formatting
- Vitest workspace for root-level test orchestration
- VS Code `.vscodeignore` for lean extension packaging

### Changed
- Plugin parser reliability improvements
- Interactive CLI mode enhancements
- React-based stats dashboard in VS Code extension

## [0.2.0] — 2026-04-15 — Phase 2

### Added
- Unified score normalization with configurable weights across all search tiers
- Multi-agent config detection for Cursor, Copilot, Windsurf, Aider, Continue.dev
- Export/import/sync system for sharing command collections
- CLI `init`, `doctor`, `import`, and `sync` commands
- 57 tests covering parsers, search engines, and integration scenarios

## [0.1.0] — 2026-03-30 — Phase 1

### Added
- Monorepo scaffold with pnpm workspaces and Turborepo
- 6 parsers: Claude skills, Claude plugins, Copilot instructions, Cursor rules, Windsurf rules, Aider conventions
- Three-tier search engine (Fuse.js fuzzy, MiniSearch indexed, SQLite persistent)
- VS Code extension with TreeView sidebar, webview detail panels, and 9 commands
- CLI terminal companion with 6 subcommands (list, search, inspect, stats, export, config)
- File watcher for live vault refresh

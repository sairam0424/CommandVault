# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased] — Phase 3

### Added
- CI pipeline with GitHub Actions (Node 20/22 matrix, VSIX packaging)
- Release workflow with npm publish and GitHub Releases
- Prettier config for consistent formatting
- Vitest workspace for root-level test orchestration
- VS Code `.vscodeignore` for lean extension packaging
- This changelog

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

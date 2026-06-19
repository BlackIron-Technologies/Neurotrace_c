# Change Log

All notable changes to the "neurotrace" extension will be documented in this file.

## [1.2.5] - 2026-04-09

### Added
- Added a dedicated `Unlock for Codex` action in the sidebar lock screen that launches the Codex WSL unlock flow in the integrated terminal

### Changed
- Updated locked-database guidance so the sidebar recommends the correct unlock path for normal IDE usage versus Codex daemon usage

## [1.2.4] - 2026-04-05

### Changed
- Added automatic Codex WSL support so NeuroTrace can configure the Codex MCP flow in WSL environments without a manual setup path

## [1.2.0] - 2026-03-22

### Added
- Released `Instruction Sync` with one canonical instruction source that can sync into `AGENTS.md`, `CLAUDE.md`, `.github/copilot-instructions.md`, and `.cursor/rules/neurotrace.mdc`
- Added onboarding and `What's New` guidance for the new Instruction Sync workflow

### Changed
- Updated the README to use a video-first product demo
- Refined injected NeuroTrace workflow guidance so agents prefer `getMemoriesByFile` for known files, `semanticSearch` for fuzzy discovery, and `searchThoughts` for exact-term refinement

### Fixed
- Fixed Instruction Sync configuration so selected targets persist globally across workspaces
- Fixed canonical instruction path handling so the selected canonical file remains stable across repo/context switches
- Fixed Instruction Sync target display to always show absolute path provenance across repositories

## [1.0.0] - 2026-03-14

### Changed
- Promoted NeuroTrace to `1.0.0`
- Added and stabilized external-agent support across multiple clients including Cursor, Codex, and Copilot
- Hardened backend re-download and incompatible-version update orchestration in the extension
- Improved Codex MCP auto-rebind, bridge behavior, and generated MCP guidance

## [0.91.0] - 2026-03-12

### Changed
- **Repositioned as "Context Memory for AI-Assisted Coding"**: NeuroTrace is now agent-first, designed as persistent memory for AI coding agents and developers
- New README with agent-native positioning, MCP tool documentation, and privacy-first messaging
- Updated walkthrough with agent workflow section, example prompts, and full MCP tool reference
- Marketplace metadata updated: new description, keywords (mcp, agent, context memory, copilot), and AI category

## [0.9.40] - 2025-11-18

### Changed
- Thought Graph, Semantic Search, Related Suggestions, and Code Decorations are included in the local-first extension experience
- Code decorations are now enabled by default

## [0.9.34] - 2025-10-24

- Recompiled binaries for macOS Silicon (Apple M1/M2/M3)
- Improved binary distribution packaging
- Improved UI download view

## [0.9.0-beta.0] - 2025-10-10

- Initial release

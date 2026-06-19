# What's New in NeuroTrace

## Instruction Sync

**Stop hand-maintaining instructions across `AGENTS.md`, `CLAUDE.md`, Copilot, and Cursor.**

If you work with multiple agents, the problem is familiar:

- `AGENTS.md` says one thing
- `CLAUDE.md` drifts
- Copilot instructions lag behind
- Cursor rules end up carrying stale workflow guidance

NeuroTrace now gives you **one canonical instruction source** and a controlled way to push it everywhere it matters.

<video src="./sync_screen_neurotrace_optimized.mp4" autoplay loop muted playsinline preload="auto" controls width="960"></video>


## Why This Matters

Without a source of truth, agent behavior becomes inconsistent across tools, repos, and sessions.

Instruction Sync fixes that by letting you:

- Define one canonical instruction file
- Sync it into `AGENTS.md`, `CLAUDE.md`, `.github/copilot-instructions.md`, and `.cursor/rules/neurotrace.mdc`
- Keep repo-specific agent surfaces aligned without copy-paste maintenance
- See exactly which targets are missing, outdated, or already in sync

This turns instruction management from a fragile manual chore into a repeatable workflow.

## How It Works

1. Open `NeuroTrace: Open Instruction Sync`
2. Choose your canonical instruction file
3. Add the target files you want NeuroTrace to manage
4. Review target status at a glance
5. Click `Sync Now`

NeuroTrace keeps the model simple on purpose:

- One-way sync
- One approved source of truth
- Explicit targets
- No guessing about which file won

## Best Fit

Instruction Sync is especially useful if you:

- switch between Codex, Claude, Copilot, and Cursor
- keep multiple agent-facing instruction files per repo
- want the same workflow policy applied across tools
- are tired of updating the same instructions in four places

## Suggested Next Step

Open the Instruction Sync panel, point it at the instruction set you trust most, and make NeuroTrace propagate it from there.

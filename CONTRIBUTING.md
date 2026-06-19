# Contributing to NeuroTrace

Thanks for helping make NeuroTrace better. This project is being prepared as a
local-first, MIT-licensed open source tool, so contributions should preserve
that shape: transparent behavior, no required external service, and no hidden
data collection.

## Before You Start

- Check existing issues and discussions before opening a duplicate.
- Keep changes focused. Small pull requests are easier to review and merge.
- For user-facing behavior, update the README or docs in the same change.
- For risky changes, describe the tradeoffs and any migration concerns.

## Development Setup

Install dependencies:

```powershell
npm install
```

Compile the extension:

```powershell
npm run compile
```

Run tests when available:

```powershell
npm test
```

Validate the Python CLI entrypoint after touching `bin/neurotrace.py`:

```powershell
python -m py_compile bin\neurotrace.py
```

Run the full local release check:

```powershell
npm test
```

Refresh the pinned ONNX model artifacts when model provenance changes:

```powershell
.\compilation\fetch-onnx-model.ps1
```

Release packaging details live in [docs/RELEASE.md](docs/RELEASE.md).

## Contribution Guidelines

- Keep the project local-first. Features should work without an account or
  required external service.
- Do not add hidden data collection, commercial access gates, or remote identity
  flows.
- Avoid committing generated artifacts, local databases, packaged releases, or
  machine-specific editor files.
- Prefer clear interfaces and tests over broad rewrites.
- Document new configuration, commands, and workflows.
- Keep security-sensitive behavior explicit and reviewable.

## Pull Requests

Pull requests should include:

- A short summary of the change.
- The reason the change is needed.
- Verification steps, including commands run.
- Screenshots or recordings for UI changes when useful.
- Notes about breaking changes or compatibility concerns.

Maintainers may ask for changes to preserve project scope, local-first behavior,
security posture, or maintainability.

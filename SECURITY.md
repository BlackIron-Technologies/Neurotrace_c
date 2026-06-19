# Security Policy

NeuroTrace is a local-first developer tool. Security reports are welcome and
will be handled with care.

## Supported Versions

Security fixes target the default branch and the latest published release.
Older releases may receive fixes when the issue is severe and a backport is
practical.

## Reporting a Vulnerability

Use GitHub's private vulnerability reporting for this repository if it is
enabled. If private reporting is not enabled, open a public issue with a short
request for a private maintainer contact method, but do not include exploit
details, secrets, or proof-of-concept code in the public issue.

Helpful reports include:

- Affected version or commit.
- Operating system and VS Code version.
- Clear reproduction steps.
- The expected and actual behavior.
- Impact assessment.
- Any logs or traces with secrets removed.

## Scope

In scope:

- VS Code extension code.
- Local backend, daemon, MCP bridge, and CLI entrypoints.
- Packaging and release scripts.
- Handling of local workspace data and secrets.

Out of scope:

- Vulnerabilities caused only by unsupported local modifications.
- Reports without enough detail to reproduce or assess.
- Social engineering or physical attacks.

## Security Expectations

- Do not commit secrets, tokens, local databases, or packaged artifacts.
- Keep local services bound to loopback unless there is a documented reason.
- Avoid adding network calls unless they are required, visible, and documented.
- Treat workspace data as private by default.


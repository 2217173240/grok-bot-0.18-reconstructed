# Security notes

This is a small-club reconstruction, not a supported production distribution.
Do not reuse real credentials or sensitive accounts while experimenting with it.

Reconstructed packages default the official updater, Sentry, and upstream
telemetry off at the Electron-main packaging boundary. The bootstrap download
and hydrated `app.asar` are checksum-pinned.

Dependency maintenance applies to the root manifest and lockfile. The upstream
`src/app/package.json`, original resources, Electron shell inputs, and container
base images remain preserved reconstruction inputs.

OpenTelemetry packages use the compatible 2.8.0 / OTLP 0.219.0 release family,
including nested exporter dependencies. Tiptap core and its exact ProseMirror
peer use 3.31.4. Direct math rendering uses KaTeX 0.18.2; Mermaid 11.16.1 still
resolves a separate KaTeX 0.16 dependency. A patched direct dependency does not
prove that all nested copies are patched.

The following upgrades need separate compatibility work. Their advisories remain
open; passing repository and packaging checks does not mean an empty security
report.

| Component | Required work |
| --- | --- |
| Electron 42.1.0 | Update the archived shell, checksums, build stamps, and native-module acceptance together. |
| Undici 5 / Connect 1 | Update the packaged CJS dependency closure, proxy fetch behavior, and Connect/protobuf interfaces together. |
| AI SDK 4 / OpenAI provider 1 | Migrate provider types, streaming tool calls, usage accounting, and cancellation together. |
| Mermaid's nested KaTeX | Adopt a compatible upstream dependency update and verify diagram rendering. |
| Other audit findings | Review each affected call path and available fix; `xlsx` currently has no npm audit fix. |

Use `npm audit --json` against the current lockfile for a fresh advisory list.
Dependency-graph alerts for the preserved upstream manifest are tracked
separately from root runtime dependencies; do not modify original resources to
make the alert count disappear.

## Reporting a vulnerability

Use [GitHub private vulnerability reporting](https://github.com/2217173240/grok-bot-0.18-reconstructed/security/advisories/new)
to contact the repository owner. Include the affected commit or package version,
reproduction steps, expected impact, and a minimal example with test credentials.
Keep real tokens, private keys, personal data, and browser sessions out of reports.
Discuss disclosure and any proposed fix in the private advisory before publishing
details in an issue or pull request.

Security reports are evaluated against the current `main` branch and its matching
reconstructed packages. Older experimental snapshots have no separate maintenance
commitment.

## Automated checks

GitHub Dependabot alerts and security updates monitor dependency advisories.
Security updates are grouped for npm. Automatic PRs exclude the fixed Electron
input and major upgrades of AI SDK, the OpenAI provider, Connect-node, and
Undici; these require the compatibility work above. This policy does not dismiss
their vulnerability alerts. The preserved upstream manifest has no scheduled
update job. GitHub Actions version updates are proposed monthly. All changes
require the existing runtime and packaging checks before merging.

CodeQL is configured with the extended query suite and the remote-and-local
threat model. Review completed analyses and findings in the repository's
Security tab.
Secret scanning and push protection supplement the CI Git-history scan and the
publication checks for credential and browser-session paths. A passing scan
describes the checks performed; runtime credentials remain outside the repository
and published artifacts.

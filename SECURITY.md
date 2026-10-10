# Security notes

This is a small-club reconstruction, not a supported production distribution.
Do not reuse real credentials or sensitive accounts while experimenting with it.

Reconstructed packages default the official updater, Sentry, and upstream
telemetry off at the Electron-main packaging boundary. The bootstrap download
and hydrated `app.asar` are checksum-pinned.

`npm audit` still reports compatibility-bound advisories in the pinned Electron
42.1 runtime, Undici 5 / Connect 1 stack, AI SDK 4, and OpenTelemetry stack.
Patch-level fixes are applied where they do not change reconstructed runtime
contracts. The remaining major upgrades are intentionally tracked as follow-up
work rather than silently changing application behavior during publication
cleanup.

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
Security updates are grouped for npm; compatibility-sensitive upgrades require
review and the existing runtime and packaging checks before merging. GitHub
Actions version updates are proposed monthly.

CodeQL uses the extended query suite to analyze supported repository languages.
Secret scanning and push protection supplement the CI Git-history scan and the
publication checks for credential and browser-session paths. A passing scan
describes the checks performed; runtime credentials remain outside the repository
and published artifacts.

# Security Policy

## Supported versions

Only the latest `main` branch build is supported during the MVP phase.

## Reporting a vulnerability

Please open a private security advisory on GitHub instead of a public issue if the repository supports advisories. Do not include real API keys, cookies, session tokens or personal page data in a report.

## Security model

- The model is never trusted to execute code.
- Every page action is allow-listed, schema-validated and bound to one explicit user approval.
- The extension reads only the active tab after a user action and filters sensitive fields.
- The DeepSeek API key stays in the extension service worker context.

See `docs/security-audit.md` for the full threat model and audit scope.

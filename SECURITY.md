# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in brainjar, please report it responsibly.

**Do not open a public issue.**

Instead, email **security@brainjar.dev** with:

- A description of the vulnerability
- Steps to reproduce
- Impact assessment (if known)

You should receive a response within 48 hours. We will work with you to understand the issue and coordinate a fix before any public disclosure.

## Scope

brainjar manages agent configuration files and optionally integrates with credential engines (e.g., Bitwarden). Security issues we care about include:

- Path traversal or file access outside intended directories
- Credential leakage (session tokens, API keys)
- Injection via layer content (markdown files synced to agent configs)
- State file tampering that could escalate privileges

## Supported Versions

| Version | Supported |
|---|---|
| Latest release | Yes |
| Older releases | No |

We only patch the latest release. Update to the latest version to receive fixes.

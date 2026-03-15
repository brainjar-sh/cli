# Security

This rule enforces secure coding practices.

## Secrets

- Never commit credentials, API keys, tokens, or .env files.
- If you encounter hardcoded secrets in the codebase, flag them immediately.
- Use environment variables or secret managers for sensitive values.

## Input Boundaries

- Validate and sanitize all external input — user input, API responses, file reads.
- Don't trust data from outside the system boundary.
- Use parameterized queries. Never interpolate user input into SQL or shell commands.

## Common Vulnerabilities

- Watch for injection: SQL, command, XSS, template injection.
- Don't disable security features (CORS, CSRF, auth checks) to "make it work."
- Prefer allowlists over denylists for validation.

## Dependencies

- Flag known-vulnerable dependencies if you notice them.
- Don't add dependencies without confirming with the user first.

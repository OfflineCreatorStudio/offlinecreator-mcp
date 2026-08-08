# Security policy

## Supported version

Security fixes target the latest `0.1.x` release.

## Report a vulnerability

Do not open a public issue. Email `security@offlinecreatorstudio.com` with reproduction steps, affected version, and impact. Avoid including real API keys, prompts, or generated media. We will acknowledge receipt and coordinate disclosure.

## Credential handling

- Remote MCP uses OAuth discovery at `https://mcp.offlinecreatorstudio.com/mcp`; no API key belongs in remote configuration.
- Local stdio requires `OFFLINECREATOR_API_KEY`. Keep it in the client secret store or process environment, never in source control, URLs, logs, or issue reports.
- Revoke a suspected key from [Studio Settings](https://offlinecreatorstudio.com/settings).

See [security controls](docs/security.md) and the [threat model](docs/threat-model.md).

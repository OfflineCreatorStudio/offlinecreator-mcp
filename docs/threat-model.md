# Threat model

## Assets

Personal API keys, OAuth grants, account credits, prompts, source images, generated outputs, and local files within the configured upload root.

## Trust boundaries

1. MCP client to remote OAuth resource or local stdio process.
2. Local stdio process to the hosted Studio API.
3. Local filesystem to `upload_input`.
4. Hosted service to its proprietary generation backend.

## Primary threats and mitigations

- **Credential disclosure:** remote OAuth avoids static keys; stdio keys stay in secret environment configuration and are not echoed.
- **SSRF or origin substitution:** trusted-origin validation, HTTPS enforcement, path allowlisting, and manual redirect handling.
- **Local file exfiltration:** upload-root containment, extension checks, size limits, and content sniffing.
- **Untrusted output URLs:** cross-origin URLs are omitted.
- **Unexpected cost or mutation:** generation tools are not marked read-only; cancellation is marked destructive; users should review requested scopes and model costs.
- **Malicious media payloads:** only recognized image signatures pass the client boundary; hosted validation remains authoritative.

## Out of scope

The proprietary hosted backend, OAuth service, identity provider, billing, model providers, and their infrastructure are not distributed here. Their internal controls are not claims made by this public source release.

## Residual risk

A compromised MCP client or local machine can read configured secrets and permitted files. OAuth and API authorization do not protect a fully compromised endpoint. Use least-privilege scopes, a narrow upload root, prompt software updates, and credential revocation.

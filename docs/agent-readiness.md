# Agent Readiness

This package exports `@offlinecreator/mcp/agent-readiness`, a fetch handler that
publishes the discovery, auth, commerce, and WebMCP documents expected by
[isitagentready.com](https://isitagentready.com).

The hosted OAuth/MCP Worker and the Studio website remain proprietary. Mount
this handler in front of those origins so agents can find the existing `/mcp`
resource, OAuth Authorization Code + PKCE flow, and credit checkout.

## What the handler serves

- OAuth Authorization Server and OpenID Provider metadata, including `jwks_uri`
- OAuth Protected Resource Metadata with `resource` matching the request origin
- `/auth.md` plus an `agent_auth` block on AS metadata
- MCP Server Card, A2A Agent Card (with AP2 merchant extension), Agent Skills
- API catalog (`application/linkset+json`), OpenAPI + MPP `x-payment-info`
- ACP, UCP, and x402 payment discovery
- Web Bot Auth JWKS directory and optional request signing
- Homepage HTML that registers WebMCP tools, plus `Accept: text/markdown`
- `robots.txt` with `User-agent` and `Content-Signal` directives
- `Link` headers (`api-catalog`, `service-desc`, `service-doc`, `describedby`)

Unknown paths return `null` so the existing Worker can keep `/mcp`,
`/authorize`, `/oauth/token`, and `/oauth/register`.

## Configuration

```ts
await handleAgentReadinessRequest(request, {
  authorizationServer: "https://mcp.offlinecreatorstudio.com",
  studioOrigin: "https://offlinecreatorstudio.com",
  version: "0.1.2",
  x402PayTo: env.X402_PAY_TO,
  webBotAuthPrivateJwk: JSON.parse(env.WEB_BOT_AUTH_PRIVATE_JWK ?? "null"),
});
```

| Option                 | Purpose                                                                                                   |
| ---------------------- | --------------------------------------------------------------------------------------------------------- |
| `origin`               | Public origin. Defaults to the request origin.                                                            |
| `authorizationServer`  | OAuth issuer used in endpoint URLs. Defaults to the request origin.                                       |
| `studioOrigin`         | Human site for docs, settings, and sitemap links.                                                         |
| `version`              | Advertised MCP / Agent Card version. Defaults to the package version.                                     |
| `x402PayTo`            | Wallet that receives x402 payments. Defaults to the documentation burn address.                           |
| `webBotAuthPublicJwk`  | Public Ed25519 JWK for the Web Bot Auth directory.                                                        |
| `webBotAuthPrivateJwk` | Matching private JWK used to sign directory responses and outbound bot requests. Never commit this value. |

## DNS for AI Discovery (DNS-AID)

HTTP cannot publish DNS. Add the records in [dns-aid.zone](dns-aid.zone) at the
Cloudflare DNS dashboard for `offlinecreatorstudio.com`, then enable DNSSEC.

The scanner queries:

- `_index._agents.<domain>` SVCB/HTTPS/TXT
- `_a2a._agents.<domain>` SVCB/HTTPS
- `_mcp._agents.<domain>` SVCB/HTTPS

## Studio origin

If the Studio Next.js app cannot import this package, mirror the same paths as
static/route handlers, or proxy them to the MCP Worker. The homepage must:

1. Keep HTML as the default
2. Return `Content-Type: text/markdown` when `Accept: text/markdown`
3. Include the WebMCP script so `navigator.modelContext.registerTool()` runs
4. Send the `Link` headers listed above
5. Add `Content-Signal: ai-train=no, search=yes, ai-input=yes` to `robots.txt`

Protected Resource Metadata on the Studio origin must set `resource` to
`https://offlinecreatorstudio.com` (the scanned homepage). Keep a path-specific
document at `/.well-known/oauth-protected-resource/mcp` for the MCP resource.

## Signing outbound bot requests

```ts
import { signWebBotAuthHeaders } from "@offlinecreator/mcp/agent-readiness";

const headers = await signWebBotAuthHeaders({
  request,
  origin: "https://mcp.offlinecreatorstudio.com",
  privateJwk: JSON.parse(env.WEB_BOT_AUTH_PRIVATE_JWK),
});
```

The helper adds `Signature`, `Signature-Input`, and `Signature-Agent`.

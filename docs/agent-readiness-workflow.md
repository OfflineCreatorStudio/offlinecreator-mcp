# Agent Readiness workflow

Living tracker for making OfflineCreator Studio pass
[isitagentready.com](https://isitagentready.com) checks from the
[Cloudflare AEO / Agent Readiness](https://blog.cloudflare.com/agent-readiness/)
program.

Branch: `agent-readiness`

This public package cannot mutate production DNS or the proprietary Studio
Next.js app / OAuth Worker. It ships a reusable discovery handler the hosted
MCP Worker (and the Studio origin) can mount, plus operator notes for DNS.

## Baseline (2026-08-19)

Scanned with `POST https://isitagentready.com/api/scan`.

| Host                                   | Level                | Already passing                                               | Notable failures                                                                                                                                                                     |
| -------------------------------------- | -------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `https://offlinecreatorstudio.com`     | 1 Basic Web Presence | `robots.txt`, `sitemap.xml`, wildcard AI bot rules            | Link headers, DNS-AID, markdown, Content Signals, API catalog, OAuth discovery, PRM resource mismatch, auth.md, MCP card, A2A card, skills, WebMCP, commerce                         |
| `https://mcp.offlinecreatorstudio.com` | 0 Not Ready          | OAuth AS metadata (`/.well-known/oauth-authorization-server`) | robots.txt has Content Signal comments but no `User-agent` / `Content-Signal` directives; PRM `resource` is `/mcp` so origin scans fail; remaining discovery and commerce checks 404 |

Existing live facts reused by this work:

- MCP issuer `https://mcp.offlinecreatorstudio.com`
- Authorization Code + PKCE at `/authorize` and `/oauth/token`
- Dynamic client registration at `/oauth/register`
- Resource `https://mcp.offlinecreatorstudio.com/mcp`
- Scopes `models`, `read`, `generate`

## Implementation map

| Check                    | Scanner path                                      | Status                 | Where it lives                                                                 |
| ------------------------ | ------------------------------------------------- | ---------------------- | ------------------------------------------------------------------------------ |
| OAuth/OIDC discovery     | `checks.discovery.oauthDiscovery`                 | Implemented in handler | `/.well-known/oauth-authorization-server`, `/.well-known/openid-configuration` |
| OAuth Protected Resource | `checks.discovery.oauthProtectedResource`         | Implemented in handler | `/.well-known/oauth-protected-resource` with `resource` = request origin       |
| Auth.md                  | `checks.discovery.authMd`                         | Implemented in handler | `/auth.md` plus `agent_auth` on AS metadata                                    |
| A2A Agent Card + AP2     | `checks.discovery.a2aAgentCard`                   | Implemented in handler | `/.well-known/agent-card.json`                                                 |
| Agent Skills index       | `checks.discovery.agentSkills`                    | Implemented in handler | `/.well-known/agent-skills/index.json`                                         |
| MCP Server Card          | `checks.discovery.mcpServerCard`                  | Implemented in handler | `/.well-known/mcp/server-card.json`                                            |
| Web Bot Auth             | `checks.botAccessControl.webBotAuth`              | Implemented in handler | `/.well-known/http-message-signatures-directory` + request signer              |
| WebMCP                   | `checks.discovery.webMcp`                         | Implemented in handler | Homepage + `/webmcp.js` call `navigator.modelContext.registerTool()`           |
| DNS-AID                  | `checks.discoverability.dnsAid`                   | Operator action        | [dns-aid.zone](dns-aid.zone) — cannot publish DNS from this repo               |
| Link headers             | `checks.discoverability.linkHeaders`              | Implemented in handler | `Link` on `/`                                                                  |
| API Catalog              | `checks.discovery.apiCatalog`                     | Implemented in handler | `/.well-known/api-catalog`                                                     |
| Markdown negotiation     | `checks.contentAccessibility.markdownNegotiation` | Implemented in handler | `Accept: text/markdown` on `/`                                                 |
| Content Signals          | `checks.botAccessControl.contentSignals`          | Implemented in handler | `Content-Signal` in `/robots.txt`                                              |
| ACP                      | `checks.commerce.acp`                             | Implemented in handler | `/.well-known/acp.json`                                                        |
| MPP                      | `checks.commerce.mpp`                             | Implemented in handler | `/openapi.json` `x-payment-info`                                               |
| UCP                      | `checks.commerce.ucp`                             | Implemented in handler | `/.well-known/ucp`                                                             |
| x402                     | `checks.commerce.x402`                            | Implemented in handler | `402` on `/x402/credits`                                                       |

## Mounting on the hosted Worker

```ts
import { handleAgentReadinessRequest } from "@offlinecreator/mcp/agent-readiness";

export default {
  async fetch(request: Request, env: unknown, ctx: ExecutionContext) {
    const discovery = await handleAgentReadinessRequest(request);
    if (discovery) return discovery;
    return existingFetch(request, env, ctx);
  },
};
```

See [agent-readiness.md](agent-readiness.md) for options, DNS records, and the
Studio origin notes.

## Local verification

`npm run validate` passed on this branch, including the new
`src/agent-readiness.test.ts` coverage for every HTTP document the scanner
asks for.

```bash
npm test
node scripts/serve-agent-readiness.mjs
```

## Remaining production work

These cannot be completed from the public package repo:

1. Mount `handleAgentReadinessRequest` on the hosted MCP Worker so
   `https://mcp.offlinecreatorstudio.com` serves the new paths.
2. Mirror or proxy the same paths from `https://offlinecreatorstudio.com`,
   including homepage markdown, WebMCP, Link headers, and robots
   `Content-Signal`.
3. Publish the DNS-AID records in [dns-aid.zone](dns-aid.zone) and enable
   DNSSEC.
4. Store `WEB_BOT_AUTH_PRIVATE_JWK` and `X402_PAY_TO` as Worker secrets.
5. Re-scan:

```http
POST https://isitagentready.com/api/scan
Content-Type: application/json

{"url":"https://mcp.offlinecreatorstudio.com"}
```

Repeat for `https://offlinecreatorstudio.com`.

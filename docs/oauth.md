# OAuth and remote MCP

The canonical remote resource is `https://mcp.offlinecreatorstudio.com/mcp`. Clients discover OAuth metadata from the resource, use Authorization Code with PKCE, and obtain user-scoped access after browser consent.

No client ID, client secret, personal API key, static authorization header, or query parameter is required in the standard remote configuration. Do not copy `OFFLINECREATOR_API_KEY` into remote configuration; it is only for local stdio.

The hosted OAuth and application backend are proprietary services and are not part of this repository. The public package includes only the reusable HMAC request-signing bridge consumed through its `./oauth-bridge` export and focused cryptographic tests. It contains no OAuth Worker, deployment configuration, tenant identifiers, or service-secret values.

Disconnect the connector in the client and revoke access in [Studio Settings](https://offlinecreatorstudio.com/settings) when access is no longer needed.

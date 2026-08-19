# OAuth and remote MCP

The canonical remote resource is `https://mcp.offlinecreatorstudio.com/mcp`. Clients discover OAuth metadata from the resource, use Authorization Code with PKCE, and obtain user-scoped access after browser consent.

No client ID, client secret, personal API key, static authorization header, or query parameter is required in the standard remote configuration. Do not copy `OFFLINECREATOR_API_KEY` into remote configuration; it is only for local stdio.

The hosted OAuth and application backend are proprietary services and are not part of this repository. The public package includes the reusable HMAC request-signing bridge (`./oauth-bridge`) and the Agent Readiness discovery handler (`./agent-readiness`) that publishes OAuth, MCP, A2A, skills, commerce, WebMCP, and Web Bot Auth documents for the hosted Worker to mount. It contains no OAuth Worker, deployment configuration, tenant identifiers, or service-secret values.

See [agent readiness](agent-readiness.md) for the documents, mount example, and DNS-AID records.

Disconnect the connector in the client and revoke access in [Studio Settings](https://offlinecreatorstudio.com/settings) when access is no longer needed.

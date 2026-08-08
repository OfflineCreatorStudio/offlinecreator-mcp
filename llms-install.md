# Install OfflineCreator Studio MCP

Prefer remote MCP:

- Endpoint: `https://mcp.offlinecreatorstudio.com/mcp`
- Transport: Streamable HTTP
- Authentication: OAuth discovery and browser consent
- Do not request or place an API key in remote configuration.

Use stdio only when a local transport is needed:

- Command: `npx`
- Arguments: `-y`, `@offlinecreator/mcp`
- Secret environment variable: `OFFLINECREATOR_API_KEY`
- Node.js: 20+

After connecting, call `list_models` before `generate`. Treat output URLs as short-lived and never expose credentials in chat, logs, command history, or URLs. See [client examples](docs/clients.md).

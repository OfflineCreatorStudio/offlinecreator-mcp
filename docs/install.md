# Installation

## Remote OAuth (recommended)

Configure `https://mcp.offlinecreatorstudio.com/mcp` as a Streamable HTTP server. Compatible remote MCP clients manage OAuth authentication and credential storage. Remote configuration contains no API key.

Cursor supports remote MCP servers with OAuth. Install the Agent Plugin from its Marketplace listing when available, or use this MCP deeplink:

```text
cursor://anysphere.cursor-deeplink/mcp/install?name=offlinecreator&config=eyJ1cmwiOiJodHRwczovL21jcC5vZmZsaW5lY3JlYXRvcnN0dWRpby5jb20vbWNwIn0=
```

The exact RFC discovery sequence used by each client can vary and should be validated against the current client release.

## Local stdio fallback

Install on demand with `npx -y @offlinecreator/mcp`. Set `OFFLINECREATOR_API_KEY` as a secret environment value in the MCP client. Create and revoke personal keys in [Studio Settings](https://offlinecreatorstudio.com/settings).

Optional stdio variables:

- `OFFLINECREATOR_API_BASE`: defaults to `https://offlinecreatorstudio.com`; only that origin and localhost are accepted.
- `OFFLINECREATOR_UPLOAD_ROOT`: filesystem boundary for local `upload_input` paths; defaults to the process working directory.

Node.js 20 or newer is required. Never put a key in a URL, committed file, or remote OAuth configuration.

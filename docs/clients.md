# Client configuration

## Cursor and compatible clients

Cursor supports remote MCP servers with OAuth. Configure only the server URL; authentication and credential storage are client-managed.

```json
{
  "mcpServers": {
    "offlinecreator": {
      "url": "https://mcp.offlinecreatorstudio.com/mcp"
    }
  }
}
```

Standalone Cursor MCP install link:

```text
cursor://anysphere.cursor-deeplink/mcp/install?name=offlinecreator&config=eyJ1cmwiOiJodHRwczovL21jcC5vZmZsaW5lY3JlYXRvcnN0dWRpby5jb20vbWNwIn0=
```

Install the full Agent Plugin through its Cursor Marketplace listing when available. Cursor does not document a repository-install deeplink for arbitrary plugins.

## VS Code / Copilot

```json
{
  "servers": {
    "offlinecreator": {
      "type": "http",
      "url": "https://mcp.offlinecreatorstudio.com/mcp"
    }
  }
}
```

## Claude Code

```bash
claude mcp add offlinecreator --transport http https://mcp.offlinecreatorstudio.com/mcp
```

## Claude custom connector

In Claude, choose **Add custom connector** and enter `https://mcp.offlinecreatorstudio.com/mcp`. Claude custom connectors support remote MCP even though OfflineCreator Studio is not currently eligible for Anthropic's public Connectors Directory under its AI media policy.

## Local stdio fallback

```json
{
  "mcpServers": {
    "offlinecreator": {
      "command": "npx",
      "args": ["-y", "@offlinecreator/mcp"],
      "env": { "OFFLINECREATOR_API_KEY": "${OFFLINECREATOR_API_KEY}" }
    }
  }
}
```

Client UI labels and schemas change over time. The portable remote configuration is URL-only; consult current client documentation for the exact settings location.

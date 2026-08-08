# OfflineCreator Studio MCP

[OfflineCreator Studio](https://offlinecreatorstudio.com) tools for image and video generation through the Model Context Protocol (MCP).

**Version:** 0.1.2  
**Recommended:** `https://mcp.offlinecreatorstudio.com/mcp` (Streamable HTTP with client-managed OAuth)  
**Local fallback:** `npx -y @offlinecreator/mcp` (stdio; `OFFLINECREATOR_API_KEY` required)

## Quick start

For remote clients, add only the endpoint URL. Compatible clients manage OAuth authentication and credential storage. Do not add an API key to remote configuration.

```json
{
  "mcpServers": {
    "offlinecreator": {
      "url": "https://mcp.offlinecreatorstudio.com/mcp"
    }
  }
}
```

For local stdio:

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

See [installation](docs/install.md), [client setup](docs/clients.md), and [OAuth](docs/oauth.md).

## Tools

`list_models`, `get_credits`, `generate`, `upload_input`, `get_generation`, `wait_generation`, `download_output`, `cancel_generation`, and `list_generations`.

The public package contains the thin API client, stdio MCP server, and the reusable cryptographic request bridge exported as `@offlinecreator/mcp/oauth-bridge`. The hosted API, OAuth Worker, moderation, account, credit, and generation backend are proprietary and are not included in this repository.

## Development

```bash
npm ci
npm run validate
```

The validation suite builds, tests, checks manifest/version consistency, checks local documentation links, inspects the npm dry-run file list, and scans public files for common secret and production-ID patterns.

## Policy and legal

Anthropic's current Software Directory Policy does not accept software whose primary service is AI-generated images, video, or audio. OfflineCreator Studio is therefore not eligible for the public Claude Connectors Directory at this time. Claude custom connectors remain supported through the remote MCP URL.

- [Security](SECURITY.md)
- [Support](SUPPORT.md)
- [Contributing](CONTRIBUTING.md)
- [Privacy](https://offlinecreatorstudio.com/privacy)
- [Terms](https://offlinecreatorstudio.com/terms)
- [Acceptable use](https://offlinecreatorstudio.com/acceptable-use)

Licensed under the [MIT License](LICENSE).

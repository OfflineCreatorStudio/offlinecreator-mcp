# Listing dossier

## Identity

- Name: OfflineCreator Studio
- Package: `@offlinecreator/mcp`
- Version: `0.1.5`
- MCP Registry name: `com.offlinecreatorstudio/mcp`
- Remote endpoint: `https://mcp.offlinecreatorstudio.com/mcp`
- Homepage/docs: `https://offlinecreatorstudio.com/mcp-cli`
- Privacy: `https://offlinecreatorstudio.com/privacy`
- Terms: `https://offlinecreatorstudio.com/terms`
- Acceptable use: `https://offlinecreatorstudio.com/acceptable-use`
- Support: `https://offlinecreatorstudio.com/contact`

## Listing copy

**Tagline:** Create images, video, audio, and 3D with OfflineCreator Studio.

OfflineCreator Studio connects MCP clients to cloud image, video, audio, and 3D workflows. The server exposes 20 tools: model and outcome quoting (`list_models`, `quote_generation`, `list_outcome_capabilities`, `quote_outcome`, `plan_outcome`, `get_receipt`, `wait_outcome`, `verify_attestation`), read (`get_credits`, `list_generations`, `get_generation`, `wait_generation`, `download_output`), and generate (`execute_outcome`, `cancel_outcome`, `settle_outcome`, `generate`, `upload_input`, `upload_asset`, `cancel_generation`). Remote clients use OAuth at `https://mcp.offlinecreatorstudio.com/mcp`. Local stdio uses a personal API key. x402 is an optional payment rail for stdio, not a substitute for that key.

## Distribution truth

The TypeScript client, stdio MCP server, tests, and owned brand assets are MIT licensed here. The hosted API, OAuth service, web application, account and credit systems, moderation, billing, provider integrations, and generation infrastructure are proprietary and are not included.

## Directory status

- Official MCP Registry: already published (August 8, 2026) as `com.offlinecreatorstudio/mcp`. The current state of this repository's registry metadata is `0.1.5`. Publish that metadata only after `@offlinecreator/mcp@0.1.5` is live on npm.
- Cursor / Agent Plugins: portable manifests prepared; current schema URLs recorded in the files.
- Anthropic Connectors Directory: do not submit while the current Software Directory Policy excludes software whose primary service is AI-generated images, video, or audio. Custom Claude connectors remain supported.

No submission, publication, repository creation, or other external write is performed by this dossier.

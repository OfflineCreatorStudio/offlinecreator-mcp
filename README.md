# @offlinecreator/mcp

MCP server + thin CLI for [OfflineCreator Studio](https://offlinecreatorstudio.com).

Gives Cursor, Claude Desktop, Claude Code, Hermes, Windsurf, and other MCP clients tools to list models, check credits, run image/video/audio/3D workflows, upload typed assets, and retrieve every result.

**Version:** 0.1.5. This is the upcoming npm release. Treat `@offlinecreator/mcp@0.1.5` as unpublished until it is live on npm. The previous published release is [`@offlinecreator/mcp@0.1.4`](https://www.npmjs.com/package/@offlinecreator/mcp) (2026-09-27).

**New in 0.1.5:** request deadlines (120 s per ordinary call, 10 min per upload; a timed-out paid request is reported as `REQUEST_TIMEOUT` with `outcomeUnknown: true`, so check `list_generations` and `get_credits` before retrying), `wait_generation`/`wait_outcome` treat a slow poll as "not finished yet" and end with `timedOut: true` instead of an error, upload bodies are no longer copied in memory, a stricter upload jail (realpath containment, file identity compared with 64-bit ids, regular files only), and `upload_input` refuses GIF up front.

**New in 0.1.4:** `cancel_outcome`,
`client_reference` on outcome intents (order the same brief again as a new
order), `wait_outcome` that reads `run.outcome_status` (cancelled and
partially completed orders end the wait; a draining cancel keeps it going), and
A2A `CancelTask` answering `TaskNotCancelable` once a job reached its provider,
`maxCredits` on `generate` (Studio refuses a costlier quote without charging),
`structuredContent` and a `resource_link` on completed outputs (for clients on
MCP 2025-06-18 or later), and an immediate return from `generate` on remote
transports. The hosted remote servers serve the published release's tools and
version (`PUBLISHED_MCP_RELEASE` in `src/server.ts`); when a later release is
prepared but not yet published, they keep hiding its new tools until it is.
The older 0.1.3 stdio package drops `maxCredits`, so upgrade for the ceiling.

**Recommended remote MCP:** `https://mcp.offlinecreatorstudio.com/mcp` (Streamable HTTP + OAuth 2.1)

**API-key fallback:** local stdio or `https://offlinecreatorstudio.com/mcp`

## Setup

Add the recommended URL to your MCP client, then complete Studio browser
sign-in and consent. No API key is stored in the client configuration.

For local stdio or legacy remote fallback, create a scoped key in **Settings**
and copy the secret once (`oc_live_…` or `oc_test_…`).

### Environment

| Variable                                 | Required | Description                                                                                                                                                                                     |
| ---------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OFFLINECREATOR_API_KEY`                 | Yes      | Personal API key from Settings                                                                                                                                                                  |
| `OFFLINECREATOR_API_BASE`                | No       | API origin. Default `https://offlinecreatorstudio.com`. Localhost allowed; other hosts need `OFFLINECREATOR_ALLOW_INSECURE_API_BASE=true`.                                                      |
| `OFFLINECREATOR_UPLOAD_ROOT`             | No       | Directory that `upload_input` and `upload_asset` file paths must stay inside (default: process cwd, logged to stderr at startup). A filesystem or drive root is refused unless you set it here. |
| `OFFLINECREATOR_ALLOW_INSECURE_API_BASE` | No       | Set `true` only for private/non-prod API hosts.                                                                                                                                                 |
| `X402_EVM_PRIVATE_KEY`                   | No       | Optional EVM wallet private key for stdio MCP / CLI. Pays x402 USDC challenges for top-ups and pay-as-you-go generations. Never paste into chat.                                                |
| `OFFLINECREATOR_X402_MAX_USD`            | No       | Optional per-payment spend cap in USD (default `50`).                                                                                                                                           |

## Security notes

- API keys stay in env / MCP client config — tools never echo them.
- `upload_input` cannot read arbitrary disk paths: paths must stay under the upload root (symlinks and junctions are resolved first, so a link that points outside the root is refused), use PNG, JPEG, or WebP extensions, pass size limits, and match image magic bytes. GIF is refused with a convert-to-PNG/JPEG/WebP message because Studio does not accept it as an input image.
- `upload_asset` uses the same root boundary, a media/mesh extension allowlist, a local magic-byte check of the file content, server-side slot validation, and a 250 MB ceiling. A `.bin` has no signature, so it is only checked for not being plain text.
- The jail does not detect hard links or bind mounts: keep only files you are happy to upload under the upload root.
- The client only calls `/api/v1/*` on a trusted API origin (HTTPS except localhost).
- Generations still use Studio moderation, credit reserve/refund, and ownership checks.
- x402 is payment, not identity: API-key auth still runs first. Wallet keys stay in the agent environment; the hosted OAuth Worker never holds them.

stdio `upload_input` and `upload_asset` take `filePath` under the upload root. Remote connections send `imageBase64` instead. Cursor tool-bridge size limits still apply to inline images. See [security notes](docs/security.md).

Product overview for dual-rail payments: [x402 agent payments](https://offlinecreatorstudio.com/x402).

## Install by client

### Cursor

Recommended remote OAuth:

```json
{
  "mcpServers": {
    "offlinecreator": {
      "url": "https://mcp.offlinecreatorstudio.com/mcp"
    }
  }
}
```

API-key stdio fallback:

```json
{
  "mcpServers": {
    "offlinecreator": {
      "command": "npx",
      "args": ["-y", "@offlinecreator/mcp"],
      "env": {
        "OFFLINECREATOR_API_KEY": "oc_live_…"
      }
    }
  }
}
```

Never put the key in the URL or use `?api_key=`.

Local checkout of this repository:

```json
{
  "mcpServers": {
    "offlinecreator": {
      "command": "node",
      "args": ["dist/index.js"],
      "env": {
        "OFFLINECREATOR_API_KEY": "oc_test_…",
        "OFFLINECREATOR_API_BASE": "http://localhost:3000"
      }
    }
  }
}
```

### Claude Desktop

Add `https://mcp.offlinecreatorstudio.com/mcp` in **Settings → Connectors →
Add custom connector**. Use the stdio JSON above in
`%APPDATA%\Claude\claude_desktop_config.json` as the API-key fallback.

### Claude Code

Remote OAuth:

```bash
claude mcp add offlinecreator --transport http https://mcp.offlinecreatorstudio.com/mcp
```

Local stdio:

```bash
claude mcp add offlinecreator --env OFFLINECREATOR_API_KEY=oc_live_… -- npx -y @offlinecreator/mcp
```

### Hermes

Add to `~/.hermes/config.yaml`, then run `/reload-mcp`:

```yaml
mcp_servers:
  offlinecreator:
    url: "https://mcp.offlinecreatorstudio.com/mcp"
```

### Windsurf

Add to `%USERPROFILE%\.codeium\windsurf\mcp_config.json`:

```json
{
  "mcpServers": {
    "offlinecreator": {
      "serverUrl": "https://mcp.offlinecreatorstudio.com/mcp"
    }
  }
}
```

### VS Code / Copilot

VS Code uses `servers` rather than `mcpServers`. Add to `.vscode/mcp.json` or
the MCP user configuration:

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

### Legacy remote API-key fallback

Clients that support fixed headers can still use:

```json
{
  "mcpServers": {
    "offlinecreator": {
      "url": "https://offlinecreatorstudio.com/mcp",
      "headers": {
        "Authorization": "Bearer ${env:OFFLINECREATOR_API_KEY}"
      }
    }
  }
}
```

Never put a key in the URL or use `?api_key=`.

## Tools

| Tool                        | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list_models`               | Launch catalog + credit costs                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `quote_generation`          | Lock a provider-routed quote before generation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `plan_outcome`              | Intent → route → quote → local workflow DAG → evaluate. Preview only; does not start live catalog jobs. `includePilot` (`?pilot=1`) is reserved: third-party pilot listings are not live and it returns `409 PILOT_NOT_LIVE`; routing is first-party only. Authenticated execute is `execute_outcome`. Unauthenticated production returns `NOT_LIVE`.                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `quote_outcome`             | Payable outcome quote against the studio credit ledger (`offlinecreator.payment/v1`) with a SHA-256 routing attestation. `accepted_rails` lists credits, optional x402, human Stripe, optional MPP (Stripe Machine Payments Protocol; settles when enabled on the deployment, and `available` reports live status), and the reserved `card_agent` slot. Unauthenticated production returns `NOT_LIVE`.                                                                                                                                                                                                                                                                                                                                                                             |
| `execute_outcome`           | Run the workflow. API keys call the generation service and project settlement eligibility from reservations. Never settled. With outcome holds on for the account, the order's full price is held once, steps draw from it, a failed step's refund returns to the hold (a retry costs nothing extra) and the rest returns to the balance when the order finishes, is cancelled or sits idle for 30 minutes (6 hours at most). The same brief from the same account is the same order; send `client_reference` to order it again. `policy.prefer_rail=x402` is pay-per-outcome USDC even when the credit ledger has balance. `includePilot` is reserved and returns `409 PILOT_NOT_LIVE`; API keys do not imply marketplace routing. Unauthenticated production returns `NOT_LIVE`. |
| `settle_outcome`            | Acknowledge a completed outcome against existing generation reservations. Does not debit credits again. Unauthenticated production returns `NOT_LIVE`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `get_receipt`               | Fetch the stored receipt and live run for an attestation hash. `run.outcome_status` (running, completed, failed, incomplete, cancelled, partially_completed) and `run.step_status` give the order's state; `deliverables` lists each completed step's output with a 10-minute download URL and `credits` breaks down its credits (both need the `read` scope). The local logo stub is not a deliverable. Unauthenticated production returns `NOT_LIVE`.                                                                                                                                                                                                                                                                                                                            |
| `wait_outcome`              | Poll the stored run until the order finishes (completed, failed, cancelled or partially completed); a cancel that is still draining keeps the wait going. Does not start catalog work. Download from `deliverables` or with `download_output`. Unauthenticated production returns `NOT_LIVE`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `cancel_outcome`            | Cancel an outcome order: steps not yet at a provider stop and their credits return; running jobs finish and are charged only if they succeed. 200 when done, 202 while jobs finish (`waitSeconds` up to 25). Runs without an outcome hold answer 409 `legacy_run` with per-generation cancel links.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `list_outcome_capabilities` | Rate-card capabilities. `includePilot` also lists illustrative pilot fixtures, which are not live and not routable. Unauthenticated production returns `NOT_LIVE`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `verify_attestation`        | Re-hash a routing attestation. Unauthenticated production returns `NOT_LIVE`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `get_credits`               | Current balance                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `generate`                  | Start generation. Optional `maxCredits` caps the spend: Studio refuses a costlier locked quote without charging. `wait: true` polls up to 120 s over stdio; remote connections return the `generationId` at once (follow up with `wait_generation`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `upload_input`              | Attach image for image-to-video, then submit                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `upload_asset`              | Attach an ordered image, video, audio, mesh, or draft-cache input; optionally submit                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `get_generation`            | Current status                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `wait_generation`           | Poll until done                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `download_output`           | Short-lived signed URL for a completed output                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `cancel_generation`         | Cancel a reserved job before submission + refund; repeating is safe, and a submitted or finished job answers 409 with a reason                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `list_generations`          | Recent jobs                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

Completed outputs from `generate`, `upload_input`, `upload_asset`,
`get_generation`, `wait_generation`, and `download_output` also return MCP
`structuredContent` and a `resource_link` (`uri`, `name`, `mimeType`) to the
signed output, after the unchanged text JSON, when the request speaks protocol
revision 2025-06-18 or later. Older revisions (including a 2025-era HTTP request
without `MCP-Protocol-Version`, which counts as 2025-03-26) get the text JSON
only, since neither field exists before 2025-06-18.

Tools are filtered by key scope (`models`, `read`, `generate`). Top-up
discovery and Checkout creation are CLI/API features, not MCP tools.

**Two payment rails:**

- **Humans / Stripe:** CLI `topups` / `topup --id … --stripe` (or Studio
  pricing Buy) return a Checkout URL for a human browser action. Agents must
  not complete card checkout inside the MCP client.
- **Agents / x402 (optional):** With `X402_EVM_PRIVATE_KEY` set, `topup` and
  `generate` can settle USDC when the API returns HTTP 402 with a
  `PAYMENT-REQUIRED` header. Legacy JSON `INSUFFICIENT_CREDITS` 402s (no
  `PAYMENT-REQUIRED`) still mean “fund via Stripe.” See
  [x402 agent payments](https://offlinecreatorstudio.com/x402).

## CLI sugar

```bash
npx @offlinecreator/mcp models
npx @offlinecreator/mcp balance
npx @offlinecreator/mcp topups
npx @offlinecreator/mcp topup --id topup-1000          # x402 when wallet set; else Stripe URL
npx @offlinecreator/mcp topup --id topup-1000 --stripe # force Stripe Checkout URL
npx @offlinecreator/mcp quote --model seedance-2-5-text --options '{"duration":5,"resolution":"720p"}'
npx @offlinecreator/mcp plan-outcome --north-star
npx @offlinecreator/mcp execute-outcome --ecommerce --x402 --wait
npx @offlinecreator/mcp generate --model flux-schnell --prompt "A clean product still" --wait
```

Pass the quote response's `lockedQuoteToken` as `quoteToken` to `generate`.
Studio manages provider selection and permits only bounded failover that does
not increase the reserved customer charge.

## Development

This repository is the public npm and MCP Registry mirror. Validate it with:

```bash
npm ci
npm run validate
```

Local stdio against a private API:

```bash
npm run build
OFFLINECREATOR_API_KEY=oc_test_… OFFLINECREATOR_API_BASE=http://localhost:3000 npm start
```

## Privacy note

Studio generations run on disclosed cloud providers (not on-device). LocalForge remains the offline product.

## Policy and legal

Anthropic's current Software Directory Policy does not accept software whose primary service is AI-generated images, video, or audio. OfflineCreator Studio is therefore not eligible for the public Claude Connectors Directory at this time. Claude custom connectors remain supported through the remote MCP URL.

- [Security](SECURITY.md)
- [Release operations](docs/releasing.md)
- [Support](SUPPORT.md)
- [Contributing](CONTRIBUTING.md)
- [Privacy](https://offlinecreatorstudio.com/privacy)
- [Terms](https://offlinecreatorstudio.com/terms)
- [Acceptable use](https://offlinecreatorstudio.com/acceptable-use)

Licensed under the [MIT License](LICENSE).

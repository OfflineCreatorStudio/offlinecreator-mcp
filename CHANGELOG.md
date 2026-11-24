# Changelog

All notable public package changes are documented here. Versions follow the
npm releases of `@offlinecreator/mcp`.

## 0.1.5 - unreleased

Upcoming npm release. Do not dispatch MCP Registry publishing for tag
`v0.1.5` until `@offlinecreator/mcp@0.1.5` is live on npm.

This public repository now mirrors `packages/mcp` from
`AgentSarge/offlinecreator-studio` master (the 0.1.4 package plus the changes
master documents as the next release). The hosted and stdio surfaces list the
same 20 tools.

- Request deadlines: 120 s for an ordinary call and 10 min for an upload. A
  timed-out paid request is `REQUEST_TIMEOUT` with `outcomeUnknown: true`.
  Check `list_generations` and `get_credits` before retrying.
- `wait_generation` and `wait_outcome` treat a slow poll as not finished yet
  and end with `timedOut: true` instead of throwing.
- Upload bodies are no longer copied in memory.
- Stricter upload jail: realpath containment, regular files only, and file
  identity compared with 64-bit ids.
- `upload_input` refuses GIF up front and tells the caller to convert to PNG,
  JPEG, or WebP.
- Registry metadata describes image, video, audio, and 3D creation, OAuth at
  `https://mcp.offlinecreatorstudio.com/mcp`, API-key stdio, and x402 as an
  optional stdio payment rail (`X402_EVM_PRIVATE_KEY`, not required).

## 0.1.4 - 2026-09-27

- Added `cancel_outcome`.
- Added `client_reference` on outcome intents so the same brief can be ordered
  again as a new order.
- `wait_outcome` reads `run.outcome_status`. Cancelled and partially completed
  orders end the wait. A draining cancel keeps it going.
- A2A `CancelTask` answers `TaskNotCancelable` once a job has reached its
  provider.
- `generate` accepts `maxCredits`. Studio refuses a costlier quote without
  charging. The 0.1.3 stdio package drops `maxCredits`.
- Completed outputs can return `structuredContent` and a `resource_link` for
  clients on MCP 2025-06-18 or later.
- `generate` returns immediately on remote transports.
- Hosted remote servers serve the published release's tools and version.

## 0.1.3

- Stdio release before the `maxCredits` spend ceiling. Upgrade to 0.1.4 or
  later for that ceiling.

## 0.1.2 - 2026-08-07

- Added the remote-first OAuth endpoint and retained the API-key stdio fallback.
- Preserved the public `./oauth-bridge` export and focused cryptographic tests required by the hosted OAuth Worker.
- Added tool annotations, upload path and image validation, trusted-origin checks, and package tests.
- Added synchronized registry, plugin, documentation, security, and release-validation artifacts.
- Added least-privilege CI, dependency review, CodeQL, protected tokenless npm
  publishing, attestations, SBOM/checksum generation, immutable Release
  handling, and separately gated MCP Registry publishing.
- Excluded proprietary hosted backend, OAuth service, billing, provider, application, and deployment code from the public distribution.

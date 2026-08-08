# Security controls

The public package minimizes local authority and credential exposure:

- API keys are read from `OFFLINECREATOR_API_KEY` for stdio and are never returned by tools.
- API requests are restricted to `/api/v1/*` on the canonical HTTPS origin or explicit localhost development.
- Redirects are rejected and output URLs are constrained to the configured API origin.
- Local file uploads are jailed under `OFFLINECREATOR_UPLOAD_ROOT`, extension-allowlisted, size-limited, and checked by image magic bytes.
- Remote MCP has no local filesystem access and uses OAuth discovery instead of static keys.
- Tool annotations identify read-only and destructive behavior.

The hosted service separately enforces authentication, authorization, usage policy, ownership, and account controls. Its proprietary implementation is outside this repository.

Report vulnerabilities through [SECURITY.md](../SECURITY.md).

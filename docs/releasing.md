# Release and supply-chain operations

Version `0.1.2` is the current release identity. Release automation never edits
versions. A maintainer must update every synchronized manifest in a reviewed
change before a future version can pass validation.

## Automated controls

- `CI` runs locked installation, formatting, type-checking, build, tests,
  manifest/schema/docs/assets/package validation, dependency audit, license
  policy, public-tree and Git-history secret scans, action-pin validation,
  stdio initialization, and safe unauthenticated remote OAuth discovery.
- `Dependency Review` blocks newly introduced high-severity vulnerabilities
  and dependencies outside the approved SPDX license set.
- `CodeQL` analyzes JavaScript and TypeScript on pull requests, pushes to
  `main`, and weekly.
- `Release npm Package` accepts an existing exact `v<package.version>` tag,
  rebuilds on a GitHub-hosted runner, creates a CycloneDX SBOM, checksums and a
  release manifest, verifies the npm tarball at SHA-1/SHA-256/SHA-512 and file
  level, and then pauses at the `npm-production` environment. The protected job
  uses npm Trusted Publishing OIDC, creates GitHub artifact/SBOM attestations,
  and publishes a draft GitHub Release only after all assets are available.
- `Publish MCP Registry Metadata` is manual and separately protected by the
  `mcp-registry-production` environment. It verifies the exact tag, official
  `server.json` schema, matching npm version, and the pinned MCP Publisher
  binary checksum before publishing.

All GitHub Actions are pinned to full commit SHAs with readable version
comments. Generated `release/`, `dist/`, tarballs, SBOMs, and dependencies are
ignored and must not be committed.

## Local release dry run

Use Node.js 24 and npm 11.5.1 or newer:

```sh
npm ci
npm run validate
npm run test:remote
RELEASE_TAG=v0.1.2 npm run release:prepare
RELEASE_TAG=v0.1.2 npm run release:verify
```

PowerShell:

```powershell
$env:RELEASE_TAG = "v0.1.2"
npm run release:prepare
npm run release:verify
Remove-Item Env:RELEASE_TAG
```

These commands create local artifacts but do not publish anything.

## Manual npm settings

Configure the `@offlinecreator/mcp` package on npmjs.com exactly as follows:

- Trusted publisher: **GitHub Actions**
- Organization or user: `OfflineCreatorStudio`
- Repository: `offlinecreator-mcp`
- Workflow filename: `release.yml`
- Environment: `npm-production`
- Allowed action: **npm publish**

After one successful OIDC publish, set package publishing access to **Require
two-factor authentication and disallow tokens**, and revoke obsolete automation
tokens. Do not add `NPM_TOKEN`; npm 11.5.1+ automatically creates provenance
for this public package from the public GitHub repository.

## Manual GitHub settings

1. Create `npm-production` and `mcp-registry-production` environments.
2. On each environment, require at least one maintainer reviewer, prevent
   self-review, and restrict deployments to protected `main` and tags matching
   `v*`.
3. Add no secrets to `npm-production`.
4. Store only the Registry DNS proof key as the
   `mcp-registry-production` environment secret `MCP_PRIVATE_KEY`.
5. In repository **Settings → Releases**, enable **release immutability**.
6. Protect `main`: require pull requests, approvals, conversation resolution,
   and the CI, Dependency Review, and CodeQL checks; dismiss stale approvals and
   block force pushes/deletion.
7. Add a tag ruleset for `v*` that restricts creation, update, and deletion to
   release maintainers.
8. Keep default `GITHUB_TOKEN` permissions read-only. Do not allow Actions to
   create or approve pull requests unless separately required.
9. Enable GitHub secret scanning, push protection, Dependabot alerts, and
   private vulnerability reporting for the public repository.

Immutable Releases lock the tag and assets only after the draft is published.
The release workflow therefore creates a draft, uploads every asset, and makes
the release public as its final GitHub operation.

## Manual MCP Registry and DNS settings

The immutable Registry name is `com.offlinecreatorstudio/mcp`. Official MCP
Registry rules require a domain-authentication proof for this reverse-DNS
namespace; GitHub OIDC is valid only for `io.github.*` names.

Provision an Ed25519 proof key through the official MCP Publisher instructions,
keep the private key only in the protected `mcp-registry-production`
environment, and add this TXT record at the `offlinecreatorstudio.com` DNS apex:

```text
v=MCPv1; k=ed25519; p=<base64 Ed25519 public key>
```

Do not put the private key in DNS, source, workflow YAML, repository secrets, or
logs. After DNS propagation, manually dispatch `Publish MCP Registry Metadata`
with `v0.1.2` and approve the environment deployment. Registry versions are
immutable, so never rerun a successful publication for the same version.

## Maintainer release sequence

1. Merge only after all required checks pass.
2. Create an exact protected tag such as `v0.1.2` at the reviewed commit.
3. Review and approve the `npm-production` deployment.
4. Verify npm provenance and the immutable GitHub Release with
   `gh release verify v0.1.2`.
5. After npm propagation, manually dispatch and approve the MCP Registry
   workflow.

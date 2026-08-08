# Cursor and Agent Plugins checklist

- [ ] Revalidate `plugin.json` and `mcp.json` against Agent Plugins 1.0.0 schemas.
- [ ] Confirm the repository is public, open source, and has a clear `README.md`.
- [ ] Confirm the root Agent Plugin manifest and all referenced component files are valid.
- [ ] Confirm the unique plugin name remains lowercase kebab-case.
- [ ] Confirm the remote entry is URL-only; Cursor manages OAuth and credential storage.
- [ ] Confirm optional icon files and listing copy follow current marketplace guidance.
- [ ] Test locally from `~/.cursor/plugins/local`.
- [ ] Validate in the current Cursor release.
- [ ] Validate the standalone MCP deeplink using only the individual server object.
- [ ] Verify the target public repository URL exists before submission.
- [ ] Submit through `https://cursor.com/marketplace/publish`.
- [ ] Account for manual review of the initial release and every update.
- [ ] Submit only after explicit approval.

TODO: Cursor marketplace packaging and submission requirements may change; re-check official documentation immediately before submission rather than adding unverified fields now.

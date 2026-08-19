import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));
const [pkg, plugin, mcp, server] = await Promise.all([
  readJson("package.json"),
  readJson("plugin.json"),
  readJson("mcp.json"),
  readJson("server.json"),
]);
const version = "0.1.2";
assert.equal(pkg.version, version);
assert.equal(plugin.version, version);
assert.equal(server.version, version);
assert.equal(pkg.mcpName, server.name);
assert.equal(pkg.name, "@offlinecreator/mcp");
assert.deepEqual(pkg.exports?.["./oauth-bridge"], {
  types: "./dist/oauth-bridge.d.ts",
  import: "./dist/oauth-bridge.js",
});
assert.deepEqual(pkg.exports?.["./agent-readiness"], {
  types: "./dist/agent-readiness.d.ts",
  import: "./dist/agent-readiness.js",
});
assert.equal(
  plugin.$schema,
  "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
);
assert.equal(
  mcp.$schema,
  "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
);
assert.equal(
  server.$schema,
  "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json",
);
assert.deepEqual(Object.keys(mcp).sort(), ["$schema", "mcpServers"].sort());
const remote = mcp.mcpServers?.offlinecreator;
assert.deepEqual(remote, {
  type: "streamable-http",
  url: "https://mcp.offlinecreatorstudio.com/mcp",
});
assert.deepEqual(server.remotes, [
  { type: "streamable-http", url: remote.url },
]);
assert.equal(server.packages?.[0]?.identifier, pkg.name);
assert.equal(server.packages?.[0]?.version, version);
assert.deepEqual(server.packages?.[0]?.transport, { type: "stdio" });
assert.deepEqual(server.packages?.[0]?.environmentVariables, [
  {
    name: "OFFLINECREATOR_API_KEY",
    description:
      "Personal API key created in OfflineCreator Studio Settings. Required only for local stdio.",
    isRequired: true,
    isSecret: true,
    format: "string",
  },
]);
assert.ok(
  !("headers" in remote),
  "Remote configuration must rely on OAuth discovery.",
);
console.log(
  "Manifest structure, transport auth, and version synchronization passed.",
);

import { readFile } from "node:fs/promises";
import Ajv from "ajv";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const entries = [
  {
    file: "plugin.json",
    schemaUrl:
      "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
    ajv: new Ajv2020({ allErrors: true, strict: false }),
  },
  {
    file: "mcp.json",
    schemaUrl:
      "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
    ajv: new Ajv2020({ allErrors: true, strict: false }),
  },
  {
    file: "server.json",
    schemaUrl:
      "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json",
    ajv: new Ajv({ allErrors: true, strict: false }),
  },
];

for (const entry of entries) {
  addFormats(entry.ajv);
  const response = await fetch(entry.schemaUrl);
  if (!response.ok) {
    throw new Error(`Unable to fetch ${entry.schemaUrl}: ${response.status}`);
  }
  const schema = await response.json();
  const document = JSON.parse(await readFile(entry.file, "utf8"));
  const validate = entry.ajv.compile(schema);
  if (!validate(document)) {
    throw new Error(
      `${entry.file} failed ${entry.schemaUrl}:\n`
        + entry.ajv.errorsText(validate.errors, { separator: "\n" }),
    );
  }
}

console.log("Official Agent Plugins and MCP Registry schema validation passed.");

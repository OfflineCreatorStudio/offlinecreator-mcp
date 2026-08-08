import assert from "node:assert/strict";
import { describe, it } from "node:test";
import packageMetadata from "../package.json" with { type: "json" };
import { MCP_SERVER_INFO, TOOL_ANNOTATIONS } from "./server.js";

describe("MCP server metadata", () => {
  it("uses the package version for server initialization", () => {
    assert.equal(MCP_SERVER_INFO.version, packageMetadata.version);
  });

  it("publishes accurate annotations for all nine tools", () => {
    assert.deepEqual(TOOL_ANNOTATIONS, {
      list_models: {
        title: "List models",
        readOnlyHint: true,
        destructiveHint: false,
      },
      get_credits: {
        title: "Get credits",
        readOnlyHint: true,
        destructiveHint: false,
      },
      list_generations: {
        title: "List generations",
        readOnlyHint: true,
        destructiveHint: false,
      },
      get_generation: {
        title: "Get generation",
        readOnlyHint: true,
        destructiveHint: false,
      },
      wait_generation: {
        title: "Wait for generation",
        readOnlyHint: true,
        destructiveHint: false,
      },
      download_output: {
        title: "Download output URL",
        readOnlyHint: true,
        destructiveHint: false,
      },
      generate: {
        title: "Generate",
        readOnlyHint: false,
        destructiveHint: false,
      },
      upload_input: {
        title: "Upload input image",
        readOnlyHint: false,
        destructiveHint: false,
      },
      cancel_generation: {
        title: "Cancel generation",
        readOnlyHint: false,
        destructiveHint: true,
      },
    });
  });
});

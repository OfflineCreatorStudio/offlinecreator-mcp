import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { afterEach, describe, it } from "node:test";
import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
  createMcpHandler,
} from "@modelcontextprotocol/server";
import {
  StdioServerTransport,
  serveStdio,
} from "@modelcontextprotocol/server/stdio";
import packageMetadata from "../package.json" with { type: "json" };
import { StudioApiClient, StudioApiTimeoutError } from "./client.js";
import type { McpConfig } from "./config.js";
import {
  MCP_SERVER_INFO,
  TOOL_ANNOTATIONS,
  TOOL_SCOPES,
  createOfflineCreatorServer,
} from "./server.js";

const GENERATION_ID = "0f0e2c1a-5b4d-4c3b-8a29-1e0d9c8b7a61";
const STUDIO = "https://studio.test";

type ToolCallResult = {
  content: Record<string, unknown>[];
  structuredContent?: unknown;
  isError?: boolean;
};

/** A fake Studio API: each request is recorded and answered by `respond`. */
function fakeStudio(respond: (request: Request) => unknown) {
  const requests: Request[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    requests.push(request.clone());
    const answer = respond(request);
    return answer instanceof Response ? answer : Response.json(answer);
  };
  return { requests, fetcher };
}

/** Remote transports (Studio /mcp, the OAuth Worker) cannot read local files. */
function remoteConfig(fetcher: typeof fetch): McpConfig {
  return { apiBase: STUDIO, fetcher };
}

/** Only the stdio entrypoint injects local file readers. */
function stdioConfig(fetcher: typeof fetch): McpConfig {
  return {
    apiBase: STUDIO,
    fetcher,
    readLocalImage: async () => {
      throw new Error("not used");
    },
  };
}

async function mcpCall(
  config: McpConfig,
  method: string,
  params: Record<string, unknown>,
  headers: Record<string, string> = {},
) {
  const handler = createMcpHandler(() => createOfflineCreatorServer(config));
  const response = await handler.fetch(
    new Request("https://mcp.test/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...headers,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }),
  );
  const text = await response.text();
  const line = text.split("\n").find((entry) => entry.startsWith("data: "));
  const body = JSON.parse(line ? line.slice(6) : text) as {
    result?: unknown;
    error?: unknown;
  };
  assert.ok(body.result, `expected a result, got ${text.slice(0, 300)}`);
  return body.result;
}

/**
 * One stateless HTTP tools/call. A 2025-era client sends the negotiated
 * revision in MCP-Protocol-Version; a 2026-07-28 client names it in `_meta`.
 */
async function callTool(
  config: McpConfig,
  name: string,
  args: Record<string, unknown>,
  protocolVersion?: string,
) {
  const modern =
    protocolVersion !== undefined && protocolVersion >= "2026-07-28";
  return (await mcpCall(
    config,
    "tools/call",
    {
      name,
      arguments: args,
      ...(modern
        ? {
            _meta: {
              [PROTOCOL_VERSION_META_KEY]: protocolVersion,
              [CLIENT_INFO_META_KEY]: { name: "server-test", version: "0.0.0" },
              [CLIENT_CAPABILITIES_META_KEY]: {},
            },
          }
        : {}),
    },
    {
      ...(protocolVersion ? { "mcp-protocol-version": protocolVersion } : {}),
      ...(modern ? { "mcp-method": "tools/call", "mcp-name": name } : {}),
    },
  )) as ToolCallResult;
}

/** initialize at `protocolVersion` over stdio, then one tools/call. */
async function stdioToolCall(
  config: McpConfig,
  protocolVersion: string,
  name: string,
  args: Record<string, unknown>,
) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const handle = serveStdio(() => createOfflineCreatorServer(config), {
    transport: new StdioServerTransport(stdin, stdout),
  });
  let output = "";
  stdout.on("data", (chunk: Buffer | string) => {
    output += typeof chunk === "string" ? chunk : chunk.toString("utf8");
  });
  const response = async (id: number) => {
    const started = Date.now();
    while (Date.now() - started < 5000) {
      for (const line of output.split("\n")) {
        if (!line.trim()) continue;
        const message = JSON.parse(line) as { id?: number; result?: unknown };
        if (message.id === id) return message;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`stdio response ${id} timed out: ${output}`);
  };
  const send = (message: Record<string, unknown>) =>
    stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);

  try {
    send({
      id: 1,
      method: "initialize",
      params: {
        protocolVersion,
        capabilities: {},
        clientInfo: { name: "server-test", version: "0.0.0" },
      },
    });
    const initialized = (await response(1)).result as {
      protocolVersion?: string;
    };
    assert.equal(initialized.protocolVersion, protocolVersion);
    send({ method: "notifications/initialized" });
    send({ id: 2, method: "tools/call", params: { name, arguments: args } });
    return (await response(2)).result as ToolCallResult;
  } finally {
    await handle.close();
    stdin.end();
    stdout.end();
  }
}

function textJson(result: ToolCallResult) {
  const first = result.content[0];
  assert.equal(first?.type, "text");
  return JSON.parse(String(first?.text)) as Record<string, unknown>;
}

const originalWaitGeneration = StudioApiClient.prototype.waitGeneration;

function recordWaits() {
  const waits: Parameters<StudioApiClient["waitGeneration"]>[0][] = [];
  StudioApiClient.prototype.waitGeneration = async function (input) {
    waits.push(input);
    return { generationId: input.generationId, status: "completed" };
  };
  return waits;
}

afterEach(() => {
  StudioApiClient.prototype.waitGeneration = originalWaitGeneration;
});

describe("generate tool for host approval dialogs", () => {
  it("forwards maxCredits so Studio refuses a locked quote above it", async () => {
    const studio = fakeStudio(() =>
      Response.json(
        {
          error: "The locked quote costs 42 credits, above maxCredits 25.",
          code: "MAX_CREDITS_EXCEEDED",
          maxCredits: 25,
          customerCredits: 42,
        },
        { status: 409 },
      ),
    );

    const result = await callTool(remoteConfig(studio.fetcher), "generate", {
      modelId: "veo-fast",
      prompt: "A slow pan across a studio still life",
      maxCredits: 25,
    });

    assert.equal(studio.requests.length, 1);
    assert.equal(
      new URL(studio.requests[0]!.url).pathname,
      "/api/v1/generations",
    );
    const body = (await studio.requests[0]!.json()) as { maxCredits?: unknown };
    assert.equal(body.maxCredits, 25);
    assert.equal(result.isError, true);
    assert.equal(textJson(result).status, 409);
    assert.equal(
      (textJson(result).details as { code?: string }).code,
      "MAX_CREDITS_EXCEEDED",
    );
  });

  it("presents a request timeout as an unknown outcome, not a bare message", async () => {
    const fetcher: typeof fetch = async () => {
      throw new StudioApiTimeoutError(120_000, "POST /api/v1/generations");
    };
    const result = await callTool(remoteConfig(fetcher), "generate", {
      modelId: "veo-fast",
      prompt: "A slow pan across a studio still life",
    });
    assert.equal(result.isError, true);
    const payload = textJson(result);
    assert.equal(payload.code, "REQUEST_TIMEOUT");
    assert.equal(payload.outcomeUnknown, true);
    assert.match(String(payload.error), /UNKNOWN/);
    assert.match(String(payload.next), /list_generations and get_credits/);
  });

  it("describes maxCredits and a wait that matches its 120 s ceiling", async () => {
    const listed = (await mcpCall(
      remoteConfig(fakeStudio(() => ({})).fetcher),
      "tools/list",
      {},
    )) as {
      tools: {
        name: string;
        inputSchema: { properties: Record<string, { description?: string }> };
      }[];
    };
    const generate = listed.tools.find((tool) => tool.name === "generate");
    const properties = generate?.inputSchema.properties ?? {};

    assert.match(properties.maxCredits?.description ?? "", /credits/i);
    assert.match(properties.wait?.description ?? "", /120 s/);
  });

  it("waits no longer than the advertised 120 s on stdio", async () => {
    const waits = recordWaits();
    const studio = fakeStudio(() => ({
      generationId: GENERATION_ID,
      status: "queued",
    }));

    await callTool(stdioConfig(studio.fetcher), "generate", {
      modelId: "flux-schnell",
      prompt: "A clean product still on slate",
      wait: true,
    });

    assert.deepEqual(waits, [
      { generationId: GENERATION_ID, timeoutSeconds: 120 },
    ]);
  });

  it("returns the generation id immediately on remote hosts even when wait is true", async () => {
    const waits = recordWaits();
    const studio = fakeStudio(() => ({
      generationId: GENERATION_ID,
      status: "queued",
    }));

    const result = await callTool(remoteConfig(studio.fetcher), "generate", {
      modelId: "flux-schnell",
      prompt: "A clean product still on slate",
      wait: true,
    });

    assert.deepEqual(waits, []);
    assert.equal(studio.requests.length, 1);
    assert.equal(textJson(result).generationId, GENERATION_ID);
    assert.equal(textJson(result).status, "queued");
  });
});

describe("completed generation outputs", () => {
  const completed = {
    generationId: GENERATION_ID,
    status: "completed",
    outputUrl: `/api/assets/${GENERATION_ID}/output?sig=abc`,
    outputContentType: "image/png",
    outputUrlExpiresAt: 1_900_000_000,
  };
  const absoluteOutput = `${STUDIO}/api/assets/${GENERATION_ID}/output?sig=abc`;

  it("adds structuredContent and a resource_link after the unchanged text JSON on 2025-06-18", async () => {
    // A GET is a status poll; every POST (start, upload, submit) is accepted.
    const studio = fakeStudio((request) =>
      request.method === "GET"
        ? completed
        : { generationId: GENERATION_ID, status: "queued" },
    );
    const png =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
    const calls: [string, Record<string, unknown>][] = [
      ["get_generation", { generationId: GENERATION_ID }],
      ["download_output", { generationId: GENERATION_ID }],
      ["wait_generation", { generationId: GENERATION_ID }],
      [
        "generate",
        {
          modelId: "flux-schnell",
          prompt: "A clean product still",
          wait: true,
        },
      ],
      [
        "upload_input",
        { generationId: GENERATION_ID, imageBase64: png, wait: true },
      ],
      [
        "upload_asset",
        {
          generationId: GENERATION_ID,
          slot: "image_urls",
          assetBase64: png,
          contentType: "image/png",
          submit: true,
          wait: true,
        },
      ],
    ];

    for (const [name, args] of calls) {
      const result = await callTool(
        stdioConfig(studio.fetcher),
        name,
        args,
        "2025-06-18",
      );
      const text = textJson(result);
      const generation = (
        name === "upload_asset" ? text.result : text
      ) as Record<string, unknown>;

      assert.equal(result.isError, false, name);
      assert.equal(generation.outputUrl, absoluteOutput, name);
      assert.deepEqual(result.structuredContent, text, name);
      assert.deepEqual(
        result.content[1],
        {
          type: "resource_link",
          uri: absoluteOutput,
          name: `generation-${GENERATION_ID}`,
          mimeType: "image/png",
        },
        name,
      );
      assert.equal(result.content.length, 2, name);
    }
  });

  it("keeps completed outputs text-only for protocol revisions before 2025-06-18", async () => {
    // resource_link content and structuredContent arrived in 2025-06-18; a
    // strict older client rejects a content type its schema does not know.
    const studio = fakeStudio(() => completed);
    const textOnly = (result: ToolCallResult, label: string) => {
      assert.equal(result.isError, false, label);
      assert.equal(result.content.length, 1, label);
      assert.equal(result.content[0]?.type, "text", label);
      assert.equal(result.structuredContent, undefined, label);
      assert.equal(textJson(result).outputUrl, absoluteOutput, label);
    };

    // No MCP-Protocol-Version header means 2025-03-26 per the spec.
    for (const version of [undefined, "2025-03-26", "2024-11-05"]) {
      textOnly(
        await callTool(
          remoteConfig(studio.fetcher),
          "get_generation",
          {
            generationId: GENERATION_ID,
          },
          version,
        ),
        `http ${version ?? "no header"}`,
      );
    }
    textOnly(
      await stdioToolCall(
        stdioConfig(studio.fetcher),
        "2025-03-26",
        "get_generation",
        {
          generationId: GENERATION_ID,
        },
      ),
      "stdio 2025-03-26",
    );
  });

  it("adds the resource_link for every revision from 2025-06-18 on", async () => {
    const studio = fakeStudio(() => completed);
    const linked = (result: ToolCallResult, label: string) => {
      assert.equal(result.content.length, 2, label);
      assert.equal(result.content[1]?.type, "resource_link", label);
      assert.equal(result.content[1]?.uri, absoluteOutput, label);
      assert.deepEqual(result.structuredContent, textJson(result), label);
    };

    for (const version of ["2025-06-18", "2025-11-25", "2026-07-28"]) {
      linked(
        await callTool(
          remoteConfig(studio.fetcher),
          "download_output",
          {
            generationId: GENERATION_ID,
          },
          version,
        ),
        `http ${version}`,
      );
    }
    linked(
      await stdioToolCall(
        stdioConfig(studio.fetcher),
        "2025-06-18",
        "get_generation",
        {
          generationId: GENERATION_ID,
        },
      ),
      "stdio 2025-06-18",
    );
  });

  it("leaves unfinished generations as text only", async () => {
    const studio = fakeStudio(() => ({
      generationId: GENERATION_ID,
      status: "processing",
    }));

    const result = await callTool(
      remoteConfig(studio.fetcher),
      "get_generation",
      {
        generationId: GENERATION_ID,
      },
      "2025-11-25",
    );

    assert.equal(result.content.length, 1);
    assert.equal(result.structuredContent, undefined);
    assert.equal(textJson(result).status, "processing");
  });
});

describe("MCP server metadata", () => {
  it("uses the package version for server initialization", () => {
    assert.equal(MCP_SERVER_INFO.version, packageMetadata.version);
  });

  it("keeps scope and annotation tables aligned for all twenty tools", () => {
    assert.deepEqual(
      Object.keys(TOOL_SCOPES).sort(),
      Object.keys(TOOL_ANNOTATIONS).sort(),
    );
    assert.equal(Object.keys(TOOL_SCOPES).length, 20);
    assert.equal(TOOL_SCOPES.cancel_outcome, "generate");
    assert.equal(
      Object.values(TOOL_SCOPES).every(
        (scope) =>
          scope === "models" || scope === "read" || scope === "generate",
      ),
      true,
    );
  });

  it("publishes accurate annotations for all twenty tools", () => {
    assert.deepEqual(TOOL_ANNOTATIONS, {
      list_models: {
        title: "List models",
        readOnlyHint: true,
        destructiveHint: false,
      },
      quote_generation: {
        title: "Quote generation",
        readOnlyHint: true,
        destructiveHint: false,
      },
      list_outcome_capabilities: {
        title: "List outcome capabilities",
        readOnlyHint: true,
        destructiveHint: false,
      },
      quote_outcome: {
        title: "Quote outcome",
        readOnlyHint: true,
        destructiveHint: false,
      },
      plan_outcome: {
        title: "Plan outcome",
        readOnlyHint: false,
        destructiveHint: false,
      },
      execute_outcome: {
        title: "Execute outcome",
        readOnlyHint: false,
        destructiveHint: false,
      },
      cancel_outcome: {
        title: "Cancel outcome",
        readOnlyHint: false,
        destructiveHint: true,
      },
      settle_outcome: {
        title: "Settle outcome",
        readOnlyHint: false,
        destructiveHint: false,
      },
      get_receipt: {
        title: "Get outcome receipt",
        readOnlyHint: true,
        destructiveHint: false,
      },
      wait_outcome: {
        title: "Wait for outcome",
        readOnlyHint: true,
        destructiveHint: false,
      },
      verify_attestation: {
        title: "Verify routing attestation",
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
      upload_asset: {
        title: "Upload generation asset",
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

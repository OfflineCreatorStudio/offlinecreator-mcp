import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { after, describe, it } from "node:test";
import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  METHOD_NOT_FOUND,
  PROTOCOL_VERSION_META_KEY,
  SERVER_INFO_META_KEY,
  createMcpHandler,
} from "@modelcontextprotocol/server";
import {
  StdioServerTransport,
  serveStdio,
} from "@modelcontextprotocol/server/stdio";
import {
  MCP_SERVER_INFO,
  PUBLISHED_MCP_RELEASE,
  TOOL_SCOPES,
  createOfflineCreatorServer,
} from "./server.js";

const ALL_TOOL_NAMES = Object.keys(TOOL_SCOPES);
const MODELS_READ_TOOLS = ALL_TOOL_NAMES.filter(
  (name) => TOOL_SCOPES[name] === "models" || TOOL_SCOPES[name] === "read",
);
const GENERATE_TOOLS = ALL_TOOL_NAMES.filter(
  (name) => TOOL_SCOPES[name] === "generate",
);
const TASK_METHODS = [
  "tasks/list",
  "tasks/get",
  "tasks/result",
  "tasks/cancel",
] as const;

// The locked SDK 2.0.0 advertises this modern revision from server/discover.
// Tests read it back from the SDK response; server/worker production code
// does not define the date string.
const SDK_MODERN_PROTOCOL_VERSION = "2026-07-28";
const LEGACY_PROTOCOL_VERSION = "2025-11-25";

function createServer(scopes?: string[]) {
  return createOfflineCreatorServer(
    {
      apiKey: "oc_test_protocol",
      apiBase: "https://offlinecreatorstudio.com",
    },
    scopes ? { scopes } : undefined,
  );
}

function modernMeta() {
  return {
    [PROTOCOL_VERSION_META_KEY]: SDK_MODERN_PROTOCOL_VERSION,
    [CLIENT_INFO_META_KEY]: {
      name: "protocol-compatibility-test",
      version: "0.0.0",
    },
    [CLIENT_CAPABILITIES_META_KEY]: {},
  };
}

function parseSseJson(text: string) {
  const line = text.split("\n").find((entry) => entry.startsWith("data: "));
  assert.ok(line, `expected SSE data line, got: ${text.slice(0, 200)}`);
  return JSON.parse(line.slice(6)) as Record<string, unknown>;
}

async function parseMcpResponse(response: Response) {
  const text = await response.text();
  const contentType = response.headers.get("content-type") ?? "";
  const body = contentType.includes("event-stream")
    ? parseSseJson(text)
    : (JSON.parse(text) as Record<string, unknown>);
  return { status: response.status, contentType, body };
}

async function postHttp(
  handler: { fetch: (request: Request) => Promise<Response> },
  method: string,
  params: Record<string, unknown> | undefined,
  extraHeaders: Record<string, string> = {},
) {
  return parseMcpResponse(
    await handler.fetch(
      new Request("https://mcp.offlinecreatorstudio.com/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-method": method,
          ...extraHeaders,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method,
          params,
        }),
      }),
    ),
  );
}

async function postModern(
  handler: { fetch: (request: Request) => Promise<Response> },
  method: string,
  params: Record<string, unknown> = {},
) {
  return postHttp(
    handler,
    method,
    { ...params, _meta: modernMeta() },
    { "MCP-Protocol-Version": SDK_MODERN_PROTOCOL_VERSION },
  );
}

function toolNames(body: Record<string, unknown>) {
  const result = body.result as { tools?: { name: string }[] } | undefined;
  return (result?.tools ?? []).map((tool) => tool.name);
}

async function stdioExchange(method: string, params: Record<string, unknown>) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const transport = new StdioServerTransport(stdin, stdout);
  const handle = serveStdio(() => createServer(), { transport });
  const chunks: string[] = [];
  stdout.on("data", (chunk: Buffer | string) => {
    chunks.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
  });

  try {
    stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })}\n`,
    );
    const started = Date.now();
    let text = "";
    while (Date.now() - started < 2000) {
      text = chunks.join("");
      if (text.includes('"id":1') || text.includes('"error"')) {
        return JSON.parse(text.trim().split("\n").at(-1) ?? text) as Record<
          string,
          unknown
        >;
      }
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
    throw new Error(`stdio ${method} timed out: ${text}`);
  } finally {
    await handle.close();
    stdin.end();
    stdout.end();
  }
}

describe("MCP 2026-07-28 protocol compatibility", () => {
  const http = createMcpHandler(() => createServer());
  after(() => http.close());

  it("answers modern server/discover without an initialize handshake", async () => {
    const { status, body } = await postModern(http, "server/discover");
    const result = body.result as {
      supportedVersions?: string[];
      capabilities?: { tools?: unknown; tasks?: unknown };
      _meta?: Record<string, unknown>;
    };
    assert.equal(status, 200);
    assert.deepEqual(result.supportedVersions, [SDK_MODERN_PROTOCOL_VERSION]);
    assert.ok(result.capabilities?.tools);
    assert.equal(result.capabilities?.tasks, undefined);
    assert.deepEqual(result._meta?.[SERVER_INFO_META_KEY], MCP_SERVER_INFO);
  });

  it("still answers the 2025-era initialize handshake via SDK legacy fallback", async () => {
    const { status, body } = await postHttp(http, "initialize", {
      protocolVersion: LEGACY_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "protocol-compatibility-test", version: "0.0.0" },
    });
    const result = body.result as {
      protocolVersion?: string;
      serverInfo?: { name?: string; version?: string };
      capabilities?: { tasks?: unknown };
    };
    assert.equal(status, 200);
    assert.equal(result.protocolVersion, LEGACY_PROTOCOL_VERSION);
    assert.deepEqual(result.serverInfo, MCP_SERVER_INFO);
    assert.equal(result.capabilities?.tasks, undefined);
  });

  it("the published surface (hosted /mcp) keeps the published release's tools and version", async () => {
    const published = createMcpHandler(() =>
      createOfflineCreatorServer(
        {
          apiKey: "oc_test_protocol",
          apiBase: "https://offlinecreatorstudio.com",
        },
        { surface: "published" },
      ),
    );
    const listed = await postModern(published, "tools/list");
    assert.equal(listed.status, 200);
    const names = toolNames(listed.body);
    // 0.1.5 is the tracked npm release, so nothing is held back.
    assert.equal(names.length, 20);
    assert.equal(names.includes("cancel_outcome"), true);
    assert.deepEqual(
      names.slice().sort(),
      ALL_TOOL_NAMES.filter(
        (name) => !PUBLISHED_MCP_RELEASE.unreleasedTools.includes(name),
      ).sort(),
    );
    const init = await postHttp(published, "initialize", {
      protocolVersion: LEGACY_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "protocol-compatibility-test", version: "0.0.0" },
    });
    const serverInfo = (
      init.body.result as { serverInfo?: { version?: string } }
    ).serverInfo;
    assert.equal(serverInfo?.version, PUBLISHED_MCP_RELEASE.version);
    assert.equal(PUBLISHED_MCP_RELEASE.version, MCP_SERVER_INFO.version);
  });

  it("lists the same twenty tools on modern HTTP, scoped HTTP, and legacy HTTP", async () => {
    const modern = await postModern(http, "tools/list");
    const legacy = await postHttp(http, "tools/list", {});
    assert.equal(modern.status, 200);
    assert.equal(legacy.status, 200);
    assert.deepEqual(
      toolNames(modern.body).sort(),
      ALL_TOOL_NAMES.slice().sort(),
    );
    assert.deepEqual(
      toolNames(legacy.body).sort(),
      ALL_TOOL_NAMES.slice().sort(),
    );
    assert.equal(toolNames(modern.body).length, 20);
    assert.equal(toolNames(modern.body).includes("cancel_outcome"), true);
    assert.equal(
      toolNames(modern.body).some((name) => name.startsWith("tasks")),
      false,
    );
  });

  it("filters models+read to thirteen tools and omits generate-scoped tools", async () => {
    const scoped = createMcpHandler(() => createServer(["models", "read"]));
    try {
      const { status, body } = await postModern(scoped, "tools/list");
      const names = toolNames(body);
      assert.equal(status, 200);
      assert.equal(names.length, 13);
      assert.deepEqual(names.sort(), MODELS_READ_TOOLS.slice().sort());
      for (const name of GENERATE_TOOLS) {
        assert.equal(names.includes(name), false);
      }
    } finally {
      await scoped.close();
    }
  });

  it("leaves MCP Tasks methods unsupported on the modern HTTP path", async () => {
    for (const method of TASK_METHODS) {
      const { status, body } = await postModern(http, method);
      const error = body.error as { code?: number; message?: string };
      assert.equal(status, 404);
      assert.equal(error.code, METHOD_NOT_FOUND);
      assert.match(error.message ?? "", /method not found/i);
    }
  });

  it("maps protocol-version and unknown-method errors fail-closed", async () => {
    const mismatch = await postHttp(
      http,
      "server/discover",
      { _meta: modernMeta() },
      { "MCP-Protocol-Version": LEGACY_PROTOCOL_VERSION },
    );
    const mismatchError = mismatch.body.error as { code?: number };
    assert.equal(mismatch.status, 400);
    assert.equal(mismatchError.code, -32020);

    const missingEnvelope = await postHttp(
      http,
      "tools/list",
      {},
      { "MCP-Protocol-Version": SDK_MODERN_PROTOCOL_VERSION },
    );
    const envelopeError = missingEnvelope.body.error as { code?: number };
    assert.equal(envelopeError.code, -32602);

    const unsupported = await postHttp(
      http,
      "server/discover",
      {
        _meta: {
          ...modernMeta(),
          [PROTOCOL_VERSION_META_KEY]: "2099-01-01",
        },
      },
      { "MCP-Protocol-Version": "2099-01-01" },
    );
    const unsupportedError = unsupported.body.error as {
      code?: number;
      data?: { supported?: string[]; requested?: string };
    };
    assert.equal(unsupportedError.code, -32022);
    assert.deepEqual(unsupportedError.data?.supported, [
      SDK_MODERN_PROTOCOL_VERSION,
    ]);
    assert.equal(unsupportedError.data?.requested, "2099-01-01");

    const unknown = await postModern(http, "not/a/method");
    const unknownError = unknown.body.error as { code?: number };
    assert.equal(unknown.status, 404);
    assert.equal(unknownError.code, METHOD_NOT_FOUND);
  });

  it("keeps HTTP session GET/DELETE unsupported under default stateless serving", async () => {
    for (const method of ["GET", "DELETE"] as const) {
      const response = await http.fetch(
        new Request("https://mcp.offlinecreatorstudio.com/mcp", { method }),
      );
      const { status, body } = await parseMcpResponse(response);
      const error = body.error as { code?: number; message?: string };
      assert.equal(status, 405);
      assert.equal(error.code, -32000);
      assert.match(error.message ?? "", /method not allowed/i);
    }
  });

  it("serves initialize and server/discover on stdio from the same factory", async () => {
    const initialized = await stdioExchange("initialize", {
      protocolVersion: LEGACY_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "protocol-compatibility-test", version: "0.0.0" },
    });
    const initResult = initialized.result as {
      protocolVersion?: string;
      serverInfo?: { name?: string };
    };
    assert.equal(initResult.protocolVersion, LEGACY_PROTOCOL_VERSION);
    assert.equal(initResult.serverInfo?.name, MCP_SERVER_INFO.name);

    const discovered = await stdioExchange("server/discover", {
      _meta: modernMeta(),
    });
    const discoverResult = discovered.result as {
      supportedVersions?: string[];
      capabilities?: { tasks?: unknown };
    };
    assert.deepEqual(discoverResult.supportedVersions, [
      SDK_MODERN_PROTOCOL_VERSION,
    ]);
    assert.equal(discoverResult.capabilities?.tasks, undefined);
  });
});

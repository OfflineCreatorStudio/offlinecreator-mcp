import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  A2A_METHODS,
  MemoryA2ATaskStore,
  handleA2ARequest,
  projectGenerationState,
  type A2ATaskStore,
} from "./a2a.js";
import { StudioApiClient } from "./client.js";

function client(
  handlers: Record<string, (input: Request) => Promise<Response> | Response>,
) {
  return new StudioApiClient({
    apiBase: "https://offlinecreatorstudio.com",
    fetcher: async (input, init) => {
      // Keep init: StudioApiClient passes the method and body there.
      const request =
        input instanceof Request ? input : new Request(String(input), init);
      const path = new URL(request.url).pathname;
      const handler = Object.entries(handlers).find(([prefix]) =>
        path.startsWith(prefix),
      )?.[1];
      if (!handler) return new Response("missing", { status: 404 });
      return handler(request);
    },
  });
}

/**
 * POST /api/v1/generations as the route answers it: startGeneration's result,
 * which carries generationId and no id (src/lib/generation-service.ts).
 */
function startedGeneration(
  generationId: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    generationId,
    requestId: "fal-request-1",
    status: "queued",
    demo: false,
    quote: {
      customerCredits: 4,
      retailUsd: 0.04,
      lockedQuoteToken: "q".repeat(48),
      expiresAt: 1_790_000_000_000,
    },
    selectedProvider: "fal",
    providerDisclosure: "Generated through fal.ai.",
    creditsRemaining: 96,
    ...overrides,
  };
}

/** GET /api/v1/generations/{id} as getGenerationStatus answers it. */
function generationStatus(
  generationId: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    generationId,
    status: "processing",
    outputUrl: null,
    outputContentType: null,
    createdAt: "2026-09-28T00:00:00.000Z",
    modelId: "flux-schnell",
    prompt: "A product photograph",
    credits: 4,
    selectedProvider: "fal",
    providerRouteId: "fal-flux-schnell",
    providerDisclosure: "Generated through fal.ai.",
    actualWholesaleCostUsd: null,
    ...overrides,
  };
}

function generateParams(
  messageId: string,
  data: Record<string, unknown> = {},
  configuration?: Record<string, unknown>,
) {
  return {
    message: {
      messageId,
      role: "user",
      parts: [
        {
          data: {
            operation: "generate",
            modelId: "flux-schnell",
            prompt: "A product photograph",
            ...data,
          },
          mediaType: "application/json",
        },
      ],
    },
    ...(configuration ? { configuration } : {}),
  };
}

async function rpc(
  method: string,
  params: unknown,
  options: {
    client?: StudioApiClient;
    store?: MemoryA2ATaskStore;
    scopes?: string[];
    version?: string;
    userId?: string;
  } = {},
) {
  const store = options.store ?? new MemoryA2ATaskStore();
  const response = await handleA2ARequest({
    request: new Request("https://mcp.offlinecreatorstudio.com/mcp/a2a", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "a2a-version": options.version ?? "1.0",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method,
        params,
      }),
    }),
    auth: {
      userId: options.userId ?? "user-1",
      scopes: options.scopes ?? ["models", "read", "generate"],
    },
    client: options.client ?? client({}),
    store,
  });
  return {
    store,
    status: response.status,
    body: (await response.json()) as {
      result?: Record<string, unknown>;
      error?: { code: number; message: string };
    },
  };
}

describe("A2A protocol", () => {
  it("projects generation statuses honestly", () => {
    assert.equal(projectGenerationState("queued"), "TASK_STATE_SUBMITTED");
    assert.equal(projectGenerationState("processing"), "TASK_STATE_WORKING");
    assert.equal(projectGenerationState("completed"), "TASK_STATE_COMPLETED");
    assert.equal(projectGenerationState("failed"), "TASK_STATE_FAILED");
    assert.equal(projectGenerationState("canceled"), "TASK_STATE_CANCELED");
  });

  it("rejects missing A2A 1.0 version headers", async () => {
    const { body } = await rpc(A2A_METHODS.sendMessage, {}, { version: "" });
    assert.equal(body.error?.code, -32009);
  });

  it("rejects streaming and push methods", async () => {
    const streaming = await rpc(A2A_METHODS.sendStreamingMessage, {});
    assert.equal(streaming.body.error?.code, -32004);
    const push = await rpc(A2A_METHODS.createPushConfig, {});
    assert.equal(push.body.error?.code, -32003);
  });

  it("returns a direct model catalog message", async () => {
    const { body } = await rpc(
      A2A_METHODS.sendMessage,
      {
        message: {
          messageId: "msg-models",
          role: "user",
          parts: [
            {
              data: { operation: "list_models" },
              mediaType: "application/json",
            },
          ],
        },
      },
      {
        client: client({
          "/api/v1/models": () =>
            Response.json({ models: [{ id: "flux-schnell" }] }),
        }),
      },
    );
    const message = body.result?.message as {
      parts: Array<{ data: { models: Array<{ id?: string }> } }>;
    };
    assert.equal(message.parts[0]?.data.models[0]?.id, "flux-schnell");
  });

  it("creates a generation task and replays duplicate message IDs", async () => {
    const store = new MemoryA2ATaskStore();
    const studio = client({
      "/api/v1/generations": async (request) => {
        if (
          request.method === "POST" &&
          new URL(request.url).pathname === "/api/v1/generations"
        ) {
          return Response.json(
            startedGeneration("11111111-1111-4111-8111-111111111111"),
          );
        }
        return Response.json(
          generationStatus("11111111-1111-4111-8111-111111111111", {
            status: "completed",
            outputUrl: "/api/v1/assets/out",
            outputContentType: "image/png",
          }),
        );
      },
    });
    const params = {
      message: {
        messageId: "msg-gen",
        role: "user",
        parts: [
          {
            data: {
              operation: "generate",
              modelId: "flux-schnell",
              prompt: "A product photograph",
            },
            mediaType: "application/json",
          },
        ],
      },
      configuration: { returnImmediately: true },
    };
    const first = await rpc(A2A_METHODS.sendMessage, params, {
      client: studio,
      store,
    });
    const firstTask = first.body.result?.task as { id: string };
    const second = await rpc(A2A_METHODS.sendMessage, params, {
      client: studio,
      store,
    });
    const secondTask = second.body.result?.task as { id: string };
    assert.equal(firstTask.id, secondTask.id);
  });

  it("isolates tasks by user", async () => {
    const store = new MemoryA2ATaskStore();
    const studio = client({
      "/api/v1/generations": () =>
        Response.json(
          startedGeneration("22222222-2222-4222-8222-222222222222"),
        ),
    });
    const created = await rpc(
      A2A_METHODS.sendMessage,
      {
        message: {
          messageId: "owned",
          role: "user",
          parts: [
            {
              data: {
                operation: "generate",
                modelId: "flux-schnell",
                prompt: "hello",
              },
              mediaType: "application/json",
            },
          ],
        },
        configuration: { returnImmediately: true },
      },
      { client: studio, store, userId: "owner" },
    );
    const taskId = (created.body.result?.task as { id: string }).id;
    const other = await rpc(
      A2A_METHODS.getTask,
      { id: taskId },
      { client: studio, store, userId: "other" },
    );
    assert.equal(other.body.error?.code, -32001);
  });

  it("paginates tasks and blocks cancel after work starts", async () => {
    const store = new MemoryA2ATaskStore();
    const studio = client({
      "/api/v1/generations": (request) => {
        if (
          request.method === "POST" &&
          new URL(request.url).pathname.endsWith("/cancel")
        ) {
          return Response.json({ status: "canceled" });
        }
        if (request.method === "POST") {
          return Response.json(startedGeneration(crypto.randomUUID()));
        }
        return Response.json({ status: "processing" });
      },
    });
    for (const index of [1, 2, 3]) {
      await rpc(
        A2A_METHODS.sendMessage,
        {
          message: {
            messageId: `page-${index}`,
            role: "user",
            parts: [
              {
                data: {
                  operation: "generate",
                  modelId: "flux-schnell",
                  prompt: `item ${index}`,
                },
                mediaType: "application/json",
              },
            ],
          },
          configuration: { returnImmediately: true },
        },
        { client: studio, store },
      );
    }
    const firstPage = await rpc(
      A2A_METHODS.listTasks,
      { pageSize: 2 },
      { client: studio, store },
    );
    const listed = firstPage.body.result as {
      tasks: Array<{ id: string }>;
      nextPageToken: string;
      totalSize: number;
    };
    assert.equal(listed.tasks.length, 2);
    assert.equal(listed.totalSize, 3);
    assert.ok(listed.nextPageToken);
    const working = await store.getById("user-1", listed.tasks[0].id);
    assert.ok(working);
    await store.save({ ...working, state: "TASK_STATE_WORKING" });
    const canceled = await rpc(
      A2A_METHODS.cancelTask,
      { id: working.taskId },
      { client: studio, store },
    );
    assert.equal(canceled.body.error?.code, -32002);
  });

  it("maps a 409 from generation cancel to TaskNotCancelable (0.1.4)", async () => {
    const store = new MemoryA2ATaskStore();
    const studio = client({
      "/api/v1/generations": (request) => {
        if (new URL(request.url).pathname.endsWith("/cancel")) {
          return Response.json(
            {
              error: "This generation is already running at its provider.",
              code: "CONFLICT",
              cancellable: false,
              reason: "in_flight",
            },
            { status: 409 },
          );
        }
        return Response.json(
          startedGeneration(crypto.randomUUID(), {
            status: "reserved",
            uploadRequired: true,
          }),
        );
      },
    });
    const generationId = crypto.randomUUID();
    await store.save({
      taskId: "task-409",
      generationId,
      contextId: "ctx",
      messageId: "message-409",
      userId: "user-1",
      operation: "generate",
      state: "TASK_STATE_SUBMITTED",
      statusMessage: "Submitted.",
      statusTimestamp: Date.now(),
      history: [],
      artifacts: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    const canceled = await rpc(
      A2A_METHODS.cancelTask,
      { id: "task-409" },
      { client: studio, store },
    );
    assert.equal(canceled.body.error?.code, -32002);
    const data = (
      canceled.body.error as
        { data?: Array<Record<string, unknown>> } | undefined
    )?.data;
    assert.equal(data?.[0]?.["@type"], "TaskNotCancelableError");
    assert.equal(
      (await store.getById("user-1", "task-409"))?.state,
      "TASK_STATE_SUBMITTED",
    );
  });

  for (const [label, status, answer, expectedState] of [
    [
      "marks the task canceled only when Studio confirms the cancel",
      200,
      { cancelled: true, alreadyCancelled: false, creditsRefunded: 4 },
      "TASK_STATE_CANCELED",
    ],
    [
      "keeps the task's state when Studio only requested a provider cancel (202)",
      202,
      { cancelled: false, cancellationRequested: true, status: "queued" },
      "TASK_STATE_SUBMITTED",
    ],
  ] as const) {
    it(label, async () => {
      const store = new MemoryA2ATaskStore();
      const studio = client({
        "/api/v1/generations": (request) => {
          if (new URL(request.url).pathname.endsWith("/cancel")) {
            return Response.json(answer, { status });
          }
          return Response.json(startedGeneration(crypto.randomUUID()));
        },
      });
      await store.save({
        taskId: "task-cancel",
        generationId: crypto.randomUUID(),
        contextId: "ctx",
        messageId: "message-cancel",
        userId: "user-1",
        operation: "generate",
        state: "TASK_STATE_SUBMITTED",
        statusMessage: "Submitted.",
        statusTimestamp: Date.now(),
        history: [],
        artifacts: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      const result = await rpc(
        A2A_METHODS.cancelTask,
        { id: "task-cancel" },
        { client: studio, store },
      );
      assert.equal(result.body.error, undefined);
      const saved = await store.getById("user-1", "task-cancel");
      assert.equal(saved?.state, expectedState);
      if (expectedState === "TASK_STATE_SUBMITTED") {
        assert.match(saved?.statusMessage ?? "", /Cancellation requested/);
      }
    });
  }

  for (const [label, generation, expectedState] of [
    [
      "reads a generation stopped after a 202 as canceled, not failed",
      { status: "failed", cancelled: true },
      "TASK_STATE_CANCELED",
    ],
    [
      "still reads a provider failure as failed",
      { status: "failed" },
      "TASK_STATE_FAILED",
    ],
  ] as const) {
    it(label, async () => {
      const store = new MemoryA2ATaskStore();
      const generationId = crypto.randomUUID();
      const studio = client({
        "/api/v1/generations": () =>
          Response.json(generationStatus(generationId, generation)),
      });
      await store.save({
        taskId: "task-settled",
        generationId,
        contextId: "ctx",
        messageId: "message-settled",
        userId: "user-1",
        operation: "generate",
        state: "TASK_STATE_SUBMITTED",
        statusMessage: "Cancellation requested.",
        statusTimestamp: Date.now(),
        history: [],
        artifacts: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      const result = await rpc(
        A2A_METHODS.getTask,
        { id: "task-settled" },
        { client: studio, store },
      );
      assert.equal(result.body.error, undefined);
      assert.equal(
        (await store.getById("user-1", "task-settled"))?.state,
        expectedState,
      );
    });
  }

  it("tracks the generationId Studio returns, never a made-up id", async () => {
    const generationId = "33333333-3333-4333-8333-333333333333";
    const reads: string[] = [];
    const studio = client({
      "/api/v1/generations": (request) => {
        const path = new URL(request.url).pathname;
        if (request.method === "POST") {
          return Response.json(startedGeneration(generationId));
        }
        reads.push(path);
        // Studio answers 404 for any id it did not issue.
        if (path !== `/api/v1/generations/${generationId}`) {
          return Response.json(
            { error: "Generation not found.", code: "NOT_FOUND" },
            { status: 404 },
          );
        }
        return Response.json(
          generationStatus(generationId, {
            status: "completed",
            outputUrl: `https://offlinecreatorstudio.com/api/download/${generationId}/output?expires=1&token=t`,
            outputContentType: "image/png",
          }),
        );
      },
    });
    const { body } = await rpc(
      A2A_METHODS.sendMessage,
      generateParams("msg-real-shape"),
      {
        client: studio,
      },
    );
    assert.equal(body.error, undefined);
    const task = body.result?.task as {
      status: { state: string };
      metadata: { generationId: string };
      artifacts: Array<{ artifactId: string }>;
    };
    assert.equal(task.metadata.generationId, generationId);
    assert.equal(task.status.state, "TASK_STATE_COMPLETED");
    assert.equal(task.artifacts[0]?.artifactId, `output:${generationId}`);
    assert.deepEqual(reads, [`/api/v1/generations/${generationId}`]);
  });

  it("polls and cancels the real generation after a SendMessage with the real shape", async () => {
    const generationId = "66666666-6666-4666-8666-666666666666";
    const calls: string[] = [];
    const studio = client({
      "/api/v1/generations": (request) => {
        const path = new URL(request.url).pathname;
        calls.push(`${request.method} ${path}`);
        if (request.method === "POST" && path === "/api/v1/generations") {
          return Response.json(startedGeneration(generationId));
        }
        // Studio answers 404 for any id it did not issue.
        if (!path.startsWith(`/api/v1/generations/${generationId}`)) {
          return Response.json(
            { error: "Generation not found.", code: "NOT_FOUND" },
            { status: 404 },
          );
        }
        if (path.endsWith("/cancel")) {
          return Response.json({
            ok: true,
            status: "failed",
            generationId,
            cancelled: true,
            alreadyCancelled: false,
            creditsRefunded: 4,
          });
        }
        // Still queued: a task is cancelable only before work starts.
        return Response.json(
          generationStatus(generationId, { status: "queued" }),
        );
      },
    });
    const store = new MemoryA2ATaskStore();
    const sent = await rpc(
      A2A_METHODS.sendMessage,
      generateParams("msg-poll-cancel", {}, { returnImmediately: true }),
      { client: studio, store },
    );
    assert.equal(sent.body.error, undefined);
    const task = sent.body.result?.task as {
      id: string;
      status: { state: string };
      metadata: { generationId: string };
    };
    assert.equal(task.metadata.generationId, generationId);
    assert.equal(task.status.state, "TASK_STATE_SUBMITTED");

    const polled = await rpc(
      A2A_METHODS.getTask,
      { id: task.id },
      { client: studio, store },
    );
    assert.equal(polled.body.error, undefined);
    assert.equal(
      (polled.body.result as { status: { state: string } }).status.state,
      "TASK_STATE_SUBMITTED",
    );

    const canceled = await rpc(
      A2A_METHODS.cancelTask,
      { id: task.id },
      { client: studio, store },
    );
    assert.equal(canceled.body.error, undefined);
    assert.equal(
      (await store.getById("user-1", task.id))?.state,
      "TASK_STATE_CANCELED",
    );
    assert.deepEqual(calls, [
      "POST /api/v1/generations",
      `GET /api/v1/generations/${generationId}`,
      `POST /api/v1/generations/${generationId}/cancel`,
    ]);
  });

  it("still accepts an id field from older Studio responses", async () => {
    const generationId = "44444444-4444-4444-8444-444444444444";
    const studio = client({
      "/api/v1/generations": () =>
        Response.json({ id: generationId, status: "queued" }),
    });
    const { body } = await rpc(
      A2A_METHODS.sendMessage,
      generateParams("msg-legacy-id", {}, { returnImmediately: true }),
      { client: studio },
    );
    const task = body.result?.task as { metadata: { generationId: string } };
    assert.equal(task.metadata.generationId, generationId);
  });

  it("fails the task closed when Studio returns no generationId", async () => {
    let reads = 0;
    const studio = client({
      "/api/v1/generations": (request) => {
        if (request.method === "POST") {
          const { generationId: _omitted, ...rest } = startedGeneration(
            "55555555-5555-4555-8555-555555555555",
          );
          return Response.json(rest);
        }
        reads += 1;
        return Response.json(
          { error: "Generation not found.", code: "NOT_FOUND" },
          { status: 404 },
        );
      },
    });
    const store = new MemoryA2ATaskStore();
    const { body } = await rpc(
      A2A_METHODS.sendMessage,
      generateParams("msg-no-id"),
      {
        client: studio,
        store,
      },
    );
    assert.equal(body.error, undefined);
    const task = body.result?.task as {
      id: string;
      status: { state: string; message: { parts: Array<{ text: string }> } };
      metadata: { generationId: string | null };
    };
    assert.equal(task.status.state, "TASK_STATE_FAILED");
    assert.equal(task.metadata.generationId, null);
    assert.match(
      task.status.message.parts[0]?.text ?? "",
      /charge may have occurred/,
    );
    assert.match(task.status.message.parts[0]?.text ?? "", /list_generations/);
    assert.equal(reads, 0);
    // A resend of the message replays the failed task instead of paying again.
    const replay = await rpc(
      A2A_METHODS.sendMessage,
      generateParams("msg-no-id"),
      {
        client: studio,
        store,
      },
    );
    assert.equal((replay.body.result?.task as { id: string }).id, task.id);
  });

  it("claims the messageId first, so a concurrent resend never generates twice", async () => {
    let posts = 0;
    const studio = client({
      "/api/v1/generations": async (request) => {
        if (request.method !== "POST") {
          return Response.json(
            generationStatus("66666666-6666-4666-8666-666666666666"),
          );
        }
        posts += 1;
        // Studio is still reserving when the retry arrives.
        await new Promise((resolve) => setTimeout(resolve, 20));
        return Response.json(
          startedGeneration("66666666-6666-4666-8666-666666666666"),
        );
      },
    });
    const store = new MemoryA2ATaskStore();
    const params = generateParams("msg-race", {}, { returnImmediately: true });
    const [first, second] = await Promise.all([
      rpc(A2A_METHODS.sendMessage, params, { client: studio, store }),
      rpc(A2A_METHODS.sendMessage, params, { client: studio, store }),
    ]);
    assert.equal(posts, 1);
    assert.equal(first.body.error, undefined);
    assert.equal(second.body.error, undefined);
    assert.equal(
      (first.body.result?.task as { id: string }).id,
      (second.body.result?.task as { id: string }).id,
    );
    const listed = await store.list("user-1", { pageSize: 10 });
    assert.equal(listed.totalSize, 1);
    assert.equal(
      listed.tasks[0]?.generationId,
      "66666666-6666-4666-8666-666666666666",
    );
  });

  it("still runs on a task store written before claim existed", async () => {
    const memory = new MemoryA2ATaskStore();
    // Only the methods an earlier version of A2ATaskStore required.
    const legacy: A2ATaskStore = {
      getByMessageId: (userId, messageId) =>
        memory.getByMessageId(userId, messageId),
      getById: (userId, taskId) => memory.getById(userId, taskId),
      save: (record) => memory.save(record),
      list: (userId, query) => memory.list(userId, query),
    };
    let posts = 0;
    const studio = client({
      "/api/v1/generations": () => {
        posts += 1;
        if (posts === 1) {
          return Response.json(
            { error: "Not enough credits.", code: "INSUFFICIENT_CREDITS" },
            { status: 402 },
          );
        }
        return Response.json(
          startedGeneration("7a7a7a7a-7a7a-4a7a-8a7a-7a7a7a7a7a7a"),
        );
      },
    });
    const params = generateParams(
      "msg-legacy-store",
      {},
      { returnImmediately: true },
    );
    const send = async () => {
      const response = await handleA2ARequest({
        request: new Request("https://mcp.offlinecreatorstudio.com/mcp/a2a", {
          method: "POST",
          headers: { "content-type": "application/json", "a2a-version": "1.0" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: A2A_METHODS.sendMessage,
            params,
          }),
        }),
        auth: { userId: "user-1", scopes: ["models", "read", "generate"] },
        client: studio,
        store: legacy,
      });
      return (await response.json()) as {
        result?: { task: { metadata: { generationId: string } } };
        error?: { message: string };
      };
    };
    const refused = await send();
    assert.equal(refused.error?.message, "Not enough credits.");
    assert.equal(
      await memory.getByMessageId("user-1", "msg-legacy-store"),
      null,
    );
    const started = await send();
    assert.equal(
      started.result?.task.metadata.generationId,
      "7a7a7a7a-7a7a-4a7a-8a7a-7a7a7a7a7a7a",
    );
  });

  it("does not bind a bare id in an error body as the generation", async () => {
    // A refusal can carry a request or correlation `id`. Only `generationId`
    // names a generation there; a bare `id` must neither be tracked nor keep
    // the messageId claimed, or the message could never be resent.
    let posts = 0;
    const studio = client({
      "/api/v1/generations": () => {
        posts += 1;
        if (posts === 1) {
          return Response.json(
            {
              error: "Not enough credits.",
              code: "INSUFFICIENT_CREDITS",
              id: "8b8b8b8b-8b8b-4b8b-8b8b-8b8b8b8b8b8b",
            },
            { status: 402 },
          );
        }
        return Response.json(
          startedGeneration("9c9c9c9c-9c9c-4c9c-8c9c-9c9c9c9c9c9c"),
        );
      },
    });
    const store = new MemoryA2ATaskStore();
    const params = generateParams(
      "msg-error-id",
      {},
      { returnImmediately: true },
    );
    const refused = await rpc(A2A_METHODS.sendMessage, params, {
      client: studio,
      store,
    });
    assert.equal(refused.body.error?.message, "Not enough credits.");
    assert.equal(await store.getByMessageId("user-1", "msg-error-id"), null);
    const resent = await rpc(A2A_METHODS.sendMessage, params, {
      client: studio,
      store,
    });
    assert.equal(resent.body.error, undefined);
    assert.equal(
      (resent.body.result?.task as { metadata: { generationId: string } })
        .metadata.generationId,
      "9c9c9c9c-9c9c-4c9c-8c9c-9c9c9c9c9c9c",
    );
  });

  it("never claims through a task store that cannot release the claim", async () => {
    const memory = new MemoryA2ATaskStore();
    // claim without release: a refused message would stay claimed, later
    // read as a possible charge, and could never be sent again.
    const halfClaiming: A2ATaskStore = {
      getByMessageId: (userId, messageId) =>
        memory.getByMessageId(userId, messageId),
      getById: (userId, taskId) => memory.getById(userId, taskId),
      claim: (record) => memory.claim(record),
      save: (record) => memory.save(record),
      list: (userId, query) => memory.list(userId, query),
    };
    let posts = 0;
    const studio = client({
      "/api/v1/generations": () => {
        posts += 1;
        if (posts === 1) {
          return Response.json(
            { error: "Not enough credits.", code: "INSUFFICIENT_CREDITS" },
            { status: 402 },
          );
        }
        return Response.json(
          startedGeneration("9e9e9e9e-9e9e-4e9e-8e9e-9e9e9e9e9e9e"),
        );
      },
    });
    const params = generateParams(
      "msg-half-claim",
      {},
      { returnImmediately: true },
    );
    const send = async () => {
      const response = await handleA2ARequest({
        request: new Request("https://mcp.offlinecreatorstudio.com/mcp/a2a", {
          method: "POST",
          headers: { "content-type": "application/json", "a2a-version": "1.0" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: A2A_METHODS.sendMessage,
            params,
          }),
        }),
        auth: { userId: "user-1", scopes: ["models", "read", "generate"] },
        client: studio,
        store: halfClaiming,
      });
      return (await response.json()) as {
        result?: { task: { metadata: { generationId: string } } };
        error?: { message: string };
      };
    };
    const refused = await send();
    assert.equal(refused.error?.message, "Not enough credits.");
    assert.equal(await memory.getByMessageId("user-1", "msg-half-claim"), null);
    const started = await send();
    assert.equal(posts, 2);
    assert.equal(
      started.result?.task.metadata.generationId,
      "9e9e9e9e-9e9e-4e9e-8e9e-9e9e9e9e9e9e",
    );
  });

  it("frees the messageId when Studio refuses without reserving credits", async () => {
    let posts = 0;
    const studio = client({
      "/api/v1/generations": () => {
        posts += 1;
        if (posts === 1) {
          return Response.json(
            { error: "Not enough credits.", code: "INSUFFICIENT_CREDITS" },
            { status: 402 },
          );
        }
        return Response.json(
          startedGeneration("77777777-7777-4777-8777-777777777777"),
        );
      },
    });
    const store = new MemoryA2ATaskStore();
    const params = generateParams("msg-topup", {}, { returnImmediately: true });
    const refused = await rpc(A2A_METHODS.sendMessage, params, {
      client: studio,
      store,
    });
    assert.equal(refused.body.error?.code, -32603);
    assert.equal(refused.body.error?.message, "Not enough credits.");
    assert.equal(await store.getByMessageId("user-1", "msg-topup"), null);
    // After a top-up the same message goes through.
    const retried = await rpc(A2A_METHODS.sendMessage, params, {
      client: studio,
      store,
    });
    const task = retried.body.result?.task as {
      metadata: { generationId: string };
    };
    assert.equal(
      task.metadata.generationId,
      "77777777-7777-4777-8777-777777777777",
    );
    assert.equal(posts, 2);
  });

  for (const [label, answer] of [
    [
      "a dropped connection",
      () => Promise.reject(new TypeError("fetch failed")),
    ],
    [
      "an untyped 5xx",
      () =>
        Response.json(
          { error: "The request could not be completed." },
          { status: 500 },
        ),
    ],
  ] as const) {
    it(`fails closed and keeps the claim after ${label}`, async () => {
      let posts = 0;
      const studio = client({
        "/api/v1/generations": () => {
          posts += 1;
          return answer();
        },
      });
      const store = new MemoryA2ATaskStore();
      const params = generateParams(
        "msg-unknown",
        {},
        { returnImmediately: true },
      );
      const first = await rpc(A2A_METHODS.sendMessage, params, {
        client: studio,
        store,
      });
      assert.equal(first.body.error, undefined);
      const task = first.body.result?.task as {
        id: string;
        status: { state: string; message: { parts: Array<{ text: string }> } };
      };
      assert.equal(task.status.state, "TASK_STATE_FAILED");
      assert.match(
        task.status.message.parts[0]?.text ?? "",
        /charge may have occurred/,
      );
      const resent = await rpc(A2A_METHODS.sendMessage, params, {
        client: studio,
        store,
      });
      assert.equal((resent.body.result?.task as { id: string }).id, task.id);
      assert.equal(posts, 1);
    });
  }

  it("tracks the generation an error response names", async () => {
    const generationId = "88888888-8888-4888-8888-888888888888";
    const studio = client({
      "/api/v1/generations": () =>
        Response.json(
          {
            error:
              "The provider did not confirm submission. Studio will reconcile this attempt without submitting a duplicate.",
            code: "PROVIDER_UNAVAILABLE",
            ambiguousSubmission: true,
            generationId,
            retryAfter: 10,
          },
          { status: 503 },
        ),
    });
    const { body } = await rpc(
      A2A_METHODS.sendMessage,
      generateParams("msg-ambiguous", {}, { returnImmediately: true }),
      { client: studio },
    );
    assert.equal(body.error, undefined);
    const task = body.result?.task as {
      status: { state: string };
      metadata: { generationId: string };
    };
    assert.equal(task.status.state, "TASK_STATE_SUBMITTED");
    assert.equal(task.metadata.generationId, generationId);
  });

  it("fails a claim that never recorded its generation", async () => {
    const store = new MemoryA2ATaskStore();
    const stale = Date.now() - 11 * 60 * 1000;
    for (const [taskId, createdAt] of [
      ["task-stale", stale],
      ["task-fresh", Date.now()],
    ] as const) {
      await store.save({
        taskId,
        generationId: null,
        contextId: "ctx",
        messageId: `message-${taskId}`,
        userId: "user-1",
        operation: "generate",
        state: "TASK_STATE_SUBMITTED",
        statusMessage: "Starting the generation.",
        statusTimestamp: createdAt,
        history: [],
        artifacts: [],
        createdAt,
        updatedAt: createdAt,
      });
    }
    const staleTask = await rpc(
      A2A_METHODS.getTask,
      { id: "task-stale" },
      { store },
    );
    const fresh = await rpc(
      A2A_METHODS.getTask,
      { id: "task-fresh" },
      { store },
    );
    const staleState = staleTask.body.result?.status as {
      state: string;
      message: { parts: Array<{ text: string }> };
    };
    assert.equal(staleState.state, "TASK_STATE_FAILED");
    assert.match(staleState.message.parts[0]?.text ?? "", /list_generations/);
    assert.equal(
      (fresh.body.result?.status as { state: string }).state,
      "TASK_STATE_SUBMITTED",
    );
  });

  it("forwards maxCredits and quoteToken from the message data to Studio", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const studio = client({
      "/api/v1/generations": async (request) => {
        bodies.push((await request.json()) as Record<string, unknown>);
        return Response.json(
          startedGeneration("abababab-abab-4aba-8aba-abababababab"),
        );
      },
    });
    const quoteToken = "q".repeat(48);
    const { body } = await rpc(
      A2A_METHODS.sendMessage,
      generateParams(
        "msg-cap",
        { maxCredits: 5, quoteToken },
        { returnImmediately: true },
      ),
      { client: studio },
    );
    assert.equal(body.error, undefined);
    assert.equal(bodies.length, 1);
    assert.equal(bodies[0]?.maxCredits, 5);
    assert.equal(bodies[0]?.quoteToken, quoteToken);

    // Without them the request carries neither.
    await rpc(
      A2A_METHODS.sendMessage,
      generateParams("msg-no-cap", {}, { returnImmediately: true }),
      { client: studio },
    );
    assert.equal("maxCredits" in (bodies[1] ?? {}), false);
    assert.equal("quoteToken" in (bodies[1] ?? {}), false);
  });

  it("refuses a malformed spend ceiling instead of generating without it", async () => {
    let posts = 0;
    const studio = client({
      "/api/v1/generations": () => {
        posts += 1;
        return Response.json(
          startedGeneration("cdcdcdcd-cdcd-4cdc-8cdc-cdcdcdcdcdcd"),
        );
      },
    });
    const store = new MemoryA2ATaskStore();
    for (const [index, data] of [
      { maxCredits: 0 },
      { maxCredits: 2.5 },
      { maxCredits: "10" },
      { quoteToken: 42 },
    ].entries()) {
      const { body } = await rpc(
        A2A_METHODS.sendMessage,
        generateParams(`msg-bad-cap-${index}`, data),
        { client: studio, store },
      );
      assert.equal(body.error?.code, -32602);
    }
    assert.equal(posts, 0);
    assert.equal((await store.list("user-1", { pageSize: 10 })).totalSize, 0);
  });

  it("returns Studio's over-cap quote without charging or keeping the claim", async () => {
    const refusal = {
      error:
        "The locked quote costs 8 credits, above maxCredits 5. Nothing was charged.",
      code: "MAX_CREDITS_EXCEEDED",
      maxCredits: 5,
      customerCredits: 8,
      lockedQuoteToken: "q".repeat(48),
      expiresAt: 1_790_000_000_000,
    };
    const studio = client({
      "/api/v1/generations": () => Response.json(refusal, { status: 409 }),
    });
    const store = new MemoryA2ATaskStore();
    const { body } = await rpc(
      A2A_METHODS.sendMessage,
      generateParams("msg-over-cap", { maxCredits: 5 }),
      { client: studio, store },
    );
    const error = body.error as
      | { code: number; message: string; data?: Array<Record<string, unknown>> }
      | undefined;
    assert.equal(error?.code, -32603);
    assert.match(error?.message ?? "", /Nothing was charged/);
    assert.equal(error?.data?.[0]?.studioStatus, 409);
    assert.deepEqual(error?.data?.[0]?.studio, refusal);
    assert.equal(await store.getByMessageId("user-1", "msg-over-cap"), null);
  });

  for (const [label, cancel, note] of [
    [
      "releases the reservation it made",
      () =>
        Response.json({
          ok: true,
          status: "failed",
          generationId: "5a5a5a5a-5a5a-45a5-85a5-5a5a5a5a5a5a",
          cancelled: true,
          alreadyCancelled: false,
          creditsRefunded: 6,
        }),
      /were released/,
    ],
    [
      "says how to release it when Studio only requested the cancel",
      () =>
        Response.json(
          {
            ok: true,
            status: "reserved",
            cancelled: false,
            cancellationRequested: true,
          },
          { status: 202 },
        ),
      /Credits may still be reserved/,
    ],
    [
      "says how to release it when the cancel call fails",
      () =>
        Response.json(
          { error: "The request could not be completed." },
          { status: 500 },
        ),
      /could not be released/,
    ],
  ] as const) {
    it(`refuses an upload-required model and ${label}`, async () => {
      const generationId = "5a5a5a5a-5a5a-45a5-85a5-5a5a5a5a5a5a";
      const calls: string[] = [];
      const studio = client({
        "/api/v1/generations": (request) => {
          const path = new URL(request.url).pathname;
          calls.push(`${request.method} ${path}`);
          if (path.endsWith("/cancel")) return cancel();
          if (request.method === "POST") {
            // startGeneration's reply for a model with file inputs.
            return Response.json({
              generationId,
              status: "reserved",
              uploadRequired: true,
              inputSlots: [
                { key: "image", label: "Image", kind: "image", required: true },
              ],
              quote: startedGeneration(generationId).quote,
              creditsRemaining: 90,
            });
          }
          return Response.json(
            generationStatus(generationId, { status: "reserved" }),
          );
        },
      });
      const store = new MemoryA2ATaskStore();
      // No returnImmediately: a refused task must not wait out the poll loop.
      const params = generateParams("msg-upload", {
        modelId: "image-to-video",
      });
      const sent = await rpc(A2A_METHODS.sendMessage, params, {
        client: studio,
        store,
      });
      assert.equal(sent.body.error, undefined);
      const task = sent.body.result?.task as {
        id: string;
        status: { state: string; message: { parts: Array<{ text: string }> } };
        metadata: { generationId: string };
      };
      assert.equal(task.status.state, "TASK_STATE_REJECTED");
      const text = task.status.message.parts[0]?.text ?? "";
      assert.match(text, /does not accept file uploads/);
      assert.match(text, note);
      // The refused task stays bound to the real generation, so it can be found.
      assert.equal(task.metadata.generationId, generationId);
      assert.deepEqual(calls, [
        "POST /api/v1/generations",
        `POST /api/v1/generations/${generationId}/cancel`,
      ]);
      assert.equal(
        (await store.getById("user-1", task.id))?.state,
        "TASK_STATE_REJECTED",
      );

      // A resend returns the refused task: no second reservation, no second cancel.
      const resent = await rpc(A2A_METHODS.sendMessage, params, {
        client: studio,
        store,
      });
      const again = resent.body.result?.task as {
        id: string;
        status: { state: string };
      };
      assert.equal(again.id, task.id);
      assert.equal(again.status.state, "TASK_STATE_REJECTED");
      assert.equal(calls.length, 2);
    });
  }

  it("requires generate scopes", async () => {
    const denied = await rpc(
      A2A_METHODS.sendMessage,
      {
        message: {
          messageId: "no-scope",
          role: "user",
          parts: [
            {
              data: {
                operation: "generate",
                modelId: "flux-schnell",
                prompt: "nope",
              },
              mediaType: "application/json",
            },
          ],
        },
      },
      { scopes: ["models"] },
    );
    assert.equal(denied.body.error?.code, -32004);
  });
});

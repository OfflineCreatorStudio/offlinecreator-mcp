import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  REQUEST_TIMEOUT_MS,
  StudioApiClient,
  StudioApiTimeoutError,
  UPLOAD_TIMEOUT_MS,
  isTerminalOutcome,
} from "./client.js";

const HASH = "ab".repeat(32);

function recordingClient(
  respond: (request: { url: string; init: RequestInit }) => Response,
) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const client = new StudioApiClient({
    apiBase: "https://offlinecreatorstudio.com",
    apiKey: "oc_test_client",
    fetcher: async (input, init = {}) => {
      const call = { url: String(input), init };
      calls.push(call);
      return respond(call);
    },
  });
  return { client, calls };
}

describe("cancelOutcome (0.1.4)", () => {
  it("POSTs the cancel with no body by default and returns the state", async () => {
    const { client, calls } = recordingClient(() =>
      Response.json({
        outcome_status: "cancelled",
        cancellation: { state: "done" },
      }),
    );
    const result = await client.cancelOutcome({ hash: HASH.toUpperCase() });
    assert.equal(result.outcome_status, "cancelled");
    assert.equal(
      calls[0].url,
      `https://offlinecreatorstudio.com/api/v1/outcomes/${HASH}/cancel`,
    );
    assert.equal(calls[0].init.method, "POST");
    assert.equal(calls[0].init.body, undefined);
  });

  it("sends wait_seconds when asked and validates it", async () => {
    const { client, calls } = recordingClient(() =>
      Response.json({ outcome_status: "running" }, { status: 202 }),
    );
    await client.cancelOutcome({ hash: HASH, waitSeconds: 10 });
    assert.equal(calls[0].init.body, JSON.stringify({ wait_seconds: 10 }));
    await assert.rejects(
      client.cancelOutcome({ hash: HASH, waitSeconds: 26 }),
      /waitSeconds/,
    );
    await assert.rejects(client.cancelOutcome({ hash: "nope" }), /hash/);
  });

  it("surfaces a legacy_run refusal as a StudioApiError with its next links", async () => {
    const { client } = recordingClient(() =>
      Response.json(
        {
          code: "OUTCOME_NOT_CANCELLABLE",
          reason: "legacy_run",
          detail: "This order runs without an outcome hold.",
          next: [
            {
              rel: "cancel_generation",
              method: "POST",
              href: "/api/v1/generations/g/cancel",
              status: "ready",
            },
          ],
        },
        { status: 409 },
      ),
    );
    await assert.rejects(
      client.cancelOutcome({ hash: HASH }),
      (error: unknown) => {
        const failure = error as {
          status?: number;
          body?: { reason?: string };
        };
        assert.equal(failure.status, 409);
        assert.equal(failure.body?.reason, "legacy_run");
        return true;
      },
    );
  });
});

describe("waitOutcome reads outcome_status (0.1.4)", () => {
  it("treats finished orders as terminal and keeps waiting while a cancel drains", () => {
    const receipt = (run: Record<string, string>) => ({ run });
    assert.equal(
      isTerminalOutcome(
        receipt({ status: "failed", outcome_status: "cancelled" }),
      ),
      true,
    );
    assert.equal(
      isTerminalOutcome(
        receipt({ status: "failed", outcome_status: "partially_completed" }),
      ),
      true,
    );
    assert.equal(
      isTerminalOutcome(
        receipt({ status: "completed", outcome_status: "completed" }),
      ),
      true,
    );
    assert.equal(
      isTerminalOutcome(
        receipt({ status: "failed", outcome_status: "incomplete" }),
      ),
      true,
    );
    assert.equal(
      isTerminalOutcome(
        receipt({ status: "running", outcome_status: "running" }),
      ),
      false,
    );
    assert.equal(
      isTerminalOutcome(
        receipt({ status: "incomplete", outcome_status: "incomplete" }),
      ),
      false,
    );
    // When present, outcome_status decides even if run.status has not caught up.
    assert.equal(
      isTerminalOutcome(
        receipt({ status: "incomplete", outcome_status: "cancelled" }),
      ),
      true,
    );
    assert.equal(
      isTerminalOutcome(
        receipt({ status: "running", outcome_status: "partially_completed" }),
      ),
      true,
    );
    // Servers without outcome_status: run.status decides, as in 0.1.3.
    assert.equal(isTerminalOutcome(receipt({ status: "failed" })), true);
    assert.equal(isTerminalOutcome(receipt({ status: "running" })), false);
    assert.equal(isTerminalOutcome({}), false);
  });

  it("polls until a draining cancel finishes", async () => {
    const runs = [
      { status: "running", outcome_status: "running" },
      { status: "failed", outcome_status: "partially_completed" },
    ];
    let index = 0;
    const { client, calls } = recordingClient(() =>
      Response.json({
        hash: HASH,
        run: runs[Math.min(index++, runs.length - 1)],
      }),
    );
    const result = (await client.waitOutcome({
      hash: HASH,
      timeoutSeconds: 5,
      pollIntervalMs: 1,
    })) as {
      run: { outcome_status: string };
    };
    assert.equal(result.run.outcome_status, "partially_completed");
    assert.equal(calls.length, 2);
  });
});

const GENERATION_ID = "11111111-1111-4111-8111-111111111111";
const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

describe("request deadlines and upload bodies (0.1.5)", () => {
  function clientWith(
    fetcher: typeof fetch,
    timeouts: { requestTimeoutMs?: number; uploadTimeoutMs?: number },
  ) {
    return new StudioApiClient(
      {
        apiBase: "https://offlinecreatorstudio.com",
        apiKey: "oc_test_client",
        fetcher,
        readLocalImage: async () => ({
          bytes: PNG_BYTES,
          contentType: "image/png" as const,
          resolvedPath: "/root/still.png",
        }),
        readLocalAsset: async () => ({
          bytes: PNG_BYTES,
          contentType: "image/png",
          resolvedPath: "/root/still.png",
        }),
      },
      timeouts,
    );
  }

  it("keeps generous defaults, longer for uploads than for ordinary calls", () => {
    assert.ok(REQUEST_TIMEOUT_MS >= 60_000);
    assert.ok(UPLOAD_TIMEOUT_MS > REQUEST_TIMEOUT_MS);
  });

  it("times out a call whose fetch never answers, even when the fetcher ignores the signal", async () => {
    const client = clientWith(
      (() => new Promise<Response>(() => {})) as typeof fetch,
      {
        requestTimeoutMs: 25,
      },
    );
    await assert.rejects(client.getCredits(), (error) => {
      assert.ok(error instanceof StudioApiTimeoutError);
      assert.match(
        error.message,
        /timed out after \d+s \(GET \/api\/v1\/credits\)/,
      );
      assert.match(error.message, /may still have been processed/);
      return true;
    });
  });

  it("aborts the in-flight fetch through the signal it passes", async () => {
    let signal: AbortSignal | undefined;
    const client = clientWith(
      ((_input, init) => {
        signal = init?.signal ?? undefined;
        return new Promise<Response>((_resolve, reject) => {
          signal?.addEventListener("abort", () =>
            reject(new Error("aborted by signal")),
          );
        });
      }) as typeof fetch,
      { requestTimeoutMs: 25 },
    );
    await assert.rejects(client.getCredits(), StudioApiTimeoutError);
    assert.equal(signal?.aborted, true);
  });

  it("times out while the response body is still being read", async () => {
    const client = clientWith(
      (async () => ({
        status: 200,
        ok: true,
        text: () => new Promise<string>(() => {}),
      })) as unknown as typeof fetch,
      { requestTimeoutMs: 25 },
    );
    await assert.rejects(client.getCredits(), StudioApiTimeoutError);
  });

  it("does not time out a call that answers in time, and leaves no timer behind", async () => {
    const client = clientWith(
      (async () =>
        Response.json({ balance: 3, currency: "credits" })) as typeof fetch,
      {
        requestTimeoutMs: 5_000,
      },
    );
    assert.deepEqual(await client.getCredits(), {
      balance: 3,
      currency: "credits",
    });
  });

  it("gives uploads their own, longer deadline", async () => {
    const slow = (async () => {
      await new Promise((resolve) => setTimeout(resolve, 120));
      return Response.json({ ok: true });
    }) as typeof fetch;
    const client = clientWith(slow, {
      requestTimeoutMs: 25,
      uploadTimeoutMs: 5_000,
    });
    await assert.rejects(client.getCredits(), StudioApiTimeoutError);
    assert.deepEqual(
      await client.uploadInput({
        generationId: GENERATION_ID,
        filePath: "still.png",
      }),
      { ok: true },
    );
    assert.deepEqual(
      await client.uploadAsset({
        generationId: GENERATION_ID,
        slot: "image_url",
        filePath: "still.png",
      }),
      { ok: true },
    );
  });

  it("times out a stalled upload", async () => {
    const client = clientWith(
      (() => new Promise<Response>(() => {})) as typeof fetch,
      {
        uploadTimeoutMs: 25,
      },
    );
    await assert.rejects(
      client.uploadInput({
        generationId: GENERATION_ID,
        filePath: "still.png",
      }),
      /POST \/api\/v1\/generations\/.+\/input\)/,
    );
    await assert.rejects(
      client.uploadAsset({
        generationId: GENERATION_ID,
        slot: "image_url",
        filePath: "still.png",
      }),
      StudioApiTimeoutError,
    );
  });

  it("hands fetch the file's own memory instead of copying it", async () => {
    const bodies: unknown[] = [];
    const client = clientWith(
      (async (_input, init) => {
        bodies.push(init?.body);
        return Response.json({ ok: true });
      }) as typeof fetch,
      {},
    );
    await client.uploadInput({
      generationId: GENERATION_ID,
      filePath: "still.png",
    });
    await client.uploadAsset({
      generationId: GENERATION_ID,
      slot: "image_url",
      filePath: "still.png",
    });
    assert.equal(bodies.length, 2);
    for (const body of bodies) {
      assert.ok(body instanceof Uint8Array);
      assert.equal(body.buffer, PNG_BYTES.buffer);
      assert.equal(body.byteOffset, PNG_BYTES.byteOffset);
      assert.equal(body.byteLength, PNG_BYTES.byteLength);
    }
  });

  it("waitGeneration keeps polling through a slow poll and reports timedOut instead of throwing", async () => {
    let calls = 0;
    const client = clientWith(
      ((_input, init) => {
        calls += 1;
        // Every poll hangs (and honours the abort signal).
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new Error("aborted")),
          );
        });
      }) as typeof fetch,
      { requestTimeoutMs: 20 },
    );
    const result = (await client.waitGeneration({
      generationId: GENERATION_ID,
      timeoutSeconds: 0.15,
      pollIntervalMs: 5,
    })) as Record<string, unknown>;
    assert.equal(result.timedOut, true);
    assert.equal(result.generationId, GENERATION_ID);
    assert.ok(calls >= 2, "timed-out polls are retried until the wait elapses");
  });

  it("waitGeneration returns the last seen status when only the final read times out", async () => {
    let calls = 0;
    const client = clientWith(
      ((_input, init) => {
        calls += 1;
        if (calls === 1) {
          return Promise.resolve(
            Response.json({
              status: "processing",
              generationId: GENERATION_ID,
            }),
          );
        }
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new Error("aborted")),
          );
        });
      }) as typeof fetch,
      { requestTimeoutMs: 20 },
    );
    const result = (await client.waitGeneration({
      generationId: GENERATION_ID,
      timeoutSeconds: 0.1,
      pollIntervalMs: 5,
    })) as Record<string, unknown>;
    assert.equal(result.timedOut, true);
    assert.equal(result.status, "processing");
  });

  it("waitGeneration still throws non-timeout errors", async () => {
    const client = clientWith(
      (async () =>
        Response.json({ error: "no" }, { status: 401 })) as typeof fetch,
      {},
    );
    await assert.rejects(
      client.waitGeneration({ generationId: GENERATION_ID, timeoutSeconds: 1 }),
      /401|no|Unauthorized/i,
    );
  });

  it("waitOutcome treats a slow poll as not finished and ends with timedOut", async () => {
    const client = clientWith(
      ((_input: unknown, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new Error("aborted")),
          );
        })) as unknown as typeof fetch,
      { requestTimeoutMs: 20 },
    );
    const result = (await client.waitOutcome({
      hash: HASH,
      timeoutSeconds: 0.1,
      pollIntervalMs: 5,
    })) as Record<string, unknown>;
    assert.equal(result.timedOut, true);
    assert.equal(result.hash, HASH);
  });

  it("states that a timed-out paid request has an UNKNOWN outcome", () => {
    const message = new StudioApiTimeoutError(
      120_000,
      "POST /api/v1/generations",
    ).message;
    assert.match(message, /UNKNOWN/);
    assert.match(message, /list_generations/);
    assert.match(message, /get_credits/);
  });
});

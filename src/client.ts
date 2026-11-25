import type { McpConfig } from "./config.js";
import { decodeSafeImageBase64, MCP_MAX_INPUT_BYTES } from "./safe-image.js";
import { decodeSafeAssetBase64, MCP_MAX_ASSET_BYTES } from "./asset-data.js";

export type StudioAspectRatio =
  "21:9" | "16:9" | "4:3" | "1:1" | "3:4" | "9:16";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class StudioApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly body?: unknown,
  ) {
    super(message);
    this.name = "StudioApiError";
  }
}

/** Ceiling for one ordinary Studio API call, including reading its response. */
export const REQUEST_TIMEOUT_MS = 120_000;
/** Ceiling for one upload: up to 250 MiB, so a slow link gets far longer. */
export const UPLOAD_TIMEOUT_MS = 10 * 60_000;

/**
 * A Studio call that did not finish in time. The request may still have been
 * received, so callers should check state before blindly repeating it.
 */
export class StudioApiTimeoutError extends Error {
  constructor(
    public readonly timeoutMs: number,
    public readonly request: string,
  ) {
    super(
      `Studio API request timed out after ${Math.round(timeoutMs / 1000)}s (${request}). ` +
        "The outcome of this request is UNKNOWN: it may still have been processed and may have charged credits. " +
        "Check list_generations and get_credits (CLI: generations, balance) before repeating a request that costs credits.",
    );
    this.name = "StudioApiTimeoutError";
  }
}

export type StudioClientTimeouts = {
  /** Default {@link REQUEST_TIMEOUT_MS}. */
  requestTimeoutMs?: number;
  /** Default {@link UPLOAD_TIMEOUT_MS}. */
  uploadTimeoutMs?: number;
};

/**
 * A view over the same memory as the Buffer, so a 250 MiB upload is not copied
 * again just to hand it to fetch.
 */
function bodyView(bytes: Buffer) {
  return new Uint8Array(
    bytes.buffer as ArrayBuffer,
    bytes.byteOffset,
    bytes.byteLength,
  );
}

export class StudioApiClient {
  constructor(
    private readonly config: McpConfig,
    private readonly timeouts: StudioClientTimeouts = {},
  ) {}

  absoluteUrl(pathOrUrl: string) {
    // Only emit URLs on the configured Studio origin.
    if (pathOrUrl.startsWith("http://") || pathOrUrl.startsWith("https://")) {
      try {
        const parsed = new URL(pathOrUrl);
        const base = new URL(this.config.apiBase);
        if (parsed.origin === base.origin) return parsed.toString();
        if (parsed.pathname.startsWith("/api/")) {
          return `${base.origin}${parsed.pathname}${parsed.search}`;
        }
      } catch {
        // ignore malformed absolute URLs
      }
      throw new Error(
        "Refusing to expose an output URL outside the Studio API origin.",
      );
    }
    return `${this.config.apiBase}${pathOrUrl.startsWith("/") ? "" : "/"}${pathOrUrl}`;
  }

  async listModels() {
    return this.request<{ models: unknown[] }>("/api/v1/models");
  }

  async getCredits() {
    return this.request<{ balance: number; currency: string }>(
      "/api/v1/credits",
    );
  }

  async listTopUps() {
    return this.request<{
      topups: { id: string; credits: number; priceUsd: number }[];
      note?: string;
    }>("/api/v1/topups");
  }

  async createTopUpCheckout(topUpId: "topup-1000" | "topup-3000") {
    return this.request<{
      url: string;
      sessionId: string;
      topUpId: string;
      credits: number;
      priceUsd: number;
      message?: string;
    }>("/api/v1/checkout/topup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ topUpId }),
    });
  }

  /**
   * Agent-payable top-up over x402. Requires a configured wallet fetcher;
   * without one the server's 402 challenge surfaces as a StudioApiError.
   */
  async createX402TopUp(topUpId: "topup-1000" | "topup-3000") {
    return this.request<{
      topUpId: string;
      creditsGranted: number;
      alreadyGranted?: boolean;
      balance: number;
      payment?: { rail: string; transaction: string; network: string };
    }>("/api/v1/checkout/x402", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ topUpId }),
    });
  }

  async listGenerations(limit = 20) {
    return this.request<{ generations: unknown[] }>(
      `/api/v1/generations?limit=${encodeURIComponent(String(limit))}`,
    );
  }

  async generate(input: {
    modelId: string;
    prompt?: string;
    aspectRatio?: StudioAspectRatio;
    options?: Record<string, string | number | boolean>;
    quoteToken?: string;
    /** Studio refuses the request, reserving nothing, if its quote costs more. */
    maxCredits?: number;
  }) {
    return this.request<Record<string, unknown>>("/api/v1/generations", {
      method: "POST",
      body: JSON.stringify(input),
      headers: { "content-type": "application/json" },
    });
  }

  async quoteGeneration(input: {
    modelId: string;
    aspectRatio?: StudioAspectRatio;
    options?: Record<string, string | number | boolean>;
  }) {
    return this.request<{
      modelId: string;
      options: Record<string, string | number | boolean>;
      quote: {
        customerCredits: number;
        retailUsd: number;
        lockedQuoteToken: string;
        expiresAt: number;
        selectedProvider: string;
        providerDisclosure: string;
        rateCardVersion: string;
        rateCardReviewedAt: string;
      };
    }>("/api/v1/generations/quote", {
      method: "POST",
      body: JSON.stringify(input),
      headers: { "content-type": "application/json" },
    });
  }

  async planOutcome(intent: unknown, includePilot = false) {
    const query = includePilot ? "?pilot=1" : "";
    return this.request<Record<string, unknown>>(
      `/api/v1/outcomes/plan${query}`,
      {
        method: "POST",
        body: JSON.stringify(intent),
        headers: { "content-type": "application/json" },
      },
    );
  }

  async quoteOutcome(intent: unknown, includePilot = false) {
    const query = includePilot ? "?pilot=1" : "";
    return this.request<Record<string, unknown>>(
      `/api/v1/outcomes/quote${query}`,
      {
        method: "POST",
        body: JSON.stringify(intent),
        headers: { "content-type": "application/json" },
      },
    );
  }

  async executeOutcome(intent: unknown, includePilot = false) {
    const query = includePilot ? "?pilot=1" : "";
    return this.request<Record<string, unknown>>(
      `/api/v1/outcomes/execute${query}`,
      {
        method: "POST",
        body: JSON.stringify(intent),
        headers: { "content-type": "application/json" },
      },
    );
  }

  async getReceipt(hash: string, options: { timeoutMs?: number } = {}) {
    return this.request<Record<string, unknown>>(
      `/api/v1/outcomes/receipts/${encodeURIComponent(assertOutcomeHash(hash))}`,
      {},
      options.timeoutMs,
    );
  }

  async waitOutcome(input: {
    hash: string;
    timeoutSeconds?: number;
    pollIntervalMs?: number;
  }) {
    const hash = assertOutcomeHash(input.hash);
    const timeoutMs = (input.timeoutSeconds ?? 120) * 1000;
    const pollIntervalMs = input.pollIntervalMs ?? 1500;
    const started = Date.now();
    const remaining = () => Math.max(1, timeoutMs - (Date.now() - started));
    let last: Record<string, unknown> | null = null;

    while (Date.now() - started < timeoutMs) {
      try {
        const receipt = await this.getReceipt(hash, {
          timeoutMs: this.pollDeadlineMs(remaining()),
        });
        last = receipt;
        if (isTerminalOutcome(receipt)) {
          return receipt;
        }
      } catch (error) {
        // A slow poll is "not finished yet", not a failure of the whole wait.
        const slowPoll = error instanceof StudioApiTimeoutError;
        const notYet = error instanceof StudioApiError && error.status === 404;
        if (!slowPoll && !notYet) {
          throw error;
        }
      }
      await sleep(Math.min(pollIntervalMs, remaining()));
    }

    try {
      const latest = await this.getReceipt(hash, {
        timeoutMs: this.pollDeadlineMs(REQUEST_TIMEOUT_MS),
      });
      return {
        ...latest,
        timedOut: true,
        error: "Timed out waiting for the outcome run to finish.",
      };
    } catch (error) {
      if (
        (error instanceof StudioApiError && error.status === 404) ||
        error instanceof StudioApiTimeoutError
      ) {
        return {
          ...(last ?? { hash }),
          timedOut: true,
          error: "Timed out waiting for the outcome receipt.",
        };
      }
      throw error;
    }
  }

  /**
   * Cancel a held outcome order. Steps not yet sent to a provider stop and
   * their credits return; jobs already running finish and are charged only
   * if they succeed. 200 when done, 202 while they drain (repeat or wait).
   * A run without an outcome hold answers 409 OUTCOME_NOT_CANCELLABLE
   * (reason legacy_run) with per-generation cancel links in next.
   */
  async cancelOutcome(input: { hash: string; waitSeconds?: number }) {
    const hash = assertOutcomeHash(input.hash);
    const waitSeconds = input.waitSeconds;
    if (
      waitSeconds !== undefined &&
      (!Number.isInteger(waitSeconds) || waitSeconds < 0 || waitSeconds > 25)
    ) {
      throw new Error("waitSeconds must be an integer from 0 to 25.");
    }
    return this.request<Record<string, unknown>>(
      `/api/v1/outcomes/${encodeURIComponent(hash)}/cancel`,
      {
        method: "POST",
        ...(waitSeconds !== undefined
          ? {
              body: JSON.stringify({ wait_seconds: waitSeconds }),
              headers: { "content-type": "application/json" },
            }
          : {}),
      },
    );
  }

  async settleOutcome(intent: unknown, includePilot = false) {
    const query = includePilot ? "?pilot=1" : "";
    return this.request<Record<string, unknown>>(
      `/api/v1/outcomes/settle${query}`,
      {
        method: "POST",
        body: JSON.stringify(intent),
        headers: { "content-type": "application/json" },
      },
    );
  }

  async listOutcomeCapabilities(includePilot = false) {
    const query = includePilot ? "?pilot=1" : "";
    return this.request<Record<string, unknown>>(
      `/api/v1/outcomes/capabilities${query}`,
    );
  }

  async verifyOutcomeAttestation(attestation: unknown) {
    return this.request<Record<string, unknown>>("/api/v1/outcomes/verify", {
      method: "POST",
      body: JSON.stringify(attestation),
      headers: { "content-type": "application/json" },
    });
  }

  async getGeneration(
    generationId: string,
    options: { timeoutMs?: number } = {},
  ) {
    return this.request<Record<string, unknown>>(
      `/api/v1/generations/${encodeURIComponent(assertGenerationId(generationId))}`,
      {},
      options.timeoutMs,
    );
  }

  async cancelGeneration(generationId: string) {
    return this.request<Record<string, unknown>>(
      `/api/v1/generations/${encodeURIComponent(assertGenerationId(generationId))}/cancel`,
      { method: "POST" },
    );
  }

  async submitGeneration(
    generationId: string,
    aspectRatio: StudioAspectRatio = "16:9",
  ) {
    return this.request<Record<string, unknown>>(
      `/api/v1/generations/${encodeURIComponent(assertGenerationId(generationId))}/submit`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ aspectRatio }),
      },
    );
  }

  async uploadInput(input: {
    generationId: string;
    filePath?: string;
    imageBase64?: string;
    contentType?: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
  }) {
    const generationId = assertGenerationId(input.generationId);
    let image;

    if (input.filePath) {
      if (!this.config.readLocalImage) {
        throw new Error(
          "Local filePath uploads are disabled for remote MCP. Send imageBase64 instead.",
        );
      }
      image = await this.config.readLocalImage({
        filePath: input.filePath,
        maxBytes: MCP_MAX_INPUT_BYTES,
        rootDir: this.config.uploadRoot ?? process.cwd(),
      });
    } else if (input.imageBase64) {
      image = decodeSafeImageBase64({
        imageBase64: input.imageBase64,
        maxBytes: MCP_MAX_INPUT_BYTES,
        contentType: input.contentType,
      });
    } else {
      throw new Error("Provide filePath or imageBase64.");
    }

    return this.request<Record<string, unknown>>(
      `/api/v1/generations/${encodeURIComponent(generationId)}/input`,
      {
        method: "POST",
        headers: {
          "content-type": image.contentType,
          "content-length": String(image.bytes.byteLength),
        },
        body: bodyView(image.bytes),
      },
      this.timeouts.uploadTimeoutMs ?? UPLOAD_TIMEOUT_MS,
    );
  }

  async uploadAsset(input: {
    generationId: string;
    slot: string;
    position?: number;
    filePath?: string;
    assetBase64?: string;
    contentType?: string;
  }) {
    const generationId = assertGenerationId(input.generationId);
    if (!/^[a-z][a-z0-9_]{0,62}$/.test(input.slot)) {
      throw new Error("slot must be a model input slot from list_models.");
    }
    const position = input.position ?? 0;
    if (!Number.isSafeInteger(position) || position < 0 || position > 999) {
      throw new Error("position must be an integer from 0 to 999.");
    }
    let asset;
    if (input.filePath) {
      if (!this.config.readLocalAsset) {
        throw new Error(
          "Local filePath uploads are disabled for remote MCP. Send assetBase64 instead.",
        );
      }
      asset = await this.config.readLocalAsset({
        filePath: input.filePath,
        maxBytes: MCP_MAX_ASSET_BYTES,
        rootDir: this.config.uploadRoot ?? process.cwd(),
      });
    } else if (input.assetBase64 && input.contentType) {
      asset = decodeSafeAssetBase64({
        assetBase64: input.assetBase64,
        contentType: input.contentType,
      });
    } else {
      throw new Error("Provide filePath, or assetBase64 with contentType.");
    }
    return this.request<Record<string, unknown>>(
      `/api/v1/generations/${encodeURIComponent(generationId)}/assets/${encodeURIComponent(input.slot)}/${position}`,
      {
        method: "POST",
        headers: {
          "content-type": asset.contentType,
          "content-length": String(asset.bytes.byteLength),
        },
        body: bodyView(asset.bytes),
      },
      this.timeouts.uploadTimeoutMs ?? UPLOAD_TIMEOUT_MS,
    );
  }

  async waitGeneration(input: {
    generationId: string;
    timeoutSeconds?: number;
    pollIntervalMs?: number;
  }) {
    const generationId = assertGenerationId(input.generationId);
    const timeoutMs = (input.timeoutSeconds ?? 120) * 1000;
    const pollIntervalMs = input.pollIntervalMs ?? 1500;
    const started = Date.now();
    const remaining = () => Math.max(1, timeoutMs - (Date.now() - started));
    let last: Record<string, unknown> | null = null;

    while (Date.now() - started < timeoutMs) {
      try {
        const status = await this.getGeneration(generationId, {
          timeoutMs: this.pollDeadlineMs(remaining()),
        });
        last = status;
        const state = String(status.status ?? "");
        if (state === "completed" || state === "failed") {
          return this.withAbsoluteOutput(status);
        }
      } catch (error) {
        // A slow poll is "not finished yet": keep waiting until the overall
        // wait elapses, then report timedOut instead of throwing.
        if (!(error instanceof StudioApiTimeoutError)) throw error;
      }
      await sleep(Math.min(pollIntervalMs, remaining()));
    }

    let latest: Record<string, unknown>;
    try {
      latest = await this.getGeneration(generationId);
    } catch (error) {
      if (!(error instanceof StudioApiTimeoutError)) throw error;
      // Keep the timedOut result: the last status we saw is better than a throw.
      latest = last ?? { generationId };
    }
    return {
      ...this.withAbsoluteOutput(latest),
      timedOut: true,
      error:
        typeof latest.error === "string"
          ? latest.error
          : "Timed out waiting for generation to finish.",
    };
  }

  /**
   * Deadline for one poll inside a wait: the ordinary request ceiling, but
   * never longer than what is left of the overall wait, so a hung poll cannot
   * stretch the wait past the time the caller asked for.
   */
  private pollDeadlineMs(remainingMs: number) {
    const ceiling = this.timeouts.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
    return Math.max(1, Math.min(ceiling, remainingMs));
  }

  withAbsoluteOutput(payload: Record<string, unknown>) {
    const outputAssets = Array.isArray(payload.outputAssets)
      ? payload.outputAssets.flatMap((value) => {
          if (!value || typeof value !== "object") return [];
          const asset = value as Record<string, unknown>;
          if (typeof asset.url !== "string") return [asset];
          try {
            return [{ ...asset, url: this.absoluteUrl(asset.url) }];
          } catch {
            return [
              {
                ...asset,
                url: undefined,
                urlError: "Omitting untrusted output URL.",
              },
            ];
          }
        })
      : undefined;
    if (typeof payload.outputUrl !== "string") {
      return outputAssets ? { ...payload, outputAssets } : payload;
    }
    try {
      return {
        ...payload,
        outputUrl: this.absoluteUrl(payload.outputUrl),
        ...(outputAssets ? { outputAssets } : {}),
      };
    } catch {
      const rest = { ...payload };
      delete rest.outputUrl;
      return {
        ...rest,
        outputUrlError: "Omitting untrusted output URL.",
      };
    }
  }

  private async request<T>(
    path: string,
    init: RequestInit = {},
    timeoutMs: number = this.timeouts.requestTimeoutMs ?? REQUEST_TIMEOUT_MS,
  ): Promise<T> {
    if (!path.startsWith("/api/v1/")) {
      throw new Error("Refusing to call a non /api/v1 path.");
    }

    const headers = new Headers(init.headers);
    if (this.config.apiKey) {
      headers.set("authorization", `Bearer ${this.config.apiKey}`);
    }
    headers.set("accept", "application/json");

    if (!this.config.apiKey && !this.config.fetcher) {
      throw new Error("Studio API authentication is not configured.");
    }

    const fetcher = this.config.fetcher ?? fetch;
    // The deadline covers connecting, sending the body and reading the reply,
    // so a stalled upload or poll fails instead of hanging the tool call.
    const { response, text } = await withDeadline(
      timeoutMs,
      `${init.method ?? "GET"} ${path}`,
      async (signal) => {
        const response = await fetcher(`${this.config.apiBase}${path}`, {
          ...init,
          headers,
          redirect: "manual",
          signal,
        });

        if (response.status >= 300 && response.status < 400) {
          throw new StudioApiError(
            response.status,
            "Unexpected redirect from Studio API.",
          );
        }

        return { response, text: await response.text() };
      },
    );
    let body: unknown = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }

    if (!response.ok) {
      const message = studioErrorMessage(response.status, body);
      throw new StudioApiError(response.status, message, body);
    }

    return body as T;
  }
}

/**
 * Run `run` with an AbortSignal that fires after `timeoutMs`. The race also
 * rejects for a fetcher that ignores the signal, and the timer is always
 * cleared so a finished request leaves nothing pending.
 */
async function withDeadline<T>(
  timeoutMs: number,
  request: string,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new StudioApiTimeoutError(timeoutMs, request));
      controller.abort();
    }, timeoutMs);
  });
  try {
    return await Promise.race([run(controller.signal), expired]);
  } finally {
    clearTimeout(timer);
  }
}

function assertGenerationId(generationId: string) {
  if (!UUID_RE.test(generationId)) {
    throw new Error("generationId must be a UUID.");
  }
  return generationId;
}

const OUTCOME_HASH_RE = /^[a-f0-9]{64}$/i;

function assertOutcomeHash(hash: string) {
  if (!OUTCOME_HASH_RE.test(hash)) {
    throw new Error("hash must be a 64-character sha-256 hex digest.");
  }
  return hash.toLowerCase();
}

function runField(
  receipt: Record<string, unknown>,
  key: "status" | "outcome_status",
): string {
  const run = receipt.run;
  if (!run || typeof run !== "object") return "";
  const value = (run as Record<string, unknown>)[key];
  return typeof value === "string" ? value : "";
}

const TERMINAL_OUTCOME_STATUSES = new Set([
  "completed",
  "failed",
  "cancelled",
  "partially_completed",
]);

/**
 * A wait ends when the order finished one way or another: run.outcome_status
 * is completed, failed, cancelled or partially_completed, or (servers
 * without outcome_status) run.status is completed or failed. A cancelled
 * order still draining reads running and keeps the wait going.
 */
export function isTerminalOutcome(receipt: Record<string, unknown>) {
  const outcome = runField(receipt, "outcome_status");
  if (TERMINAL_OUTCOME_STATUSES.has(outcome)) return true;
  if (outcome === "running") return false;
  const status = runField(receipt, "status");
  return status === "completed" || status === "failed";
}

function studioErrorMessage(status: number, body: unknown) {
  if (body && typeof body === "object") {
    const record = body as Record<string, unknown>;
    if (typeof record.detail === "string" && record.detail.length > 0) {
      return record.detail;
    }
    if (typeof record.title === "string" && record.title.length > 0) {
      return record.title;
    }
    if (typeof record.error === "string" && record.error.length > 0) {
      return record.error;
    }
  }
  return `Studio API error (${status})`;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

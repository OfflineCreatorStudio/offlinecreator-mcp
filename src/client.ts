import type { McpConfig } from "./config.js";
import { decodeSafeImageBase64, MCP_MAX_INPUT_BYTES } from "./safe-image.js";

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

export class StudioApiClient {
  constructor(private readonly config: McpConfig) {}

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

  async listGenerations(limit = 20) {
    return this.request<{ generations: unknown[] }>(
      `/api/v1/generations?limit=${encodeURIComponent(String(limit))}`,
    );
  }

  async generate(input: {
    modelId: string;
    prompt: string;
    aspectRatio?: "16:9" | "9:16" | "1:1";
  }) {
    return this.request<Record<string, unknown>>("/api/v1/generations", {
      method: "POST",
      body: JSON.stringify(input),
      headers: { "content-type": "application/json" },
    });
  }

  async getGeneration(generationId: string) {
    return this.request<Record<string, unknown>>(
      `/api/v1/generations/${encodeURIComponent(assertGenerationId(generationId))}`,
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
    aspectRatio: "16:9" | "9:16" | "1:1" = "16:9",
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
        body: new Uint8Array(image.bytes),
      },
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

    while (Date.now() - started < timeoutMs) {
      const status = await this.getGeneration(generationId);
      const state = String(status.status ?? "");
      if (state === "completed" || state === "failed") {
        return this.withAbsoluteOutput(status);
      }
      await sleep(pollIntervalMs);
    }

    const latest = await this.getGeneration(generationId);
    return {
      ...this.withAbsoluteOutput(latest),
      timedOut: true,
      error:
        typeof latest.error === "string"
          ? latest.error
          : "Timed out waiting for generation to finish.",
    };
  }

  withAbsoluteOutput(payload: Record<string, unknown>) {
    if (typeof payload.outputUrl !== "string") return payload;
    try {
      return {
        ...payload,
        outputUrl: this.absoluteUrl(payload.outputUrl),
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

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
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
    const response = await fetcher(`${this.config.apiBase}${path}`, {
      ...init,
      headers,
      redirect: "manual",
    });

    if (response.status >= 300 && response.status < 400) {
      throw new StudioApiError(
        response.status,
        "Unexpected redirect from Studio API.",
      );
    }

    const text = await response.text();
    let body: unknown = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }

    if (!response.ok) {
      const message =
        body &&
        typeof body === "object" &&
        "error" in body &&
        typeof (body as { error: unknown }).error === "string"
          ? (body as { error: string }).error
          : `Studio API error (${response.status})`;
      throw new StudioApiError(response.status, message, body);
    }

    return body as T;
  }
}

function assertGenerationId(generationId: string) {
  if (!UUID_RE.test(generationId)) {
    throw new Error("generationId must be a UUID.");
  }
  return generationId;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

import type { StudioApiClient, StudioApiError } from "./client.js";

export const A2A_PROTOCOL_VERSION = "1.0";
export const A2A_JSONRPC_VERSION = "2.0";

export const A2A_METHODS = {
  sendMessage: "SendMessage",
  sendStreamingMessage: "SendStreamingMessage",
  getTask: "GetTask",
  listTasks: "ListTasks",
  cancelTask: "CancelTask",
  subscribeToTask: "SubscribeToTask",
  createPushConfig: "CreateTaskPushNotificationConfig",
  getPushConfig: "GetTaskPushNotificationConfig",
  listPushConfigs: "ListTaskPushNotificationConfigs",
  deletePushConfig: "DeleteTaskPushNotificationConfig",
  getExtendedAgentCard: "GetExtendedAgentCard",
} as const;

const UNSUPPORTED_METHODS = new Set<string>([
  A2A_METHODS.sendStreamingMessage,
  A2A_METHODS.subscribeToTask,
  A2A_METHODS.getExtendedAgentCard,
]);

const PUSH_METHODS = new Set<string>([
  A2A_METHODS.createPushConfig,
  A2A_METHODS.getPushConfig,
  A2A_METHODS.listPushConfigs,
  A2A_METHODS.deletePushConfig,
]);

export type A2AAuth = {
  userId: string;
  scopes: string[];
};

export type A2ATaskState =
  | "TASK_STATE_SUBMITTED"
  | "TASK_STATE_WORKING"
  | "TASK_STATE_COMPLETED"
  | "TASK_STATE_FAILED"
  | "TASK_STATE_CANCELED"
  | "TASK_STATE_REJECTED";

export type A2ATaskRecord = {
  taskId: string;
  generationId: string | null;
  contextId: string;
  messageId: string;
  userId: string;
  operation: string;
  state: A2ATaskState;
  statusMessage: string;
  statusTimestamp: number;
  history: unknown[];
  artifacts: unknown[];
  createdAt: number;
  updatedAt: number;
};

export type A2AListQuery = {
  contextId?: string;
  status?: string;
  pageSize: number;
  pageToken?: string;
  statusTimestampAfter?: number;
};

export type A2ATaskStore = {
  getByMessageId(
    userId: string,
    messageId: string,
  ): Promise<A2ATaskRecord | null>;
  getById(userId: string, taskId: string): Promise<A2ATaskRecord | null>;
  /**
   * Atomically binds `record.messageId` to `record` unless this user already
   * has a task for that messageId, and returns the task that owns it
   * (`claimed` is true only when that is `record`). SendMessage claims before
   * it spends, so a concurrent or repeated message never starts a second
   * generation. Optional only so stores written for earlier versions of
   * this package keep working; without it that race stays open. Used only
   * together with `release`: a store with one and not the other is treated
   * as having neither.
   */
  claim?(
    record: A2ATaskRecord,
  ): Promise<{ claimed: boolean; record: A2ATaskRecord }>;
  /**
   * Drops a claimed task that never bound a generation, after Studio refused
   * the request without reserving credits. A task with a generation stays.
   * Without it a refused message would stay claimed, so `claim` goes unused.
   */
  release?(userId: string, taskId: string): Promise<void>;
  save(record: A2ATaskRecord): Promise<void>;
  list(
    userId: string,
    query: A2AListQuery,
  ): Promise<{
    tasks: A2ATaskRecord[];
    nextPageToken: string;
    totalSize: number;
  }>;
};

export class MemoryA2ATaskStore implements A2ATaskStore {
  private readonly records = new Map<string, A2ATaskRecord>();

  key(userId: string, taskId: string) {
    return `${userId}:${taskId}`;
  }

  async getByMessageId(userId: string, messageId: string) {
    return (
      [...this.records.values()].find(
        (record) => record.userId === userId && record.messageId === messageId,
      ) ?? null
    );
  }

  async getById(userId: string, taskId: string) {
    return this.records.get(this.key(userId, taskId)) ?? null;
  }

  // No await between the lookup and the insert, so the claim is atomic.
  async claim(record: A2ATaskRecord) {
    const existing = [...this.records.values()].find(
      (entry) =>
        entry.userId === record.userId && entry.messageId === record.messageId,
    );
    if (existing) return { claimed: false, record: existing };
    this.records.set(this.key(record.userId, record.taskId), record);
    return { claimed: true, record };
  }

  async release(userId: string, taskId: string) {
    const key = this.key(userId, taskId);
    if (this.records.get(key)?.generationId === null) this.records.delete(key);
  }

  async save(record: A2ATaskRecord) {
    this.records.set(this.key(record.userId, record.taskId), record);
  }

  async list(userId: string, query: A2AListQuery) {
    let tasks = [...this.records.values()]
      .filter((record) => record.userId === userId)
      .sort((left, right) => {
        if (right.statusTimestamp !== left.statusTimestamp) {
          return right.statusTimestamp - left.statusTimestamp;
        }
        return right.taskId.localeCompare(left.taskId);
      });
    if (query.contextId) {
      tasks = tasks.filter((record) => record.contextId === query.contextId);
    }
    if (query.status) {
      tasks = tasks.filter((record) => record.state === query.status);
    }
    if (query.statusTimestampAfter) {
      tasks = tasks.filter(
        (record) => record.statusTimestamp > query.statusTimestampAfter!,
      );
    }
    const totalSize = tasks.length;
    let start = 0;
    if (query.pageToken) {
      const index = tasks.findIndex(
        (record) => record.taskId === query.pageToken,
      );
      start = index >= 0 ? index + 1 : 0;
    }
    const page = tasks.slice(start, start + query.pageSize);
    const last = page.at(-1);
    return {
      tasks: page,
      nextPageToken: last && start + page.length < totalSize ? last.taskId : "",
      totalSize,
    };
  }
}

type JsonRpcRequest = {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: unknown;
};

type JsonRpcError = {
  code: number;
  message: string;
  data?: Array<{ "@type": string; [key: string]: unknown }>;
};

function jsonRpcError(
  id: string | number | null,
  error: JsonRpcError,
  status = 200,
) {
  return new Response(
    JSON.stringify({
      jsonrpc: A2A_JSONRPC_VERSION,
      id,
      error,
    }),
    {
      status,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      },
    },
  );
}

function jsonRpcResult(id: string | number | null, result: unknown) {
  return new Response(
    JSON.stringify({
      jsonrpc: A2A_JSONRPC_VERSION,
      id,
      result,
    }),
    {
      status: 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      },
    },
  );
}

function isTimeoutError(error: unknown) {
  return error instanceof Error && error.name === "StudioApiTimeoutError";
}

function isStudioConflict(error: unknown) {
  return (
    error instanceof Error &&
    error.name === "StudioApiError" &&
    (error as StudioApiError).status === 409
  );
}

function typedError(
  code: number,
  message: string,
  type: string,
  extras: Record<string, unknown> = {},
): JsonRpcError {
  return {
    code,
    message,
    data: [{ "@type": type, ...extras }],
  };
}

export function projectGenerationState(
  status: string | undefined,
): A2ATaskState {
  switch ((status ?? "").toLowerCase()) {
    case "completed":
      return "TASK_STATE_COMPLETED";
    case "failed":
      return "TASK_STATE_FAILED";
    case "canceled":
    case "cancelled":
      return "TASK_STATE_CANCELED";
    case "processing":
    case "in-progress":
    case "running":
      return "TASK_STATE_WORKING";
    case "rejected":
    case "moderation":
      return "TASK_STATE_REJECTED";
    default:
      return "TASK_STATE_SUBMITTED";
  }
}

function taskPayload(record: A2ATaskRecord, historyLength = 1) {
  return {
    id: record.taskId,
    contextId: record.contextId,
    status: {
      state: record.state,
      message: {
        messageId: `status:${record.taskId}:${record.statusTimestamp}`,
        role: "agent",
        parts: [{ text: record.statusMessage, mediaType: "text/plain" }],
      },
      timestamp: new Date(record.statusTimestamp).toISOString(),
    },
    history: record.history.slice(-Math.max(0, historyLength)),
    artifacts: record.artifacts,
    metadata: {
      generationId: record.generationId,
      operation: record.operation,
    },
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function messageData(message: Record<string, unknown> | null) {
  const parts = Array.isArray(message?.parts) ? message.parts : [];
  for (const part of parts) {
    const record = asRecord(part);
    if (!record) continue;
    if (record.data && typeof record.data === "object") {
      return record.data as Record<string, unknown>;
    }
    if (typeof record.text === "string") {
      try {
        const parsed = JSON.parse(record.text);
        if (parsed && typeof parsed === "object") {
          return parsed as Record<string, unknown>;
        }
      } catch {
        return { operation: "generate", prompt: record.text };
      }
    }
  }
  return null;
}

const GENERATION_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Studio's generation responses (POST and GET /api/v1/generations) carry
 * `generationId`; `id` is accepted for older shapes of a success payload only.
 * An error body names a generation through `generationId` alone: a bare `id`
 * there may be a request or correlation id. Anything else is null, never a
 * made-up id.
 */
function trackedGenerationId(
  payload: Record<string, unknown> | null,
  options: { legacyId?: boolean } = {},
) {
  const candidates = options.legacyId
    ? [payload?.generationId, payload?.id]
    : [payload?.generationId];
  for (const value of candidates) {
    if (typeof value === "string" && GENERATION_ID_RE.test(value)) return value;
  }
  return null;
}

const UNTRACKED_CHARGE_NOTE =
  "A charge may have occurred: call list_generations (GET /api/v1/generations) to find the generation, then get_generation or cancel_generation it. Resending this messageId returns this task; use a new messageId to start another generation.";

/**
 * A claimed task with no generationId after this long lost the SendMessage
 * that claimed it partway through the generate call.
 */
const STALE_CLAIM_MS = 10 * 60 * 1000;

function studioErrorBody(error: unknown) {
  if (!(error instanceof Error) || error.name !== "StudioApiError") return null;
  return asRecord((error as StudioApiError).body);
}

function errorDetail(error: unknown) {
  return error instanceof Error && error.message ? ` (${error.message})` : "";
}

/**
 * True only when Studio answered the generate call with a refusal that
 * reserved nothing: any 4xx, or a typed 5xx from Studio's own error handler
 * (startGeneration releases its reservation before answering), with no
 * generation attached. A transport failure, an untyped 5xx, or a response
 * naming a generation may have left a charged generation behind.
 */
function refusedWithoutCharge(error: unknown) {
  if (!(error instanceof Error) || error.name !== "StudioApiError")
    return false;
  const status = (error as StudioApiError).status;
  const body = studioErrorBody(error);
  if (
    body &&
    ("generationId" in body ||
      body.submissionAccepted === true ||
      body.ambiguousSubmission === true)
  ) {
    return false;
  }
  if (status >= 400 && status < 500) return true;
  return status >= 500 && status < 600 && typeof body?.code === "string";
}

const UPLOAD_UNSUPPORTED_NOTE =
  "This model needs input files, and this A2A release does not accept file uploads.";

/**
 * Cancels the reservation Studio made for a model that waits on input files,
 * rather than leaving the credits held until the reservation expires, and
 * returns the task as refused. A failed cancel says how to release it.
 */
async function rejectUploadModel(
  record: A2ATaskRecord,
  generationId: string,
  client: StudioApiClient,
): Promise<A2ATaskRecord> {
  let note: string;
  try {
    const answer = await client.cancelGeneration(generationId);
    note =
      answer.cancelled === true
        ? `The credits reserved for generation ${generationId} were released.`
        : `Credits may still be reserved for generation ${generationId}: call cancel_generation (POST /api/v1/generations/${generationId}/cancel) to release them.`;
  } catch (error) {
    note = `The credits reserved for generation ${generationId} could not be released just now${errorDetail(error)}: call cancel_generation (POST /api/v1/generations/${generationId}/cancel) to release them.`;
  }
  return {
    ...record,
    state: "TASK_STATE_REJECTED",
    statusMessage: `${UPLOAD_UNSUPPORTED_NOTE} ${note}`,
    statusTimestamp: Date.now(),
    artifacts: [],
    updatedAt: Date.now(),
  };
}

function requireScope(auth: A2AAuth, scopes: string[]) {
  return scopes.every((scope) => auth.scopes.includes(scope));
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function refreshGenerationTask(
  record: A2ATaskRecord,
  client: StudioApiClient,
  store: A2ATaskStore,
) {
  if (!record.generationId) {
    if (
      record.state === "TASK_STATE_SUBMITTED" &&
      Date.now() - record.createdAt > STALE_CLAIM_MS
    ) {
      const failed: A2ATaskRecord = {
        ...record,
        state: "TASK_STATE_FAILED",
        statusMessage: `The generate request for this task never finished recording. ${UNTRACKED_CHARGE_NOTE}`,
        statusTimestamp: Date.now(),
        updatedAt: Date.now(),
      };
      await store.save(failed);
      return failed;
    }
    return record;
  }
  if (
    record.state === "TASK_STATE_COMPLETED" ||
    record.state === "TASK_STATE_FAILED" ||
    record.state === "TASK_STATE_CANCELED" ||
    record.state === "TASK_STATE_REJECTED"
  ) {
    return record;
  }
  const generation = await client.getGeneration(record.generationId);
  const status = typeof generation.status === "string" ? generation.status : "";
  // A generation its owner cancelled reads failed with cancelled: true.
  const cancelled = generation.cancelled === true;
  const next = cancelled
    ? "TASK_STATE_CANCELED"
    : projectGenerationState(status);
  const artifacts = artifactsFromGeneration(generation, record.generationId);
  const updated: A2ATaskRecord = {
    ...record,
    state: next,
    statusMessage:
      typeof generation.error === "string" && generation.error
        ? generation.error
        : cancelled
          ? "Generation cancelled."
          : next === "TASK_STATE_COMPLETED"
            ? "Generation completed."
            : `Generation is ${status || "in progress"}.`,
    statusTimestamp: Date.now(),
    artifacts,
    updatedAt: Date.now(),
  };
  await store.save(updated);
  return updated;
}

function artifactsFromGeneration(
  generation: Record<string, unknown>,
  generationId: string,
) {
  const outputUrl =
    typeof generation.outputUrl === "string" ? generation.outputUrl : null;
  if (!outputUrl) return [];
  return [
    {
      artifactId: `output:${generationId}`,
      name: "generation-output",
      parts: [
        {
          file: {
            uri: outputUrl,
            mimeType:
              typeof generation.outputContentType === "string"
                ? generation.outputContentType
                : "application/octet-stream",
          },
          mediaType: "application/json",
        },
      ],
    },
  ];
}

async function handleSendMessage(input: {
  params: Record<string, unknown>;
  auth: A2AAuth;
  client: StudioApiClient;
  store: A2ATaskStore;
  now: number;
}) {
  const message = asRecord(input.params.message);
  const configuration = asRecord(input.params.configuration) ?? {};
  const messageId =
    typeof message?.messageId === "string" ? message.messageId.trim() : "";
  if (!messageId) {
    throw typedError(
      -32602,
      "message.messageId is required.",
      "InvalidParamsError",
    );
  }
  const existing = await input.store.getByMessageId(
    input.auth.userId,
    messageId,
  );
  if (existing) {
    const refreshed = await refreshGenerationTask(
      existing,
      input.client,
      input.store,
    );
    return { task: taskPayload(refreshed) };
  }

  const data = messageData(message);
  const operation =
    typeof data?.operation === "string" ? data.operation : "generate";
  if (operation === "list_models") {
    if (!requireScope(input.auth, ["models"])) {
      throw typedError(
        -32004,
        "The models scope is required.",
        "UnsupportedOperationError",
      );
    }
    const models = await input.client.listModels();
    return {
      message: {
        messageId: crypto.randomUUID(),
        role: "agent",
        parts: [
          {
            data: models,
            mediaType: "application/json",
          },
        ],
      },
    };
  }

  if (operation !== "generate") {
    throw typedError(
      -32602,
      "Unsupported A2A operation.",
      "InvalidParamsError",
    );
  }
  if (!requireScope(input.auth, ["models", "read", "generate"])) {
    throw typedError(
      -32004,
      "The models, read, and generate scopes are required.",
      "UnsupportedOperationError",
    );
  }

  const modelId = typeof data?.modelId === "string" ? data.modelId : "";
  const prompt = typeof data?.prompt === "string" ? data.prompt : "";
  if (!modelId || !prompt) {
    throw typedError(
      -32602,
      "generate requires modelId and prompt.",
      "InvalidParamsError",
    );
  }
  // A spend ceiling the caller set is never dropped: a malformed one refuses
  // the message rather than generating without it.
  const rawMaxCredits = data?.maxCredits ?? undefined;
  let maxCredits: number | undefined;
  if (rawMaxCredits !== undefined) {
    if (
      typeof rawMaxCredits !== "number" ||
      !Number.isSafeInteger(rawMaxCredits) ||
      rawMaxCredits <= 0
    ) {
      throw typedError(
        -32602,
        "maxCredits must be a positive whole number of credits.",
        "InvalidParamsError",
      );
    }
    maxCredits = rawMaxCredits;
  }
  const rawQuoteToken = data?.quoteToken ?? undefined;
  let quoteToken: string | undefined;
  if (rawQuoteToken !== undefined) {
    if (typeof rawQuoteToken !== "string" || !rawQuoteToken.trim()) {
      throw typedError(
        -32602,
        "quoteToken must be the lockedQuoteToken string from a Studio quote.",
        "InvalidParamsError",
      );
    }
    quoteToken = rawQuoteToken;
  }

  // Claim the messageId before spending anything. A retry that races this
  // call (or repeats it) gets this task back and never starts a second,
  // separately charged generation.
  const placeholder: A2ATaskRecord = {
    taskId: crypto.randomUUID(),
    generationId: null,
    contextId:
      typeof message?.contextId === "string"
        ? message.contextId
        : crypto.randomUUID(),
    messageId,
    userId: input.auth.userId,
    operation: "generate",
    state: "TASK_STATE_SUBMITTED",
    statusMessage: "Starting the generation.",
    statusTimestamp: input.now,
    history: [message],
    artifacts: [],
    createdAt: input.now,
    updatedAt: input.now,
  };
  // A store written before claim existed keeps the earlier order: nothing
  // is stored until Studio answers, and the lookup above is the only guard.
  // So does one that cannot release a claim, which a refusal would strand.
  const claiming = Boolean(input.store.claim && input.store.release);
  const claim = claiming
    ? await input.store.claim!(placeholder)
    : { claimed: true, record: placeholder };
  if (!claim.claimed) {
    const refreshed = await refreshGenerationTask(
      claim.record,
      input.client,
      input.store,
    );
    return { task: taskPayload(refreshed) };
  }
  const claimed = claim.record;

  let created: Record<string, unknown> | null = null;
  let failure: unknown = null;
  try {
    created = await input.client.generate({
      modelId,
      prompt,
      aspectRatio:
        data?.aspectRatio === "21:9" ||
        data?.aspectRatio === "16:9" ||
        data?.aspectRatio === "4:3" ||
        data?.aspectRatio === "1:1" ||
        data?.aspectRatio === "3:4" ||
        data?.aspectRatio === "9:16"
          ? data.aspectRatio
          : undefined,
      options:
        data?.options && typeof data.options === "object"
          ? (data.options as Record<string, string | number | boolean>)
          : undefined,
      // Studio refuses, reserving nothing, when the locked quote costs more.
      ...(maxCredits !== undefined ? { maxCredits } : {}),
      ...(quoteToken !== undefined ? { quoteToken } : {}),
    });
  } catch (error) {
    failure = error;
  }
  // An error that names a generation (a submission the provider did not
  // confirm, say) still left one behind: track it like any other.
  const generationId = created
    ? trackedGenerationId(created, { legacyId: true })
    : trackedGenerationId(studioErrorBody(failure));
  if (!generationId) {
    if (failure && refusedWithoutCharge(failure)) {
      // Nothing was reserved. Free the messageId so the same message can be
      // resent (after a top-up, say), and report the refusal as before.
      if (claiming) {
        await input.store.release!(input.auth.userId, claimed.taskId);
      }
      throw failure;
    }
    // Studio may have reserved credits for this request. Never track a
    // made-up id: fail the task and say how to find the generation.
    const reason = failure
      ? `The generate request failed before Studio confirmed a generation${errorDetail(failure)}.`
      : "Studio accepted the generate request but returned no generationId, so this task cannot track it.";
    const failed: A2ATaskRecord = {
      ...claimed,
      state: "TASK_STATE_FAILED",
      statusMessage: `${reason} ${UNTRACKED_CHARGE_NOTE}`,
    };
    await input.store.save(failed);
    return { task: taskPayload(failed) };
  }
  const status =
    typeof created?.status === "string" ? created.status : "queued";
  const record: A2ATaskRecord = {
    ...claimed,
    generationId,
    state: created ? projectGenerationState(status) : "TASK_STATE_SUBMITTED",
    statusMessage: created
      ? `Generation ${status}.`
      : `Studio has not confirmed this generation yet${errorDetail(failure)}.`,
    artifacts: created ? artifactsFromGeneration(created, generationId) : [],
  };
  await input.store.save(record);

  // A model with file inputs comes back reserved and waiting for uploads
  // (uploadRequired). This A2A release accepts none, as the agent card says,
  // so the run can never start: release the reservation and refuse the task.
  if (created?.uploadRequired === true) {
    const rejected = await rejectUploadModel(
      record,
      generationId,
      input.client,
    );
    await input.store.save(rejected);
    return { task: taskPayload(rejected) };
  }

  const returnImmediately = configuration.returnImmediately === true;
  if (returnImmediately) {
    return { task: taskPayload(record) };
  }

  const deadline = Date.now() + 120_000;
  let current = record;
  while (Date.now() < deadline) {
    try {
      current = await refreshGenerationTask(current, input.client, input.store);
    } catch (error) {
      // A slow poll leaves the (already created) task working; the caller can
      // fetch it again. Anything else is a real failure.
      if (!isTimeoutError(error)) throw error;
    }
    if (
      current.state === "TASK_STATE_COMPLETED" ||
      current.state === "TASK_STATE_FAILED" ||
      current.state === "TASK_STATE_CANCELED" ||
      current.state === "TASK_STATE_REJECTED"
    ) {
      break;
    }
    await sleep(1500);
  }
  return { task: taskPayload(current) };
}

export async function handleA2ARequest(input: {
  request: Request;
  auth: A2AAuth;
  client: StudioApiClient;
  store: A2ATaskStore;
  now?: number;
}): Promise<Response> {
  const version = input.request.headers.get("a2a-version")?.trim() || "0.3";
  if (version !== A2A_PROTOCOL_VERSION) {
    return jsonRpcError(
      null,
      typedError(
        -32009,
        "This interface supports A2A 1.0 only.",
        "VersionNotSupportedError",
        { supported: A2A_PROTOCOL_VERSION, requested: version },
      ),
    );
  }

  let body: JsonRpcRequest;
  try {
    body = (await input.request.json()) as JsonRpcRequest;
  } catch {
    return jsonRpcError(null, {
      code: -32700,
      message: "Parse error",
    });
  }

  const id = body.id ?? null;
  if (body.jsonrpc !== A2A_JSONRPC_VERSION || typeof body.method !== "string") {
    return jsonRpcError(id, {
      code: -32600,
      message: "Invalid Request",
    });
  }

  try {
    if (UNSUPPORTED_METHODS.has(body.method)) {
      throw typedError(
        -32004,
        `${body.method} is not supported.`,
        "UnsupportedOperationError",
      );
    }
    if (PUSH_METHODS.has(body.method)) {
      throw typedError(
        -32003,
        "Push notifications are not supported.",
        "PushNotificationNotSupportedError",
      );
    }

    if (body.method === A2A_METHODS.sendMessage) {
      const params = asRecord(body.params);
      if (!params) {
        throw typedError(-32602, "params is required.", "InvalidParamsError");
      }
      return jsonRpcResult(
        id,
        await handleSendMessage({
          params,
          auth: input.auth,
          client: input.client,
          store: input.store,
          now: input.now ?? Date.now(),
        }),
      );
    }

    if (body.method === A2A_METHODS.getTask) {
      const params = asRecord(body.params);
      const taskId = typeof params?.id === "string" ? params.id : "";
      if (!taskId) {
        throw typedError(-32602, "id is required.", "InvalidParamsError");
      }
      const record = await input.store.getById(input.auth.userId, taskId);
      if (!record) {
        throw typedError(-32001, "Task not found.", "TaskNotFoundError");
      }
      const refreshed = await refreshGenerationTask(
        record,
        input.client,
        input.store,
      );
      const historyLength =
        typeof params?.historyLength === "number" ? params.historyLength : 1;
      return jsonRpcResult(id, taskPayload(refreshed, historyLength));
    }

    if (body.method === A2A_METHODS.cancelTask) {
      const params = asRecord(body.params);
      const taskId = typeof params?.id === "string" ? params.id : "";
      if (!taskId) {
        throw typedError(-32602, "id is required.", "InvalidParamsError");
      }
      const record = await input.store.getById(input.auth.userId, taskId);
      if (!record) {
        throw typedError(-32001, "Task not found.", "TaskNotFoundError");
      }
      if (!record.generationId || record.state !== "TASK_STATE_SUBMITTED") {
        throw typedError(
          -32002,
          "This task can no longer be canceled.",
          "TaskNotCancelableError",
        );
      }
      let answer: Record<string, unknown>;
      try {
        answer = await input.client.cancelGeneration(record.generationId);
      } catch (error) {
        // The job already reached a provider that cannot cancel, or finished
        // (409 CONFLICT with a reason): it is charged only if it succeeds.
        if (isStudioConflict(error)) {
          throw typedError(
            -32002,
            "This task can no longer be canceled.",
            "TaskNotCancelableError",
          );
        }
        throw error;
      }
      // 202: the provider was asked to stop a job it already had. It may still
      // finish, so the task keeps its state until the generation settles.
      if (answer.cancelled !== true) {
        const requested: A2ATaskRecord = {
          ...record,
          statusMessage:
            "Cancellation requested. If the job had already started it may still finish and be charged.",
          statusTimestamp: Date.now(),
          updatedAt: Date.now(),
        };
        await input.store.save(requested);
        return jsonRpcResult(id, taskPayload(requested));
      }
      const canceled: A2ATaskRecord = {
        ...record,
        state: "TASK_STATE_CANCELED",
        statusMessage: "Generation canceled.",
        statusTimestamp: Date.now(),
        updatedAt: Date.now(),
      };
      await input.store.save(canceled);
      return jsonRpcResult(id, taskPayload(canceled));
    }

    if (body.method === A2A_METHODS.listTasks) {
      const params = asRecord(body.params) ?? {};
      const pageSize =
        typeof params.pageSize === "number" && params.pageSize > 0
          ? Math.min(params.pageSize, 100)
          : 50;
      const listed = await input.store.list(input.auth.userId, {
        contextId:
          typeof params.contextId === "string" ? params.contextId : undefined,
        status: typeof params.status === "string" ? params.status : undefined,
        pageSize,
        pageToken:
          typeof params.pageToken === "string" ? params.pageToken : undefined,
        statusTimestampAfter:
          typeof params.statusTimestampAfter === "number"
            ? params.statusTimestampAfter
            : undefined,
      });
      const historyLength =
        typeof params.historyLength === "number" ? params.historyLength : 0;
      return jsonRpcResult(id, {
        tasks: listed.tasks.map((record) => taskPayload(record, historyLength)),
        nextPageToken: listed.nextPageToken,
        pageSize,
        totalSize: listed.totalSize,
      });
    }

    return jsonRpcError(id, {
      code: -32601,
      message: "Method not found",
    });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error) {
      return jsonRpcError(id, error as JsonRpcError);
    }
    if (isTimeoutError(error)) {
      return jsonRpcError(
        id,
        typedError(-32603, (error as Error).message, "RequestTimeout", {
          outcomeUnknown: true,
        }),
      );
    }
    const studioError = error as StudioApiError;
    // A typed Studio refusal (MAX_CREDITS_EXCEEDED carries the locked quote
    // to approve, for one) reaches the caller as it was sent.
    const studioBody = studioErrorBody(error);
    return jsonRpcError(
      id,
      typedError(
        -32603,
        studioError.message || "Internal error",
        "InternalError",
        studioBody && typeof studioBody.code === "string"
          ? { studioStatus: studioError.status, studio: studioBody }
          : {},
      ),
    );
  }
}

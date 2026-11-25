import {
  McpServer,
  PROTOCOL_VERSION_META_KEY,
  type ServerContext,
} from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import packageMetadata from "../package.json" with { type: "json" };
import {
  StudioApiClient,
  StudioApiError,
  StudioApiTimeoutError,
} from "./client.js";
import type { McpConfig } from "./config.js";
import {
  creativeOutcomeIntentSchema,
  creativeOutcomeIntentWithPilotSchema,
} from "./outcomes.js";

export const MCP_SERVER_INFO = {
  name: "offlinecreator-studio",
  version: packageMetadata.version,
} as const;

/**
 * The release published to npm. The hosted remote servers (Studio /mcp and
 * the OAuth worker) and the discovery cards serve this surface: its version
 * and only its tools. While this package holds a prepared, unpublished
 * release, list that release's new tools in unreleasedTools and keep the
 * published version here. It filters whole tools only: parameters and result
 * shapes (such as generate's maxCredits and resource_link outputs) come from
 * this build. When that release is published, set version to it and empty
 * unreleasedTools. 0.1.5 is the npm release this repository tracks, so the
 * published surface is this package's own.
 */
export const PUBLISHED_MCP_RELEASE: {
  readonly version: string;
  readonly unreleasedTools: readonly string[];
} = {
  version: "0.1.5",
  unreleasedTools: [],
};

export type ServerOptions = {
  scopes?: string[];
  /**
   * "published": the npm release's tools and version (PUBLISHED_MCP_RELEASE),
   * for hosted remote servers. Default "package": this package's own
   * (stdio from this build).
   */
  surface?: "package" | "published";
};

export const TOOL_SCOPES: Record<string, string> = {
  list_models: "models",
  quote_generation: "models",
  list_outcome_capabilities: "models",
  quote_outcome: "models",
  plan_outcome: "models",
  execute_outcome: "generate",
  cancel_outcome: "generate",
  settle_outcome: "generate",
  get_receipt: "models",
  wait_outcome: "models",
  verify_attestation: "models",
  get_credits: "read",
  list_generations: "read",
  get_generation: "read",
  wait_generation: "read",
  download_output: "read",
  generate: "generate",
  upload_input: "generate",
  upload_asset: "generate",
  cancel_generation: "generate",
};

type ToolAnnotations = {
  title: string;
  readOnlyHint: boolean;
  destructiveHint: boolean;
};

export const TOOL_ANNOTATIONS = {
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
} as const satisfies Record<keyof typeof TOOL_SCOPES, ToolAnnotations>;

/** Longest a generate call blocks when wait is true; its description says so. */
const GENERATE_WAIT_SECONDS = 120;

type ToolContent =
  | { type: "text"; text: string }
  | { type: "resource_link"; uri: string; name: string; mimeType?: string };

type ToolResult = {
  content: ToolContent[];
  structuredContent?: Record<string, unknown>;
  isError: boolean;
};

function textResult(data: unknown, isError = false): ToolResult {
  return {
    content: [
      {
        type: "text" as const,
        text: typeof data === "string" ? data : JSON.stringify(data, null, 2),
      },
    ],
    isError,
  };
}

/**
 * First protocol revision whose tool results may carry `resource_link`
 * content and `structuredContent`. Strict clients on older revisions reject a
 * result with a content type their schema does not know.
 */
const RESOURCE_LINK_PROTOCOL_VERSION = "2025-06-18";
/**
 * The spec's assumption for a 2025-era HTTP request without an
 * MCP-Protocol-Version header, and the safe answer when nothing names one.
 */
const ASSUMED_PROTOCOL_VERSION = "2025-03-26";
const PROTOCOL_VERSION_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The protocol revision the current request speaks: the per-request envelope
 * (2026-07-28 and later), else the MCP-Protocol-Version header that stateless
 * 2025-era HTTP (Studio /mcp, the OAuth Worker) sends on every request, else
 * the version a stdio or stateful session negotiated in initialize.
 */
function requestProtocolVersion(
  ctx: ServerContext | undefined,
  server: McpServer,
) {
  // The SDK types the envelope as `{}`; it holds the reserved `_meta` keys.
  const envelope = ctx?.mcpReq?.envelope as Record<string, unknown> | undefined;
  const claimed = envelope?.[PROTOCOL_VERSION_META_KEY];
  if (typeof claimed === "string" && claimed) return claimed;
  const header = ctx?.http?.req?.headers.get("mcp-protocol-version")?.trim();
  if (header) return header;
  return (
    server.server.getNegotiatedProtocolVersion() ?? ASSUMED_PROTOCOL_VERSION
  );
}

function supportsResourceLinks(protocolVersion: string) {
  // Revisions are ISO dates, so they order as strings.
  return (
    PROTOCOL_VERSION_RE.test(protocolVersion) &&
    protocolVersion >= RESOURCE_LINK_PROTOCOL_VERSION
  );
}

/**
 * A completed generation also returns structuredContent and a resource_link
 * to its signed output when the request's protocol revision has both
 * (2025-06-18 or later). The text JSON stays first and unchanged, and older
 * revisions get only that text.
 */
function completedOutputResult(
  data: Record<string, unknown>,
  generation: Record<string, unknown>,
  protocolVersion: string,
): ToolResult {
  const result = textResult(data);
  if (
    !supportsResourceLinks(protocolVersion) ||
    generation.status !== "completed" ||
    typeof generation.outputUrl !== "string"
  ) {
    return result;
  }
  return {
    ...result,
    content: [
      ...result.content,
      {
        type: "resource_link",
        uri: generation.outputUrl,
        name: `generation-${String(generation.generationId ?? "output")}`,
        ...(typeof generation.outputContentType === "string"
          ? { mimeType: generation.outputContentType }
          : {}),
      },
    ],
    structuredContent: data,
  };
}

function errorResult(error: unknown) {
  if (error instanceof StudioApiError) {
    return textResult(
      {
        error: error.message,
        status: error.status,
        details: error.body,
      },
      true,
    );
  }
  if (error instanceof StudioApiTimeoutError) {
    return textResult(
      {
        error: error.message,
        code: "REQUEST_TIMEOUT",
        outcomeUnknown: true,
        request: error.request,
        timeoutMs: error.timeoutMs,
        next: "Check list_generations and get_credits before retrying a request that costs credits.",
      },
      true,
    );
  }
  return textResult(
    {
      error: error instanceof Error ? error.message : "Unknown error",
    },
    true,
  );
}

function hasScope(scopes: string[] | undefined, required: string) {
  if (!scopes || scopes.length === 0) return true;
  return scopes.includes(required);
}

function wantsPilot(args: unknown): boolean {
  if (!args || typeof args !== "object") return false;
  return (
    "includePilot" in args &&
    (args as { includePilot?: unknown }).includePilot === true
  );
}

export function createOfflineCreatorServer(
  config: McpConfig,
  options: ServerOptions = {},
) {
  const client = new StudioApiClient(config);
  const scopes = options.scopes;
  const published = options.surface === "published";
  const server = new McpServer(
    published
      ? { ...MCP_SERVER_INFO, version: PUBLISHED_MCP_RELEASE.version }
      : MCP_SERVER_INFO,
  );
  // Only the stdio entrypoint can read local files. Remote transports (Studio
  // /mcp, the OAuth Worker) omit the reader, and their hosts time tool calls
  // out well before a long poll finishes.
  const remote = !config.readLocalImage;

  function completedOutput(
    ctx: ServerContext | undefined,
    data: Record<string, unknown>,
    generation: Record<string, unknown> = data,
  ) {
    return completedOutputResult(
      data,
      generation,
      requestProtocolVersion(ctx, server),
    );
  }

  function register(
    name: keyof typeof TOOL_SCOPES,
    configBlock: {
      title: string;
      description: string;
      inputSchema: z.ZodTypeAny;
      annotations: ToolAnnotations;
    },
    handler: (args: never, ctx: ServerContext) => Promise<ToolResult>,
  ) {
    const required = TOOL_SCOPES[name];
    if (!hasScope(scopes, required)) return;
    if (published && PUBLISHED_MCP_RELEASE.unreleasedTools.includes(name))
      return;
    server.registerTool(name, configBlock, handler as never);
  }

  register(
    "list_models",
    {
      title: "List models",
      description:
        "List OfflineCreator Studio models with credit costs, workflows, and any promotional usage limits.",
      inputSchema: z.object({}),
      annotations: TOOL_ANNOTATIONS.list_models,
    },
    async () => {
      try {
        return textResult(await client.listModels());
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  register(
    "quote_generation",
    {
      title: "Quote generation",
      description:
        "Return a short-lived, provider-routed credit quote. Pass lockedQuoteToken to generate to reserve this exact customer charge.",
      inputSchema: z.object({
        modelId: z.string().describe("Model id from list_models"),
        aspectRatio: z
          .enum(["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"])
          .optional(),
        options: z
          .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
          .optional(),
      }),
      annotations: TOOL_ANNOTATIONS.quote_generation,
    },
    async ({ modelId, aspectRatio, options: modelOptions }) => {
      try {
        return textResult(
          await client.quoteGeneration({
            modelId,
            aspectRatio,
            options: modelOptions,
          }),
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  register(
    "list_outcome_capabilities",
    {
      title: "List outcome capabilities",
      description:
        "List routable capabilities from Studio rate cards. Not live provider quotes. Unauthenticated production returns NOT_LIVE; use quote_generation for named-model quotes.",
      inputSchema: z.object({
        includePilot: z
          .boolean()
          .optional()
          .describe(
            "Include illustrative third-party pilot fixtures (not live, not routable). Default false.",
          ),
      }),
      annotations: TOOL_ANNOTATIONS.list_outcome_capabilities,
    },
    async ({ includePilot }) => {
      try {
        return textResult(
          await client.listOutcomeCapabilities(includePilot === true),
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  register(
    "quote_outcome",
    {
      title: "Quote outcome",
      description:
        "Lock a payable outcome quote from creative intent against the studio credit ledger. Quotes price what actually runs (each model's default resolution, on the route that executes it, and only models that support a requested duration); step_prices lists each payable step's credits. Quotes list accepted_rails with live availability: credits, optional x402, human Stripe Checkout, optional mpp (Stripe Machine Payments Protocol, settles when enabled on the deployment), and the reserved card_agent slot. Named-model quotes still use quote_generation. includePilot is reserved: third-party pilot listings are not live, and true returns 409 PILOT_NOT_LIVE. Unauthenticated production returns NOT_LIVE.",
      inputSchema: creativeOutcomeIntentWithPilotSchema,
      annotations: TOOL_ANNOTATIONS.quote_outcome,
    },
    async (args) => {
      try {
        const includePilot = wantsPilot(args);
        return textResult(
          await client.quoteOutcome(
            creativeOutcomeIntentSchema.parse(args),
            includePilot,
          ),
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  register(
    "plan_outcome",
    {
      title: "Plan outcome",
      description:
        "Normalize creative intent, route across rate cards, quote, run the local workflow DAG, and evaluate. Preview only: POST /plan never starts live catalog jobs or writes the ledger. includePilot is reserved: third-party pilot listings are not live, and true returns 409 PILOT_NOT_LIVE. Routing is first-party only. Authenticated execute is a separate execute_outcome call. Unauthenticated production returns NOT_LIVE.",
      inputSchema: creativeOutcomeIntentWithPilotSchema,
      annotations: TOOL_ANNOTATIONS.plan_outcome,
    },
    async (args) => {
      try {
        const includePilot = wantsPilot(args);
        return textResult(
          await client.planOutcome(
            creativeOutcomeIntentSchema.parse(args),
            includePilot,
          ),
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  register(
    "execute_outcome",
    {
      title: "Execute outcome",
      description:
        "Run the outcome workflow. With an API key, catalog steps call startGeneration and settlement eligibility is projected from reservations. Status is never settled. When outcome holds are on for the account, the order's full price is set aside in one credit hold, every step draws from it, a failed step's refund goes back into the hold so a retry costs nothing extra, and whatever is left returns to the balance when the order finishes, is cancelled, or sits idle for 30 minutes (6 hours at most); otherwise each catalog step reserves its own credits. The same brief from the same account is the same order (executing it again replays the finished result); set client_reference to order it again. cancel_outcome (or POST /api/v1/outcomes/{hash}/cancel) stops an order. includePilot is reserved: third-party pilot listings are not live, and true returns 409 PILOT_NOT_LIVE. API keys do not imply marketplace routing. policy.prefer_rail=x402 is pay-per-outcome USDC (HTTP 402) even when the credit ledger has balance; default credits still spend the ledger first. When credits are insufficient, policy.prefer_rail=mpp settles only through Stripe's Machine Payments Protocol, and only when the deployment enables it. Insufficient credits dispatch across accepted_rails (optional x402, optional mpp when enabled, human Stripe, reserved card_agent). Unauthenticated production returns NOT_LIVE.",
      inputSchema: creativeOutcomeIntentWithPilotSchema,
      annotations: TOOL_ANNOTATIONS.execute_outcome,
    },
    async (args) => {
      try {
        const includePilot = wantsPilot(args);
        return textResult(
          await client.executeOutcome(
            creativeOutcomeIntentSchema.parse(args),
            includePilot,
          ),
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  register(
    "get_receipt",
    {
      title: "Get outcome receipt",
      description:
        "Fetch the stored outcome receipt and live run for an attestation hash. run.status is completed, running, failed or incomplete; run.outcome_status adds cancelled and partially_completed, and run.step_status gives each step. deliverables lists each completed step's output with a 10-minute download URL, and credits breaks down the order's credits (both need the key's read scope). The local logo stub is not a deliverable. Unauthenticated production returns NOT_LIVE.",
      inputSchema: z.object({
        hash: z
          .string()
          .regex(/^[a-f0-9]{64}$/i)
          .describe("SHA-256 attestation hash from quote or execute."),
      }),
      annotations: TOOL_ANNOTATIONS.get_receipt,
    },
    async ({ hash }) => {
      try {
        return textResult(await client.getReceipt(hash));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  register(
    "wait_outcome",
    {
      title: "Wait for outcome",
      description:
        "Poll the stored outcome run until the order finishes: outcome_status completed, failed, cancelled or partially_completed (run.status completed or failed on older servers). A cancelled order keeps the wait going while its running jobs finish. Reuses the receipt store; does not start catalog work. Download from deliverables, or download_output on a generation_id. Unauthenticated production returns NOT_LIVE.",
      inputSchema: z.object({
        hash: z
          .string()
          .regex(/^[a-f0-9]{64}$/i)
          .describe("SHA-256 attestation hash from execute."),
        timeoutSeconds: z.number().int().min(5).max(300).optional(),
      }),
      annotations: TOOL_ANNOTATIONS.wait_outcome,
    },
    async ({ hash, timeoutSeconds }) => {
      try {
        return textResult(await client.waitOutcome({ hash, timeoutSeconds }));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  register(
    "cancel_outcome",
    {
      title: "Cancel outcome",
      description:
        "Cancel an outcome order by its attestation hash. Steps not yet sent to a provider stop and their credits return; jobs already running finish and are charged only if they succeed (a failure is refunded automatically). Answers 200 when done and 202 while jobs finish (repeat it, or set waitSeconds up to 25); repeating is safe. Re-running a cancelled order is refused for an hour; send a new client_reference to order the same brief again. A run without an outcome hold answers 409 legacy_run with a generation cancel per reserved step. Unauthenticated production returns NOT_LIVE.",
      inputSchema: z.object({
        hash: z
          .string()
          .regex(/^[a-f0-9]{64}$/i)
          .describe("SHA-256 attestation hash from quote or execute."),
        waitSeconds: z
          .number()
          .int()
          .min(0)
          .max(25)
          .optional()
          .describe(
            "Wait up to this many seconds for running jobs to finish before answering.",
          ),
      }),
      annotations: TOOL_ANNOTATIONS.cancel_outcome,
    },
    async ({ hash, waitSeconds }) => {
      try {
        return textResult(await client.cancelOutcome({ hash, waitSeconds }));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  register(
    "settle_outcome",
    {
      title: "Settle outcome",
      description:
        "Acknowledge a completed outcome against existing generation reservations. Does not debit credits again. Empty args still refuse plan-page wallet access. Unauthenticated production returns NOT_LIVE.",
      inputSchema: creativeOutcomeIntentWithPilotSchema,
      annotations: TOOL_ANNOTATIONS.settle_outcome,
    },
    async (args) => {
      try {
        const includePilot = wantsPilot(args);
        return textResult(
          await client.settleOutcome(
            creativeOutcomeIntentSchema.parse(args),
            includePilot,
          ),
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  register(
    "verify_attestation",
    {
      title: "Verify routing attestation",
      description:
        "Re-hash a routing attestation body and verify the local HMAC when present. Unauthenticated production returns NOT_LIVE.",
      inputSchema: z.object({
        attestation: z
          .unknown()
          .describe(
            "Routing attestation object, or pass the quote.attestation value.",
          ),
      }),
      annotations: TOOL_ANNOTATIONS.verify_attestation,
    },
    async ({ attestation }) => {
      try {
        return textResult(await client.verifyOutcomeAttestation(attestation));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  register(
    "get_credits",
    {
      title: "Get credits",
      description: "Return the current Studio credit balance for this API key.",
      inputSchema: z.object({}),
      annotations: TOOL_ANNOTATIONS.get_credits,
    },
    async () => {
      try {
        return textResult(await client.getCredits());
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  register(
    "generate",
    {
      title: "Generate",
      description:
        "Start any Studio workflow. Use list_models for its prompt, options, and inputSlots. If uploadRequired is returned, call upload_asset for every file slot and submit on the final upload. Set maxCredits to the spend the user approved; Studio refuses a costlier quote without charging.",
      inputSchema: z.object({
        modelId: z
          .string()
          .describe("Model id from list_models, e.g. flux-schnell"),
        prompt: z
          .string()
          .max(2000)
          .optional()
          .describe("Creative prompt when the model declares a text slot"),
        aspectRatio: z
          .enum(["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"])
          .optional()
          .describe("Frame ratio; defaults to 16:9"),
        options: z
          .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
          .optional()
          .describe("Model option values declared by list_models"),
        quoteToken: z
          .string()
          .optional()
          .describe("lockedQuoteToken returned by quote_generation"),
        maxCredits: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            "Most credits this call may spend. Studio refuses, reserving nothing, when the locked quote costs more, and returns that quote for approval.",
          ),
        wait: z
          .boolean()
          .optional()
          .describe(
            `If true, poll until completed/failed for up to ${GENERATE_WAIT_SECONDS} s. Remote connections return the generationId immediately; follow up with wait_generation.`,
          ),
      }),
      annotations: TOOL_ANNOTATIONS.generate,
    },
    async (
      {
        modelId,
        prompt,
        aspectRatio,
        options: modelOptions,
        quoteToken,
        maxCredits,
        wait,
      },
      ctx,
    ) => {
      try {
        const started = await client.generate({
          modelId,
          prompt,
          aspectRatio,
          options: modelOptions,
          quoteToken,
          maxCredits,
        });
        if (!wait || started.uploadRequired || remote) {
          return textResult(client.withAbsoluteOutput(started));
        }
        const generationId = String(started.generationId ?? "");
        if (!generationId) return textResult(started);
        return completedOutput(
          ctx,
          await client.waitGeneration({
            generationId,
            timeoutSeconds: GENERATE_WAIT_SECONDS,
          }),
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  register(
    "upload_input",
    {
      title: "Upload input image",
      description:
        "Upload a source image for a reserved image-to-video generation, then submit it to the provider. Local filePath must stay inside the upload root.",
      inputSchema: z.object({
        generationId: z.string().describe("Reserved generation id"),
        filePath: z
          .string()
          .optional()
          .describe(
            "Local image path relative to the upload root (cwd or OFFLINECREATOR_UPLOAD_ROOT).",
          ),
        imageBase64: z
          .string()
          .optional()
          .describe("Base64-encoded image (optionally data URL)"),
        contentType: z
          .enum(["image/png", "image/jpeg", "image/webp", "image/gif"])
          .optional(),
        aspectRatio: z.enum(["16:9", "9:16", "1:1"]).optional(),
        wait: z.boolean().optional(),
      }),
      annotations: TOOL_ANNOTATIONS.upload_input,
    },
    async (
      { generationId, filePath, imageBase64, contentType, aspectRatio, wait },
      ctx,
    ) => {
      try {
        const uploaded = await client.uploadInput({
          generationId,
          filePath,
          imageBase64,
          contentType,
        });
        const submitted = await client.submitGeneration(
          generationId,
          aspectRatio ?? "16:9",
        );
        if (!wait) {
          return textResult({ uploaded, submitted });
        }
        return completedOutput(
          ctx,
          await client.waitGeneration({ generationId, timeoutSeconds: 180 }),
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  register(
    "upload_asset",
    {
      title: "Upload generation asset",
      description:
        "Upload one typed asset to an input slot returned by generate/list_models. Repeat for multi-file slots; set submit:true only on the final asset.",
      inputSchema: z.object({
        generationId: z.string().describe("Reserved generation id"),
        slot: z.string().describe("Exact input slot key from list_models"),
        position: z.number().int().min(0).max(999).optional(),
        filePath: z
          .string()
          .optional()
          .describe("Local path under OFFLINECREATOR_UPLOAD_ROOT (stdio only)"),
        assetBase64: z
          .string()
          .optional()
          .describe("Base64 asset bytes for remote MCP"),
        contentType: z
          .string()
          .optional()
          .describe("Required with assetBase64"),
        submit: z.boolean().optional(),
        aspectRatio: z
          .enum(["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"])
          .optional(),
        wait: z.boolean().optional(),
      }),
      annotations: TOOL_ANNOTATIONS.upload_asset,
    },
    async (
      {
        generationId,
        slot,
        position,
        filePath,
        assetBase64,
        contentType,
        submit,
        aspectRatio,
        wait,
      },
      ctx,
    ) => {
      try {
        const uploaded = await client.uploadAsset({
          generationId,
          slot,
          position,
          filePath,
          assetBase64,
          contentType,
        });
        if (!submit) return textResult({ uploaded, readyToSubmit: true });
        const submitted = await client.submitGeneration(
          generationId,
          aspectRatio ?? "16:9",
        );
        if (!wait) return textResult({ uploaded, submitted });
        const result = await client.waitGeneration({
          generationId,
          timeoutSeconds: 600,
        });
        return completedOutput(ctx, { uploaded, submitted, result }, result);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  register(
    "get_generation",
    {
      title: "Get generation",
      description:
        "Fetch status. When completed, outputUrl is a short-lived signed download link.",
      inputSchema: z.object({
        generationId: z.string(),
      }),
      annotations: TOOL_ANNOTATIONS.get_generation,
    },
    async ({ generationId }, ctx) => {
      try {
        return completedOutput(
          ctx,
          client.withAbsoluteOutput(await client.getGeneration(generationId)),
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  register(
    "wait_generation",
    {
      title: "Wait for generation",
      description:
        "Poll until completed/failed or timeout. Completed responses include a signed outputUrl.",
      inputSchema: z.object({
        generationId: z.string(),
        timeoutSeconds: z.number().int().min(5).max(300).optional(),
      }),
      annotations: TOOL_ANNOTATIONS.wait_generation,
    },
    async ({ generationId, timeoutSeconds }, ctx) => {
      try {
        return completedOutput(
          ctx,
          await client.waitGeneration({ generationId, timeoutSeconds }),
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  register(
    "download_output",
    {
      title: "Download output URL",
      description:
        "Return a short-lived signed download URL for a completed generation (does not stream bytes into the model context).",
      inputSchema: z.object({
        generationId: z.string(),
      }),
      annotations: TOOL_ANNOTATIONS.download_output,
    },
    async ({ generationId }, ctx) => {
      try {
        const status = client.withAbsoluteOutput(
          await client.getGeneration(generationId),
        );
        if (
          status.status !== "completed" ||
          typeof status.outputUrl !== "string"
        ) {
          return textResult(
            {
              error: "Generation is not completed with an output yet.",
              status,
            },
            true,
          );
        }
        return completedOutput(
          ctx,
          {
            generationId,
            outputUrl: status.outputUrl,
            outputUrlExpiresAt: status.outputUrlExpiresAt,
            outputUrlExpiresInSeconds: status.outputUrlExpiresInSeconds,
            outputContentType: status.outputContentType,
          },
          status,
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  register(
    "cancel_generation",
    {
      title: "Cancel generation",
      description:
        "Cancel a generation. Before it reaches a provider: cancelled and refunded (to the balance, or to its outcome's hold). Already at a provider that supports cancel (fal): the provider is asked to stop it. A job still queued is dropped and refunded (cancelled, stoppedAtProvider); one already running may still finish, then it is charged and delivered (202, cancellationRequested). After a 202, poll get_generation until it is completed or failed (cancelled: true when it stopped): its credits stay reserved until a status check sees the result. Repeating it is safe (alreadyCancelled). Finished jobs, and running jobs at other providers, answer 409 with a reason.",
      inputSchema: z.object({
        generationId: z.string(),
      }),
      annotations: TOOL_ANNOTATIONS.cancel_generation,
    },
    async ({ generationId }) => {
      try {
        return textResult(await client.cancelGeneration(generationId));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  register(
    "list_generations",
    {
      title: "List generations",
      description: "List recent generations for this account.",
      inputSchema: z.object({
        limit: z.number().int().min(1).max(100).optional(),
      }),
      annotations: TOOL_ANNOTATIONS.list_generations,
    },
    async ({ limit }) => {
      try {
        const result = await client.listGenerations(limit);
        return textResult({
          generations: result.generations.map((item) =>
            client.withAbsoluteOutput(item as Record<string, unknown>),
          ),
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  return server;
}

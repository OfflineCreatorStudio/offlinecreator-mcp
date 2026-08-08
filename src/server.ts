import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import packageMetadata from "../package.json" with { type: "json" };
import { StudioApiClient, StudioApiError } from "./client.js";
import type { McpConfig } from "./config.js";

export const MCP_SERVER_INFO = {
  name: "offlinecreator-studio",
  version: packageMetadata.version,
} as const;

export type ServerOptions = {
  scopes?: string[];
};

const TOOL_SCOPES: Record<string, string> = {
  list_models: "models",
  get_credits: "read",
  list_generations: "read",
  get_generation: "read",
  wait_generation: "read",
  download_output: "read",
  generate: "generate",
  upload_input: "generate",
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
} as const satisfies Record<keyof typeof TOOL_SCOPES, ToolAnnotations>;

function textResult(data: unknown, isError = false) {
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

export function createOfflineCreatorServer(
  config: McpConfig,
  options: ServerOptions = {},
) {
  const client = new StudioApiClient(config);
  const scopes = options.scopes;
  const server = new McpServer(MCP_SERVER_INFO);

  function register(
    name: keyof typeof TOOL_SCOPES,
    configBlock: {
      title: string;
      description: string;
      inputSchema: z.ZodTypeAny;
      annotations: ToolAnnotations;
    },
    handler: (args: never) => Promise<ReturnType<typeof textResult>>,
  ) {
    const required = TOOL_SCOPES[name];
    if (!hasScope(scopes, required)) return;
    server.registerTool(name, configBlock, handler as never);
  }

  register(
    "list_models",
    {
      title: "List models",
      description:
        "List OfflineCreator Studio launch models with credit costs and workflows.",
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
        "Start a Studio generation. Text-to-image and text-to-video queue immediately. For image-to-video, call upload_input after reserve. Set wait:true to poll until completed/failed.",
      inputSchema: z.object({
        modelId: z
          .string()
          .describe("Model id from list_models, e.g. flux-schnell"),
        prompt: z.string().min(3).max(2000).describe("Creative prompt"),
        aspectRatio: z
          .enum(["16:9", "9:16", "1:1"])
          .optional()
          .describe("Frame ratio; defaults to 16:9"),
        wait: z
          .boolean()
          .optional()
          .describe("If true, poll until completed/failed (up to 120s)"),
      }),
      annotations: TOOL_ANNOTATIONS.generate,
    },
    async ({ modelId, prompt, aspectRatio, wait }) => {
      try {
        const started = await client.generate({ modelId, prompt, aspectRatio });
        if (!wait || started.uploadRequired) {
          return textResult(client.withAbsoluteOutput(started));
        }
        const generationId = String(started.generationId ?? "");
        if (!generationId) return textResult(started);
        return textResult(
          await client.waitGeneration({ generationId, timeoutSeconds: 120 }),
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
        "Upload a source image for a reserved image-to-video generation, then start processing. Local filePath must stay inside the upload root.",
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
    async ({
      generationId,
      filePath,
      imageBase64,
      contentType,
      aspectRatio,
      wait,
    }) => {
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
        return textResult(
          await client.waitGeneration({ generationId, timeoutSeconds: 180 }),
        );
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
    async ({ generationId }) => {
      try {
        return textResult(
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
    async ({ generationId, timeoutSeconds }) => {
      try {
        return textResult(
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
    async ({ generationId }) => {
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
        return textResult({
          generationId,
          outputUrl: status.outputUrl,
          outputUrlExpiresAt: status.outputUrlExpiresAt,
          outputUrlExpiresInSeconds: status.outputUrlExpiresInSeconds,
          outputContentType: status.outputContentType,
        });
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
        "Cancel a reserved generation before provider submit and refund credits.",
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
